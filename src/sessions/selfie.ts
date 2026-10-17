/**
 * Server-side selfie checks before the private upload to YouCam: the format is read from the
 * bytes (not the declared type) and the dimensions must fit the provider's limits. Face detection happens in the provider
 * on the first render (`noFace`).
 */
import { imageSize } from 'image-size';

import type { SelfieIssue } from '../contracts/domain/types.js';

export const SELFIE_MAX_BYTES = 8 * 1024 * 1024;
/** YouCam: long side < 1920 px; a face needs room to be ≥ 100 px. */
const MAX_SIDE = 1919;
const MIN_SIDE = 400;

export type SelfieCheck = { ok: true; contentType: 'image/jpeg' | 'image/png'; width: number; height: number } | { ok: false; issue: SelfieIssue };

export function checkSelfie(bytes: Uint8Array): SelfieCheck {
  if (bytes.byteLength === 0 || bytes.byteLength > SELFIE_MAX_BYTES) return { ok: false, issue: 'unsupported' };
  let size;
  try {
    size = imageSize(bytes);
  } catch {
    return { ok: false, issue: 'unsupported' };
  }
  const contentType = size.type === 'jpg' ? 'image/jpeg' : size.type === 'png' ? 'image/png' : null;
  if (!contentType || !size.width || !size.height) return { ok: false, issue: 'unsupported' };
  if (Math.max(size.width, size.height) > MAX_SIDE) return { ok: false, issue: 'unsupported' };
  if (Math.min(size.width, size.height) < MIN_SIDE) return { ok: false, issue: 'tooSmall' };
  return { ok: true, contentType, width: size.width, height: size.height };
}
