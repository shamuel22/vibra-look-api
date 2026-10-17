/**
 * Render orchestration on one session (brief §7):
 *  - always from the ORIGINAL selfie (uploaded once with the first task), never from a result;
 *  - validated and compiled before anything is spent (`compileLook`);
 *  - one task per recipe id while it is pending, processing or done (cache key = selfie + recipe);
 *  - per-session and daily caps; bounded polling; failures normalized per variant.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiError } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import type { RenderErrorCode } from '../contracts/domain/types.js';
import { compileLook, LookRejectedError } from '../looks/look.compiler.js';
import { checkContext } from '../looks/look.validator.js';
import { YoucamClient } from '../youcam/youcam.client.js';
import { YoucamError, type YoucamFailure } from '../youcam/youcam.types.js';
import type { RenderEntry, Session } from './session.store.js';

const POLL_MS = 1_500;
const RENDER_TIMEOUT_MS = 90_000;

/** Provider failure → what the app can tell the person. */
export function toRenderError(f: YoucamFailure): { code: RenderErrorCode; retriable: boolean } {
  switch (f.kind) {
    case 'face':
    case 'image':
      return { code: 'noFace', retriable: false };
    case 'network':
      return { code: 'network', retriable: true };
    case 'expired':
      return { code: 'timeout', retriable: true };
    case 'provider':
      return { code: 'provider', retriable: true };
    default:
      // auth, credit, invalid, content: nothing the person can fix by retrying now.
      return { code: 'provider', retriable: false };
  }
}

@Injectable()
export class RenderService {
  private readonly log = new Logger(RenderService.name);
  private readonly maxPerSession: number;
  private readonly dailyLimit: number;
  private day = '';
  private startedToday = 0;

  constructor(
    config: ConfigService<Env, true>,
    private readonly youcam: YoucamClient,
  ) {
    this.maxPerSession = config.get('MAX_RENDERS_PER_SESSION', { infer: true });
    this.dailyLimit = config.get('DAILY_RENDER_LIMIT', { infer: true });
  }

  /** Validates and starts (or reuses) the render of a recipe. Never waits for the provider. */
  start(session: Session, body: { recipe?: unknown; constraints?: unknown; kit?: unknown }): RenderEntry {
    const ctx = checkContext({ constraints: body.constraints, kit: body.kit });
    if (!ctx.ok) throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'look_rejected', 'Invalid constraints or kit', false, ctx.problems);
    let compiled;
    try {
      compiled = compileLook(body.recipe, ctx.value);
    } catch (e) {
      if (e instanceof LookRejectedError) {
        throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'look_rejected', 'The look breaks a rule; nothing was rendered', false, e.problems);
      }
      throw e;
    }
    if (!session.fileId && !session.selfie) throw new ApiError(HttpStatus.CONFLICT, 'selfie_required', 'Upload the selfie first', false);

    const id = compiled.recipe.id;
    const existing = session.renders.get(id);
    if (existing && existing.status !== 'error') return existing;

    if (session.tasksStarted >= this.maxPerSession) {
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'limit', 'Render limit reached for this session', false);
    }
    if (!this.takeDailySlot()) {
      this.log.warn('daily render limit reached');
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'limit', 'Daily render limit reached', false);
    }

    const entry: RenderEntry = { recipeId: id, status: 'pending' };
    session.renders.set(id, entry);
    session.tasksStarted += 1;
    const run = this.run(session, entry, compiled.effects);
    session.inflight.add(run);
    void run.finally(() => session.inflight.delete(run));
    return entry;
  }

  status(session: Session, recipeId: string): RenderEntry {
    const entry = session.renders.get(recipeId);
    if (!entry) throw new ApiError(HttpStatus.NOT_FOUND, 'not_found', 'Unknown render', false);
    return entry;
  }

  /** Streams the finished image from the provider; the URL never reaches the app. */
  async image(session: Session, recipeId: string): Promise<Uint8Array> {
    const entry = this.status(session, recipeId);
    if (entry.status !== 'success' || !entry.resultUrl) throw new ApiError(HttpStatus.CONFLICT, 'not_ready', 'Render not finished', true);
    try {
      return (await this.youcam.download(entry.resultUrl)).bytes;
    } catch (e) {
      const retriable = e instanceof YoucamError ? e.failure.retriable : true;
      throw new ApiError(HttpStatus.BAD_GATEWAY, 'upstream', 'Could not fetch the result', retriable);
    }
  }

  private takeDailySlot(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.startedToday = 0;
    }
    if (this.startedToday >= this.dailyLimit) return false;
    this.startedToday += 1;
    return true;
  }

  /** One private upload per session, shared by concurrent renders; retried if it failed. */
  private uploaded(session: Session): Promise<string> {
    if (session.fileId) return Promise.resolve(session.fileId);
    const selfie = session.selfie;
    if (!selfie) return Promise.reject(new YoucamError({ kind: 'image', retriable: false }, 'No selfie'));
    session.upload ??= this.youcam
      .uploadImage(selfie.bytes, selfie.contentType)
      .then(({ fileId }) => {
        session.fileId = fileId;
        session.selfie = undefined;
        return fileId;
      })
      .finally(() => {
        session.upload = undefined;
      });
    return session.upload;
  }

  private async run(session: Session, entry: RenderEntry, effects: Parameters<YoucamClient['startMakeup']>[1]): Promise<void> {
    const fail = (error: RenderEntry['error']) => {
      entry.status = 'error';
      entry.error = error;
    };
    try {
      if (session.closed) return fail({ code: 'timeout', retriable: false });
      const fileId = await this.uploaded(session);
      if (session.closed) return fail({ code: 'timeout', retriable: false });
      const taskId = await this.youcam.startMakeup(fileId, effects);
      entry.taskId = taskId;
      session.taskIds.add(taskId);
      entry.status = 'processing';

      const deadline = Date.now() + RENDER_TIMEOUT_MS;
      while (Date.now() < deadline && !session.closed) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        let state;
        try {
          state = await this.youcam.getMakeup(taskId);
        } catch (e) {
          // Transient poll failures are retried until the deadline.
          if (e instanceof YoucamError && e.failure.retriable) continue;
          throw e;
        }
        if (state.status === 'running') continue;
        if (state.status === 'success') {
          entry.resultUrl = state.resultUrl;
          entry.status = 'success';
          return;
        }
        this.log.warn(`render failed: ${state.error.kind}${state.error.code ? ` (${state.error.code})` : ''}`);
        return fail(toRenderError(state.error));
      }
      fail({ code: 'timeout', retriable: true });
    } catch (e) {
      if (e instanceof YoucamError) {
        if (e.failure.kind === 'credit' || e.failure.kind === 'auth') this.log.error(`YouCam ${e.failure.kind} failure: check the account`);
        else this.log.warn(`render error: ${e.failure.kind}`);
        return fail(toRenderError(e.failure));
      }
      this.log.error(`render crashed: ${(e as Error).message}`);
      fail({ code: 'provider', retriable: true });
    }
  }
}
