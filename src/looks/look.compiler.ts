/**
 * Deterministic look compiler: `LookRecipe` → whitelisted YouCam effects.
 * Same recipe in, same effects out — no randomness, no model involved.
 *
 *   validate (constraints, kit, library)  →  map zones  →  whitelist gate  →  CompiledEffects
 *
 * Only `CompiledEffects` can be passed to `YoucamClient.startMakeup`, so nothing that skipped
 * this pipeline can spend units.
 */
import { getShade } from '../contracts/domain/shades.js';
import type { Finish, LookRecipe, ZoneIntensity, ZoneRecipe } from '../contracts/domain/types.js';
import type { BlushEffect, EyeShadowEffect, LipColorEffect, MakeupEffect } from '../youcam/youcam.types.js';
import { normalizeHex, shimmerTint } from './color.js';
import { checkRecipe, type LookContext, type LookProblem } from './look.validator.js';
import { BLUSH_PATTERN, EYE_PATTERN, whitelistedEffectsSchema } from './whitelist.js';

declare const compiled: unique symbol;
/** Effects that went through validation + the whitelist gate. */
export type CompiledEffects = readonly MakeupEffect[] & { readonly [compiled]: true };

export class LookRejectedError extends Error {
  constructor(readonly problems: LookProblem[]) {
    super(`Look rejected: ${problems.map((p) => p.kind).join(', ')}`);
    this.name = 'LookRejectedError';
  }
}

/** Zone intensity 1–5 → YouCam `colorIntensity` (to calibrate with real faces). */
export const COLOR_INTENSITY: Record<ZoneIntensity, number> = { 1: 25, 2: 40, 3: 55, 4: 70, 5: 85 };

/** Finish parameters per zone. Satin eyes are a low shimmer; satin cheeks a soft glow. */
export const FINISH_PARAMS = {
  eyes: { shimmerIntensity: 20, metallicShimmerIntensity: 45, metallicIntensity: 55 },
  cheeks: { satinGlow: 35, luminousGlow: 50, shimmerDensity: 35 },
  lips: { gloss: 60, transparencyIntensity: 25 },
} as const;

type EyePalette = EyeShadowEffect['palettes'][number];
type BlushPalette = BlushEffect['palettes'][number];
type LipPalette = LipColorEffect['palettes'][number];

function eyePalette(color: string, finish: Finish, colorIntensity: number): EyePalette {
  const p = FINISH_PARAMS.eyes;
  switch (finish) {
    case 'satin':
      return { color, texture: 'shimmer', colorIntensity, shimmerColor: shimmerTint(color), shimmerIntensity: p.shimmerIntensity };
    case 'metallic':
      return {
        color,
        texture: 'metallic',
        colorIntensity,
        shimmerColor: shimmerTint(color),
        shimmerIntensity: p.metallicShimmerIntensity,
        metallicIntensity: p.metallicIntensity,
      };
    default:
      return { color, texture: 'matte', colorIntensity };
  }
}

/**
 * One lid wash for every variant; expressiveness comes from intensity. Two-tone `2colors1` was
 * tested on a real face and stays at the lash line (weaker than the single wash), so it is out.
 */
function eyes(z: ZoneRecipe): EyeShadowEffect {
  const color = normalizeHex(getShade(z.shadeId).hex);
  return { category: 'eye_shadow', pattern: { name: EYE_PATTERN }, palettes: [eyePalette(color, z.finish, COLOR_INTENSITY[z.intensity])] };
}

function blushPalette(color: string, finish: Finish, colorIntensity: number): BlushPalette {
  const p = FINISH_PARAMS.cheeks;
  switch (finish) {
    case 'satin':
      return { color, texture: 'satin', colorIntensity, glowStrength: p.satinGlow };
    case 'luminous':
      return {
        color,
        texture: 'shimmer',
        colorIntensity,
        glowStrength: p.luminousGlow,
        shimmerColor: shimmerTint(color),
        shimmerDensity: p.shimmerDensity,
      };
    default:
      return { color, texture: 'matte', colorIntensity };
  }
}

function cheeks(z: ZoneRecipe): BlushEffect {
  const color = normalizeHex(getShade(z.shadeId).hex);
  return { category: 'blush', pattern: { name: BLUSH_PATTERN }, palettes: [blushPalette(color, z.finish, COLOR_INTENSITY[z.intensity])] };
}

function lipPalette(color: string, finish: Finish, colorIntensity: number): LipPalette {
  if (finish === 'gloss') return { color, texture: 'gloss', colorIntensity, ...FINISH_PARAMS.lips };
  return { color, texture: finish === 'satin' ? 'satin' : 'matte', colorIntensity };
}

function lips(z: ZoneRecipe): LipColorEffect {
  const color = normalizeHex(getShade(z.shadeId).hex);
  return {
    category: 'lip_color',
    shape: { name: 'original' },
    morphology: { fullness: 0, wrinkless: 0 },
    style: { type: 'full' },
    palettes: [lipPalette(color, z.finish, COLOR_INTENSITY[z.intensity])],
  };
}

/**
 * Validate and compile. Throws `LookRejectedError` with every problem found; the caller maps
 * it to a person-facing message and spends nothing.
 */
export function compileLook(raw: unknown, ctx: LookContext): { recipe: LookRecipe; effects: CompiledEffects } {
  const checked = checkRecipe(raw, ctx);
  if (!checked.ok) throw new LookRejectedError(checked.problems);
  const recipe = checked.value;

  const effects: MakeupEffect[] = [{ category: 'skin_smooth', skinSmoothStrength: 0, skinSmoothColorIntensity: 0 }];
  if (recipe.eyes.enabled) effects.push(eyes(recipe.eyes));
  if (recipe.cheeks.enabled) effects.push(cheeks(recipe.cheeks));
  if (recipe.lips.enabled) effects.push(lips(recipe.lips));

  const gate = whitelistedEffectsSchema.safeParse(effects);
  if (!gate.success) {
    // A compiler bug, not a person's mistake: still never sent.
    throw new LookRejectedError(
      gate.error.issues.map((i) => ({ kind: 'shape', target: 'recipe', path: `effects.${i.path.join('.')}`, message: i.message })),
    );
  }
  return { recipe, effects: effects as unknown as CompiledEffects };
}
