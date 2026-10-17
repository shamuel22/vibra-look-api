/**
 * Pre-designed editorial recipes: the fallback when the language model fails twice (brief §6.2).
 * Deterministic, constraint- and kit-aware, and labelled `origin: 'editorial'` so the app says so.
 */
import { recipeId } from '../contracts/domain/recipe.js';
import { getShade } from '../contracts/domain/shades.js';
import {
  VARIANTS,
  type Finish,
  type Locale,
  type LookRecipe,
  type UserIntent,
  type VariantKey,
  type Zone,
  type ZoneIntensity,
  type ZoneRecipe,
} from '../contracts/domain/types.js';
import type { LookContext } from '../looks/look.validator.js';
import { zoneRules } from './rules.js';
import { templateText } from './templates.js';

type Mood = 'cool' | 'warm';

const WARM_WORDS =
  /jazz|rooftop|azotea|terraza|atardecer|sunset|verano|summer|c[áa]lid|warm|fuego|fire|dorad|golden|oto[ñn]o|autumn|fall|desierto|desert|caf[ée]|coffee|playa|beach|sol\b|sun\b|tierra|earth|bronce|bronze|vino|wine/i;

const PALETTES: Record<Mood, Record<VariantKey, Record<Zone, string>>> = {
  cool: {
    whisper: { eyes: 'eye-lavender', lips: 'lip-dusty-pink', cheeks: 'cheek-petal' },
    balance: { eyes: 'eye-mauve', lips: 'lip-mauve', cheeks: 'cheek-soft-mauve' },
    statement: { eyes: 'eye-smoky-plum', lips: 'lip-plum', cheeks: 'cheek-brick-rose' },
  },
  warm: {
    whisper: { eyes: 'eye-champagne', lips: 'lip-nude-rose', cheeks: 'cheek-peach' },
    balance: { eyes: 'eye-bronze', lips: 'lip-terracotta', cheeks: 'cheek-coral' },
    statement: { eyes: 'eye-chocolate', lips: 'lip-wine', cheeks: 'cheek-terracotta' },
  },
};

const BASE_INTENSITY: Record<VariantKey, number> = { whisper: 2, balance: 3, statement: 4 };
const PREF_SHIFT = { subtle: -1, balanced: 0, expressive: 1 } as const;

const PREFERRED_FINISH: Record<VariantKey, Record<Zone, Finish>> = {
  whisper: { eyes: 'satin', lips: 'satin', cheeks: 'luminous' },
  balance: { eyes: 'satin', lips: 'satin', cheeks: 'satin' },
  statement: { eyes: 'metallic', lips: 'matte', cheeks: 'matte' },
};

function lightness(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
}

function buildZone(zone: Zone, variant: VariantKey, mood: Mood, intent: UserIntent, ctx: LookContext): ZoneRecipe {
  const rules = zoneRules(zone, ctx);
  const preferredShade = PALETTES[mood][variant][zone];
  const preferredFinish = PREFERRED_FINISH[variant][zone];
  const source = ctx.kit.status === 'declared' ? 'kit' : 'guide';
  if (!rules.available) {
    return { enabled: false, disabledReason: rules.reason, shadeId: preferredShade, finish: preferredFinish, intensity: 1, source };
  }
  const intensity = Math.max(1, Math.min(rules.maxIntensity, BASE_INTENSITY[variant] + PREF_SHIFT[intent.intensity])) as ZoneIntensity;

  if (!rules.kitFinishes) {
    const finish = rules.finishes.includes(preferredFinish) ? preferredFinish : 'satin';
    return { enabled: true, shadeId: preferredShade, finish, intensity, source };
  }
  // Declared kit: whisper takes the lightest shade, statement the deepest, balance the first declared.
  const byLightness = [...rules.shades].sort((a, b) => lightness(getShade(b).hex) - lightness(getShade(a).hex));
  const shadeId = variant === 'whisper' ? byLightness[0] : variant === 'statement' ? byLightness.at(-1)! : rules.shades[0];
  return { enabled: true, shadeId, finish: rules.kitFinishes[shadeId][0], intensity, source };
}

export function editorialLooks(intent: UserIntent, ctx: LookContext, locale: Locale): LookRecipe[] {
  const mood: Mood = WARM_WORDS.test(intent.text) ? 'warm' : 'cool';
  return VARIANTS.map((variant) => {
    const eyes = buildZone('eyes', variant, mood, intent, ctx);
    const lips = buildZone('lips', variant, mood, intent, ctx);
    const cheeks = buildZone('cheeks', variant, mood, intent, ctx);
    const fields = {
      variant,
      eyes,
      lips,
      cheeks,
      paletteSource: ctx.kit.status === 'declared' ? ('kit' as const) : ('guide' as const),
      kitShortfall: ctx.kit.status === 'declared' && [eyes, lips, cheeks].some((z) => z.disabledReason === 'notInKit'),
      origin: 'editorial' as const,
    };
    return { ...fields, id: recipeId(fields), ...templateText(fields, intent, locale) };
  });
}
