/**
 * Thin, typed client for the YouCam v2.0 endpoints VIBRA LOOK needs:
 * private upload → task → status → download → delete, plus unit balance.
 *
 * - The API key never leaves the server and is never logged.
 * - Every call has a timeout; failures surface as `YoucamError` with a normalized kind.
 * - Result URLs are only used server-side to download the image (they expire in 2 h).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.js';
import type { CompiledEffects } from '../looks/look.compiler.js';
import { classifyEngineError, classifyHttpError } from './youcam.errors.js';
import { YoucamError, type TaskState } from './youcam.types.js';

const CALL_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 30_000;

export interface UploadedFile {
  fileId: string;
}

@Injectable()
export class YoucamClient {
  private readonly log = new Logger(YoucamClient.name);
  private readonly base: string;
  private readonly key: string;

  constructor(config: ConfigService<Env, true>) {
    this.base = config.get('YOUCAM_BASE_URL', { infer: true });
    this.key = config.get('YOUCAM_API_KEY', { infer: true });
  }

  /** Upload image bytes privately (presigned PUT); returns the reusable `file_id`. */
  async uploadImage(bytes: Uint8Array, contentType: 'image/jpeg' | 'image/png'): Promise<UploadedFile> {
    const body = await this.call<{
      data: { files: { file_id: string; requests: { url: string; method?: string; headers?: Record<string, string> }[] }[] };
    }>('POST', '/s2s/v2.0/file', {
      files: [{ content_type: contentType, file_name: contentType === 'image/png' ? 'selfie.png' : 'selfie.jpg', file_size: bytes.byteLength }],
    });
    const file = body.data.files[0];
    const upload = file?.requests?.[0];
    if (!file?.file_id || !upload?.url) throw new YoucamError({ kind: 'provider', retriable: true }, 'Upload slot missing');

    const res = await this.fetchWithTimeout(
      upload.url,
      { method: upload.method ?? 'PUT', headers: upload.headers, body: Buffer.from(bytes) },
      UPLOAD_TIMEOUT_MS,
    );
    if (!res.ok) throw new YoucamError(classifyHttpError(res.status), `Upload failed (${res.status})`);
    return { fileId: file.file_id };
  }

  /**
   * Start a makeup task on an uploaded file. Consumes 1 unit only if it succeeds.
   * Takes only compiler output (`compileLook`), never hand-built effects.
   */
  async startMakeup(fileId: string, effects: CompiledEffects): Promise<string> {
    const body = await this.call<{ data: { task_id: string } }>('POST', '/s2s/v2.0/task/makeup-vto', {
      src_file_id: fileId,
      version: '1.0',
      effects,
    });
    return body.data.task_id;
  }

  async getMakeup(taskId: string): Promise<TaskState> {
    const body = await this.call<{
      data: { task_status: 'running' | 'success' | 'error'; error?: string | null; results?: { url?: string } };
    }>('GET', `/s2s/v2.0/task/makeup-vto/${encodeURIComponent(taskId)}`);
    const d = body.data;
    if (d.task_status === 'success') {
      const url = d.results?.url;
      if (!url) return { status: 'error', error: { kind: 'provider', code: 'missing_result', retriable: true } };
      return { status: 'success', resultUrl: url };
    }
    if (d.task_status === 'error') return { status: 'error', error: classifyEngineError(d.error) };
    return { status: 'running' };
  }

  /** Download a finished result (server-side only). */
  async download(resultUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.fetchWithTimeout(resultUrl, { method: 'GET' }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) throw new YoucamError(classifyHttpError(res.status), `Download failed (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The CDN answers `binary/octet-stream`; results are JPEG.
    return { bytes, contentType: 'image/jpeg' };
  }

  /** Delete a task and its input files. Only at session end: it also removes the shared upload. */
  async deleteTask(taskId: string): Promise<void> {
    await this.call('POST', '/s2s/v2.0/task/delete', { task_id: taskId });
  }

  /** Remaining units (all token buckets). */
  async unitBalance(): Promise<number> {
    const body = await this.call<{ results: { amount_dec: number }[] }>('GET', '/s2s/v1.0/client/credit');
    return body.results.reduce((sum, r) => sum + r.amount_dec, 0);
  }

  // ─── transport ────────────────────────────────────────────────────────────

  private async call<T>(method: 'GET' | 'POST', path: string, json?: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(
      `${this.base}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : undefined,
      },
      CALL_TIMEOUT_MS,
    );
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const code = (body as { error_code?: string } | undefined)?.error_code;
      const failure = classifyHttpError(res.status, code);
      this.log.warn(`YouCam ${method} ${path.split('/').slice(0, 5).join('/')} → ${res.status} ${code ?? ''}`);
      throw new YoucamError(failure, `YouCam ${res.status} ${code ?? ''}`.trim());
    }
    return body as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new YoucamError({ kind: 'network', retriable: true }, `Network error: ${(e as Error).name}`);
    }
  }
}
