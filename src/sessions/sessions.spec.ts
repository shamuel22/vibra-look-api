import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../common/api-error.js';
import { EMPTY_KIT, SAMPLE_LOOKS } from '../looks/look.fixtures.js';
import type { YoucamClient } from '../youcam/youcam.client.js';
import { YoucamError } from '../youcam/youcam.types.js';
import { RenderService, toRenderError } from './render.service.js';
import { checkSelfie } from './selfie.js';
import { SessionStore } from './session.store.js';

function config(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { SESSION_TTL_MINUTES: 30, MAX_SESSIONS: 3, MAX_RENDERS_PER_SESSION: 4, DAILY_RENDER_LIMIT: 100, ...over };
  return { get: (k: string) => values[k] } as unknown as ConfigService<never, true>;
}

function fakeYoucam(states: ('running' | 'success' | 'face')[] = ['running', 'success']) {
  let n = 0;
  return {
    uploadImage: vi.fn(async () => ({ fileId: 'F_UP' })),
    startMakeup: vi.fn(async () => `T${++n}`),
    getMakeup: vi.fn(async () => {
      const s = states.length > 1 ? states.shift()! : states[0];
      if (s === 'success') return { status: 'success', resultUrl: 'https://r.test/x' };
      if (s === 'face') return { status: 'error', error: { kind: 'face', code: 'error_face_position_too_small', retriable: false } };
      return { status: 'running' };
    }),
    download: vi.fn(async () => ({ bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg' })),
    deleteTask: vi.fn(async () => undefined),
  };
}

function setup(yc = fakeYoucam(), over: Record<string, unknown> = {}) {
  const store = new SessionStore(config(over), yc as unknown as YoucamClient);
  const renders = new RenderService(config(over), yc as unknown as YoucamClient);
  const { session, token } = store.create();
  session.fileId = 'F1';
  return { store, renders, session, token, yc };
}

const body = (i = 0, constraints: string[] = []) => ({ recipe: SAMPLE_LOOKS[i], constraints, kit: EMPTY_KIT });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return ((e as ApiError).getResponse() as { error: { code: string } }).error.code;
  }
  return null;
};

afterEach(() => vi.useRealTimers());

describe('SessionStore', () => {
  it('authenticates with the token and hides unknown, wrong and closed sessions alike', async () => {
    const { store, session, token, yc } = setup();
    expect(store.get(session.id, token)).toBe(session);
    expect(code(() => store.get(session.id, 'wrong'))).toBe('not_found');
    expect(code(() => store.get('nope', token))).toBe('not_found');
    session.taskIds.add('T9');
    await store.close(session);
    expect(yc.deleteTask).toHaveBeenCalledWith('T9');
    expect(code(() => store.get(session.id, token))).toBe('not_found');
  });

  it('caps concurrent sessions', () => {
    const { store } = setup();
    store.create();
    store.create();
    expect(code(() => store.create())).toBe('busy');
  });
});

describe('RenderService', () => {
  it('starts once per recipe, polls to success and streams the image', async () => {
    vi.useFakeTimers();
    const { renders, session, yc } = setup();
    const first = renders.start(session, body());
    expect(first.status).toBe('pending');
    expect(renders.start(session, body())).toBe(first); // cache: no second task
    await vi.advanceTimersByTimeAsync(4_000);
    expect(renders.status(session, first.recipeId)).toMatchObject({ status: 'success' });
    expect(yc.startMakeup).toHaveBeenCalledTimes(1);
    expect(session.taskIds.has('T1')).toBe(true);
    expect(await renders.image(session, first.recipeId)).toEqual(new Uint8Array([1, 2]));
  });

  it('rejects a look that breaks a constraint without calling the provider', () => {
    const { renders, session, yc } = setup();
    expect(code(() => renders.start(session, body(1, ['noShadow'])))).toBe('look_rejected');
    expect(code(() => renders.start(session, { recipe: { ...SAMPLE_LOOKS[0], id: 'r0' }, constraints: [], kit: EMPTY_KIT }))).toBe('look_rejected');
    expect(yc.startMakeup).not.toHaveBeenCalled();
  });

  it('requires the selfie and enforces the per-session cap', () => {
    const { renders, session } = setup(fakeYoucam(), { MAX_RENDERS_PER_SESSION: 2 });
    session.fileId = undefined;
    expect(code(() => renders.start(session, body()))).toBe('selfie_required');
    session.fileId = 'F1';
    renders.start(session, body(0));
    renders.start(session, body(1));
    expect(code(() => renders.start(session, body(2)))).toBe('limit');
  });

  it('enforces the daily cap across sessions', () => {
    const yc = fakeYoucam();
    const a = setup(yc, { DAILY_RENDER_LIMIT: 1 });
    a.renders.start(a.session, body(0));
    expect(code(() => a.renders.start(a.session, body(1)))).toBe('limit');
  });

  it('maps a face error to noFace and lets a failed render be retried', async () => {
    vi.useFakeTimers();
    const { renders, session, yc } = setup(fakeYoucam(['face', 'face']));
    const entry = renders.start(session, body());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(renders.status(session, entry.recipeId)).toMatchObject({ status: 'error', error: { code: 'noFace', retriable: false } });
    renders.start(session, body());
    await vi.advanceTimersByTimeAsync(0);
    expect(yc.startMakeup).toHaveBeenCalledTimes(2);
  });

  it('uploads the selfie once, with the first renders, and deletes every task on close', async () => {
    vi.useFakeTimers();
    const { store, renders, session, yc } = setup();
    session.fileId = undefined;
    session.selfie = { bytes: new Uint8Array([1]), contentType: 'image/jpeg' };
    renders.start(session, body(0));
    renders.start(session, body(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(yc.uploadImage).toHaveBeenCalledTimes(1);
    expect(yc.startMakeup.mock.calls.map((c: unknown[]) => c[0])).toEqual(['F_UP', 'F_UP']);
    expect(session.selfie).toBeUndefined();
    const closing = store.close(session);
    await vi.advanceTimersByTimeAsync(2_000); // polling notices the close
    await closing;
    expect(yc.deleteTask.mock.calls.map((c: unknown[]) => String(c[0])).sort((a, b) => a.localeCompare(b))).toEqual(['T1', 'T2']);
  });

  it('waits for a task being created when the session closes, then deletes it', async () => {
    let release!: (id: string) => void;
    const yc = fakeYoucam();
    yc.startMakeup = vi.fn(() => new Promise<string>((r) => (release = r)));
    const { store, renders, session } = setup(yc);
    renders.start(session, body(0));
    await Promise.resolve();
    const closing = store.close(session);
    release('T_LATE');
    await closing;
    expect(yc.deleteTask).toHaveBeenCalledWith('T_LATE');
  });

  it('turns provider failures into render errors', () => {
    expect(toRenderError({ kind: 'network', retriable: true })).toEqual({ code: 'network', retriable: true });
    expect(toRenderError({ kind: 'credit', retriable: false })).toEqual({ code: 'provider', retriable: false });
    expect(toRenderError({ kind: 'expired', retriable: true }).code).toBe('timeout');
    expect(new YoucamError({ kind: 'face', retriable: false }, 'x').failure.kind).toBe('face');
  });
});

describe('checkSelfie', () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return new Uint8Array(b);
  };

  it('accepts JPEG/PNG within limits and names the problem otherwise', () => {
    expect(checkSelfie(png(853, 1280))).toMatchObject({ ok: true, contentType: 'image/png' });
    expect(checkSelfie(png(300, 400))).toEqual({ ok: false, issue: 'tooSmall' });
    expect(checkSelfie(png(1080, 2400))).toEqual({ ok: false, issue: 'unsupported' });
    expect(checkSelfie(new Uint8Array([1, 2, 3]))).toEqual({ ok: false, issue: 'unsupported' });
    expect(checkSelfie(new Uint8Array())).toEqual({ ok: false, issue: 'unsupported' });
  });
});
