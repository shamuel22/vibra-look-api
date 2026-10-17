/**
 * Runtime schemas for everything the app sends to the API (recipes, kit, constraints, intent).
 * They mirror `./domain/types.ts` exactly — the type assertions at the bottom fail `tsc` if the
 * app's contract changes and these schemas are not updated.
 *
 * Shape only: business rules (constraints, kit, whitelist) live in `looks/look.validator.ts`.
 */
import { z } from 'zod';

import {
  FINISHES_BY_ZONE,
  VARIANTS,
  VIBE_MAX_LENGTH,
  VIBE_MIN_LENGTH,
  ZONES,
  type Constraint,
  type Kit,
  type LookRecipe,
  type UserIntent,
} from './domain/types.js';

const finishes = [...new Set(Object.values(FINISHES_BY_ZONE).flat())] as [string, ...string[]];

export const zoneSchema = z.enum(ZONES as [(typeof ZONES)[number], ...(typeof ZONES)[number][]]);
export const finishSchema = z.enum(finishes as ['matte', 'satin', 'gloss', 'metallic', 'luminous']);
export const variantSchema = z.enum(VARIANTS as ['whisper', 'balance', 'statement']);
export const constraintSchema = z.enum(['noShadow', 'noShine', 'discreetLips']);
export const zoneIntensitySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

const shadeId = z.string().min(1).max(40);

export const zoneRecipeSchema = z.strictObject({
  enabled: z.boolean(),
  disabledReason: z.enum(['constraint', 'notInKit']).optional(),
  shadeId,
  finish: finishSchema,
  intensity: zoneIntensitySchema,
  source: z.enum(['kit', 'guide']),
});

export const recipeStepSchema = z.strictObject({
  zone: z.enum(['eyes', 'lips', 'cheeks', 'prep', 'finish']),
  text: z.string().min(1).max(280),
  minutes: z.number().int().min(0).max(20),
});

export const lookRecipeSchema = z.strictObject({
  id: z.string().min(1).max(32),
  variant: variantSchema,
  eyes: zoneRecipeSchema,
  lips: zoneRecipeSchema,
  cheeks: zoneRecipeSchema,
  tagline: z.string().max(120),
  explanation: z.string().max(600),
  steps: z.array(recipeStepSchema).max(12),
  paletteSource: z.enum(['kit', 'guide']),
  kitShortfall: z.boolean(),
  origin: z.enum(['model', 'editorial', 'simulated']),
});

const kitItemSchema = z.strictObject({ shadeId, finish: finishSchema });
const kitZoneItems = z.array(kitItemSchema).max(2);

export const kitSchema = z.strictObject({
  status: z.enum(['unset', 'skipped', 'declared']),
  items: z.strictObject({ eyes: kitZoneItems, lips: kitZoneItems, cheeks: kitZoneItems }),
});

export const constraintsSchema = z
  .array(constraintSchema)
  .max(3)
  .refine((cs) => new Set(cs).size === cs.length, 'duplicate constraint');

export const userIntentSchema = z.strictObject({
  text: z.string().trim().min(VIBE_MIN_LENGTH).max(VIBE_MAX_LENGTH),
  time: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  intensity: z.enum(['subtle', 'balanced', 'expressive']),
});

// ─── Contract parity (compile-time) ─────────────────────────────────────────

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const parity: [
  Same<z.infer<typeof lookRecipeSchema>, LookRecipe>,
  Same<z.infer<typeof kitSchema>, Kit>,
  Same<z.infer<typeof constraintSchema>, Constraint>,
  Same<z.infer<typeof userIntentSchema>, UserIntent>,
] = [true, true, true, true];
void parity;
