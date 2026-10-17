/** Sample recipes for tests and the operator smoke test. Together they cover every finish. */
import { recipeId } from '../contracts/domain/recipe.js';
import type { Kit, LookRecipe, VariantKey, Zone, ZoneRecipe } from '../contracts/domain/types.js';

export const EMPTY_KIT: Kit = { status: 'skipped', items: { eyes: [], lips: [], cheeks: [] } };

export function zone(shadeId: string, finish: ZoneRecipe['finish'], intensity: ZoneRecipe['intensity'], enabled = true): ZoneRecipe {
  return { enabled, shadeId, finish, intensity, source: 'guide' };
}

export function makeRecipe(variant: VariantKey, zones: Record<Zone, ZoneRecipe>): LookRecipe {
  const draft = {
    variant,
    ...zones,
    tagline: 'Sample',
    explanation: 'Sample recipe',
    steps: [{ zone: 'prep' as const, text: 'Prep', minutes: 1 }],
    paletteSource: 'guide' as const,
    kitShortfall: false,
    origin: 'editorial' as const,
  };
  return { ...draft, id: recipeId(draft) };
}

/** Whisper (all matte/satin), balance (shimmer eyes, satin cheeks, gloss), statement (metallic eyes, luminous). */
export const SAMPLE_LOOKS: readonly LookRecipe[] = [
  makeRecipe('whisper', {
    eyes: zone('eye-champagne', 'matte', 2),
    lips: zone('lip-nude-rose', 'satin', 2),
    cheeks: zone('cheek-petal', 'matte', 2),
  }),
  makeRecipe('balance', {
    eyes: zone('eye-mauve', 'satin', 3),
    lips: zone('lip-mauve', 'gloss', 3),
    cheeks: zone('cheek-soft-mauve', 'satin', 3),
  }),
  makeRecipe('statement', {
    eyes: zone('eye-bronze', 'metallic', 4),
    lips: zone('lip-wine', 'matte', 4),
    cheeks: zone('cheek-terracotta', 'luminous', 3),
  }),
];
