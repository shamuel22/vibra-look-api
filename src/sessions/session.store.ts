/**
 * In-memory sessions (no database): a session lives minutes and holds ids, provider result URLs
 * and — only until its first render — the selfie bytes. The selfie reaches YouCam together with
 * the first task, so every upload is referenced by a task and deleting the tasks (when the app
 * ends the session, when it expires, or at shutdown) also deletes the uploaded photo.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { HttpStatus, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiError } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import type { RenderErrorCode } from '../contracts/domain/types.js';
import { YoucamClient } from '../youcam/youcam.client.js';

/** Result URLs are valid 2 h after the task; sessions never outlive that. */
const HARD_MAX_MS = 100 * 60_000;
const SWEEP_MS = 60_000;
/** How long closing waits for task creations already in flight (so their tasks get deleted). */
const CLOSE_WAIT_MS = 15_000;
const DELETE_ATTEMPTS = 5;

export type RenderState = 'pending' | 'processing' | 'success' | 'error';

export interface RenderEntry {
  recipeId: string;
  status: RenderState;
  taskId?: string;
  /** Provider URL, used server-side only to stream the image. */
  resultUrl?: string;
  error?: { code: RenderErrorCode; retriable: boolean };
}

export interface Session {
  id: string;
  tokenHash: Buffer;
  createdAt: number;
  lastSeen: number;
  /** Validated selfie, kept until it is uploaded with the first render. */
  selfie?: { bytes: Uint8Array; contentType: 'image/jpeg' | 'image/png' };
  /** YouCam file id once uploaded (shared by every task of the session). */
  fileId?: string;
  upload?: Promise<string>;
  renders: Map<string, RenderEntry>;
  /** YouCam tasks started (each may cost 1 unit). */
  tasksStarted: number;
  taskIds: Set<string>;
  /** Render runs in progress; closing waits for their task creation. */
  inflight: Set<Promise<void>>;
  /** Model-backed requests made for this session. */
  translations: number;
  describes: number;
  closed: boolean;
}

const hash = (token: string) => createHash('sha256').update(token).digest();

@Injectable()
export class SessionStore implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SessionStore.name);
  private readonly sessions = new Map<string, Session>();
  /** Task deletions that failed; retried by the sweeper. */
  private readonly pendingDeletes = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private timer?: NodeJS.Timeout;

  constructor(
    config: ConfigService<Env, true>,
    private readonly youcam: YoucamClient,
  ) {
    this.ttlMs = config.get('SESSION_TTL_MINUTES', { infer: true }) * 60_000;
    this.maxSessions = config.get('MAX_SESSIONS', { infer: true });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map((s) => this.close(s)));
  }

  get size(): number {
    return this.sessions.size;
  }

  create(): { session: Session; token: string; expiresAt: string } {
    if (this.sessions.size >= this.maxSessions) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'busy', 'Too many active sessions, try again shortly', true);
    }
    const id = randomBytes(12).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: Session = {
      id,
      tokenHash: hash(token),
      createdAt: now,
      lastSeen: now,
      renders: new Map(),
      tasksStarted: 0,
      taskIds: new Set(),
      inflight: new Set(),
      translations: 0,
      describes: 0,
      closed: false,
    };
    this.sessions.set(id, session);
    return { session, token, expiresAt: this.expiresAt(session) };
  }

  /** Authenticated lookup; unknown, expired and wrong-token sessions all look the same (404). */
  get(id: string, token: string | undefined): Session {
    const s = this.sessions.get(id);
    if (!s || !token || s.closed || this.expired(s, Date.now()) || !timingSafeEqual(s.tokenHash, hash(token))) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'not_found', 'Session not found or expired', false);
    }
    s.lastSeen = Date.now();
    return s;
  }

  expiresAt(s: Session): string {
    return new Date(Math.min(s.lastSeen + this.ttlMs, s.createdAt + HARD_MAX_MS)).toISOString();
  }

  async close(s: Session): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    s.selfie = undefined;
    this.sessions.delete(s.id);
    // Renders stop polling once closed; wait for task creations so no task is left behind.
    if (s.inflight.size) {
      await Promise.race([Promise.allSettled(s.inflight), new Promise((r) => setTimeout(r, CLOSE_WAIT_MS).unref())]);
    }
    // Deleting a task also deletes its input file (the shared selfie upload).
    await this.deleteTasks([...s.taskIds]);
  }

  private async deleteTasks(ids: string[]): Promise<void> {
    const results = await Promise.allSettled(ids.map((t) => this.youcam.deleteTask(t)));
    results.forEach((r, i) => {
      const id = ids[i];
      if (r.status === 'fulfilled') {
        this.pendingDeletes.delete(id);
        return;
      }
      const attempts = (this.pendingDeletes.get(id) ?? 0) + 1;
      if (attempts >= DELETE_ATTEMPTS) {
        this.pendingDeletes.delete(id);
        this.log.error(`gave up deleting a YouCam task after ${attempts} attempts`);
      } else {
        this.pendingDeletes.set(id, attempts);
      }
    });
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) this.log.warn(`${failed}/${results.length} task deletion(s) failed; will retry`);
  }

  private expired(s: Session, now: number): boolean {
    return now - s.lastSeen > this.ttlMs || now - s.createdAt > HARD_MAX_MS;
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const stale = [...this.sessions.values()].filter((s) => this.expired(s, now));
    if (stale.length) this.log.log(`expiring ${stale.length} session(s)`);
    await Promise.all(stale.map((s) => this.close(s)));
    if (this.pendingDeletes.size) await this.deleteTasks([...this.pendingDeletes.keys()]);
  }
}
