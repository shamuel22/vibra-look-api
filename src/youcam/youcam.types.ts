/**
 * YouCam (Perfect Corp) AI Makeup Virtual Try-On v2.0 — the subset VIBRA LOOK uses.
 * Shapes verified against the official OpenAPI bundle and real calls (spike, 17-oct-2026).
 */

export type EyeShadowTexture = 'matte' | 'shimmer' | 'metallic';
export type BlushTexture = 'matte' | 'satin' | 'shimmer';
export type LipTexture = 'matte' | 'satin' | 'gloss';

export interface SkinSmoothEffect {
  category: 'skin_smooth';
  skinSmoothStrength: number;
  skinSmoothColorIntensity: number;
}

export interface EyeShadowEffect {
  category: 'eye_shadow';
  pattern: { name: string };
  palettes: {
    color: string;
    texture: EyeShadowTexture;
    colorIntensity: number;
    shimmerColor?: string;
    shimmerIntensity?: number;
    metallicIntensity?: number;
  }[];
}

export interface BlushEffect {
  category: 'blush';
  pattern: { name: string };
  palettes: {
    color: string;
    texture: BlushTexture;
    colorIntensity: number;
    glowStrength?: number;
    shimmerColor?: string;
    shimmerDensity?: number;
  }[];
}

export interface LipColorEffect {
  category: 'lip_color';
  shape: { name: 'original' };
  morphology: { fullness: 0; wrinkless: 0 };
  style: { type: 'full' };
  palettes: {
    color: string;
    texture: LipTexture;
    colorIntensity: number;
    gloss?: number;
    transparencyIntensity?: number;
  }[];
}

export type MakeupEffect = SkinSmoothEffect | EyeShadowEffect | BlushEffect | LipColorEffect;

export type TaskState =
  | { status: 'running' }
  | { status: 'success'; resultUrl: string }
  | { status: 'error'; error: YoucamFailure };

/** Normalized failure kinds the rest of the API (and the app) reason about. */
export type YoucamFailureKind =
  | 'auth' // bad/missing API key — operator problem
  | 'credit' // no units left — operator problem
  | 'face' // face missing, too small, out of frame or angled — person can retake
  | 'image' // format/size/decoding — person can pick another photo
  | 'content' // NSFW detection
  | 'invalid' // our request was invalid — a bug, never retried blindly
  | 'provider' // provider-side failure — retriable
  | 'expired' // task or result no longer available
  | 'network'; // transport failure or timeout — retriable

export interface YoucamFailure {
  kind: YoucamFailureKind;
  /** Provider code (e.g. `error_face_position_too_small`) when there is one. */
  code?: string;
  retriable: boolean;
}

export class YoucamError extends Error {
  constructor(
    readonly failure: YoucamFailure,
    message: string,
  ) {
    super(message);
    this.name = 'YoucamError';
  }
}
