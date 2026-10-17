/** Maps YouCam HTTP and engine errors to the normalized `YoucamFailure`. Pure, unit-tested. */
import type { YoucamFailure } from './youcam.types.js';

const IMAGE_CODES = new Set([
  'exceed_max_filesize',
  'error_download_image',
  'error_decode_image',
  'error_below_min_image_size',
  'error_exceed_max_image_size',
]);

/** Engine error from a finished task (`data.error`). */
export function classifyEngineError(code: string | null | undefined): YoucamFailure {
  if (!code) return { kind: 'provider', retriable: true };
  if (code.startsWith('error_face_')) return { kind: 'face', code, retriable: false };
  if (IMAGE_CODES.has(code)) return { kind: 'image', code, retriable: false };
  if (code === 'error_nsfw_content_detected') return { kind: 'content', code, retriable: false };
  if (code === 'invalid_parameter') return { kind: 'invalid', code, retriable: false };
  // error_inference, unknown_internal_error and anything new.
  return { kind: 'provider', code, retriable: true };
}

/** Non-2xx HTTP response (`error_code` in the body when present). */
export function classifyHttpError(status: number, errorCode?: string): YoucamFailure {
  if (status === 401) return { kind: 'auth', code: errorCode, retriable: false };
  if (errorCode === 'CreditInsufficiency') return { kind: 'credit', code: errorCode, retriable: false };
  if (errorCode === 'InvalidTaskId' || errorCode === 'TaskTimeout')
    return { kind: 'expired', code: errorCode, retriable: false };
  if (status === 429) return { kind: 'provider', code: errorCode ?? 'rate_limited', retriable: true };
  if (status >= 500) return { kind: 'provider', code: errorCode, retriable: true };
  return { kind: 'invalid', code: errorCode, retriable: false };
}
