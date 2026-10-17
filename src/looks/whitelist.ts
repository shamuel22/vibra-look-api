/**
 * Final gate before YouCam: the exact effect shapes VIBRA LOOK is allowed to send.
 * Anything outside this list (other categories, patterns, lip shapes, morphology, smoothing,
 * foundation, contour…) is rejected even if a compiler bug produced it. Extend only after
 * testing on real faces (PLAN §4.1).
 */
import { z } from 'zod';

const hex = z.string().regex(/^#[0-9A-F]{6}$/);
const pct = z.number().int().min(0).max(100);

export const EYE_PATTERN = '1color1';
export const BLUSH_PATTERN = '1color1';

const skinSmooth = z.strictObject({
  category: z.literal('skin_smooth'),
  skinSmoothStrength: z.literal(0),
  skinSmoothColorIntensity: z.literal(0),
});

const eyePalette = z.discriminatedUnion('texture', [
  z.strictObject({ texture: z.literal('matte'), color: hex, colorIntensity: pct }),
  z.strictObject({ texture: z.literal('shimmer'), color: hex, colorIntensity: pct, shimmerColor: hex, shimmerIntensity: pct }),
  z.strictObject({
    texture: z.literal('metallic'),
    color: hex,
    colorIntensity: pct,
    shimmerColor: hex,
    shimmerIntensity: pct,
    metallicIntensity: pct,
  }),
]);

const eyeShadow = z.strictObject({
  category: z.literal('eye_shadow'),
  pattern: z.strictObject({ name: z.literal(EYE_PATTERN) }),
  palettes: z.array(eyePalette).length(1),
});

const blushPalette = z.discriminatedUnion('texture', [
  z.strictObject({ texture: z.literal('matte'), color: hex, colorIntensity: pct }),
  z.strictObject({ texture: z.literal('satin'), color: hex, colorIntensity: pct, glowStrength: pct }),
  z.strictObject({
    texture: z.literal('shimmer'),
    color: hex,
    colorIntensity: pct,
    glowStrength: pct,
    shimmerColor: hex,
    shimmerDensity: pct,
  }),
]);

const blush = z.strictObject({
  category: z.literal('blush'),
  pattern: z.strictObject({ name: z.literal(BLUSH_PATTERN) }),
  palettes: z.array(blushPalette).length(1),
});

const lipPalette = z.discriminatedUnion('texture', [
  z.strictObject({ texture: z.literal('matte'), color: hex, colorIntensity: pct }),
  z.strictObject({ texture: z.literal('satin'), color: hex, colorIntensity: pct }),
  z.strictObject({ texture: z.literal('gloss'), color: hex, colorIntensity: pct, gloss: pct, transparencyIntensity: pct }),
]);

const lipColor = z.strictObject({
  category: z.literal('lip_color'),
  // Features are never altered: original lip line, no plumping, no wrinkle smoothing.
  shape: z.strictObject({ name: z.literal('original') }),
  morphology: z.strictObject({ fullness: z.literal(0), wrinkless: z.literal(0) }),
  style: z.strictObject({ type: z.literal('full') }),
  palettes: z.array(lipPalette).length(1),
});

export const whitelistedEffectsSchema = z
  .array(z.union([skinSmooth, eyeShadow, blush, lipColor]))
  .min(2)
  .max(4)
  .refine((fx) => fx[0]?.category === 'skin_smooth', 'skin_smooth 0/0 must come first')
  .refine((fx) => new Set(fx.map((e) => e.category)).size === fx.length, 'one effect per category');
