import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { YoucamClient } from './youcam.client.js';
import { classifyEngineError, classifyHttpError } from './youcam.errors.js';
import { YoucamError } from './youcam.types.js';

const KEY = 'test-key-that-is-long-enough-123';

function client() {
  const values: Record<string, unknown> = { YOUCAM_BASE_URL: 'https://yc.test', YOUCAM_API_KEY: KEY };
  return new YoucamClient({ get: (k: string) => values[k] } as unknown as ConfigService<never, true>);
}

function respond(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

afterEach(() => vi.unstubAllGlobals());

describe('error classification', () => {
  it('maps engine errors to person-actionable kinds', () => {
    expect(classifyEngineError('error_face_position_too_small')).toMatchObject({ kind: 'face', retriable: false });
    expect(classifyEngineError('error_face_angle_invalid').kind).toBe('face');
    expect(classifyEngineError('exceed_max_filesize').kind).toBe('image');
    expect(classifyEngineError('error_nsfw_content_detected').kind).toBe('content');
    expect(classifyEngineError('invalid_parameter')).toMatchObject({ kind: 'invalid', retriable: false });
    expect(classifyEngineError('error_inference')).toMatchObject({ kind: 'provider', retriable: true });
    expect(classifyEngineError(null)).toMatchObject({ kind: 'provider', retriable: true });
  });

  it('maps HTTP errors', () => {
    expect(classifyHttpError(401, 'InvalidApiKey').kind).toBe('auth');
    expect(classifyHttpError(400, 'CreditInsufficiency').kind).toBe('credit');
    expect(classifyHttpError(400, 'InvalidTaskId').kind).toBe('expired');
    expect(classifyHttpError(500, 'TaskTimeout').kind).toBe('expired');
    expect(classifyHttpError(503)).toMatchObject({ kind: 'provider', retriable: true });
    expect(classifyHttpError(400, 'InvalidParameters')).toMatchObject({ kind: 'invalid', retriable: false });
  });
});

describe('YoucamClient', () => {
  it('uploads privately: creates a slot, PUTs bytes with the given headers, returns file_id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        respond(200, {
          status: 200,
          data: { files: [{ file_id: 'F1', requests: [{ url: 'https://s3.test/put', method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } }] }] },
        }),
      )
      .mockResolvedValueOnce(respond(200, ''));
    vi.stubGlobal('fetch', fetchMock);

    const out = await client().uploadImage(new Uint8Array([1, 2, 3]), 'image/jpeg');

    expect(out).toEqual({ fileId: 'F1' });
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('https://yc.test/s2s/v2.0/file');
    expect(createInit.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(createInit.body).files[0]).toMatchObject({ content_type: 'image/jpeg', file_size: 3 });
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toBe('https://s3.test/put');
    expect(putInit.method).toBe('PUT');
    // The presigned upload must not carry our API key.
    expect(putInit.headers.Authorization).toBeUndefined();
  });

  it('starts a task with src_file_id and version 1.0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { status: 200, data: { task_id: 'T1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const id = await client().startMakeup('F1', [{ category: 'skin_smooth', skinSmoothStrength: 0, skinSmoothColorIntensity: 0 }]);
    expect(id).toBe('T1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ src_file_id: 'F1', version: '1.0' });
  });

  it('normalizes task states (results is an object with url)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { status: 200, data: { task_status: 'running' } }))
      .mockResolvedValueOnce(respond(200, { status: 200, data: { task_status: 'success', error: null, results: { url: 'https://r.test/x' } } }))
      .mockResolvedValueOnce(respond(200, { status: 200, data: { task_status: 'error', error: 'error_face_position_out_of_boundary' } }));
    vi.stubGlobal('fetch', fetchMock);
    const c = client();
    expect(await c.getMakeup('T')).toEqual({ status: 'running' });
    expect(await c.getMakeup('T')).toEqual({ status: 'success', resultUrl: 'https://r.test/x' });
    expect(await c.getMakeup('T')).toMatchObject({ status: 'error', error: { kind: 'face' } });
  });

  it('throws a typed error for HTTP failures without leaking the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, { status: 401, error_code: 'InvalidApiKey' })));
    const err = await client().getMakeup('T').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YoucamError);
    expect((err as YoucamError).failure.kind).toBe('auth');
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it('turns transport failures into retriable network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const err = (await client().unitBalance().catch((e: unknown) => e)) as YoucamError;
    expect(err.failure).toMatchObject({ kind: 'network', retriable: true });
  });
});
