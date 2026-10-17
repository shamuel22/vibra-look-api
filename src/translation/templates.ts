/**
 * Deterministic recipe text in Spanish and English: used when the language model is
 * unavailable or its text fails validation, so a recipe always has honest text derived from
 * its own fields (brief §6, honesty rule).
 */
import { getShade } from '../contracts/domain/shades.js';
import type { Locale, LookRecipe, RecipeStep, UserIntent, Zone } from '../contracts/domain/types.js';
import { FINISH_NAMES, INTENSITY_NAMES, shadeName } from '../looks/names.js';

export type RecipeFields = Pick<LookRecipe, 'variant' | 'eyes' | 'lips' | 'cheeks' | 'paletteSource'>;
export type RecipeText = Pick<LookRecipe, 'tagline' | 'explanation' | 'steps'>;

const TAGLINES: Record<Locale, Record<LookRecipe['variant'], string>> = {
  es: {
    whisper: 'Fresca, luminosa y natural.',
    balance: 'Sofisticada, versátil y atemporal.',
    statement: 'Más intensidad para destacar.',
  },
  en: {
    whisper: 'Fresh, luminous and natural.',
    balance: 'Polished, versatile and timeless.',
    statement: 'More intensity to stand out.',
  },
};

const NO_ZONES: Record<Locale, { tagline: string; explanation: string; steps: string[] }> = {
  es: {
    tagline: 'Una pausa para revisar tu kit.',
    explanation:
      'No aplicamos color para «{vibe}»: tu kit y tus preferencias no dejan ninguna zona disponible. Ajusta el kit o vuelve y omítelo para explorar una paleta orientativa.',
    steps: [
      'Deja el rostro tal como está; esta receta no aplica maquillaje.',
      'Revisa qué productos de tu kit son compatibles con tus preferencias.',
      'Vuelve al kit para ajustarlo u omítelo antes de crear nuevos looks.',
    ],
  },
  en: {
    tagline: 'Time to review your kit.',
    explanation:
      'No color was applied for “{vibe}”: your kit and preferences leave no areas available. Adjust your kit, or go back and skip it to explore a suggested palette.',
    steps: [
      'Leave your face as it is; this recipe applies no makeup.',
      'Check which products in your kit work with your preferences.',
      'Go back to adjust or skip your kit before creating new looks.',
    ],
  },
};

const name = (locale: Locale, shadeId: string) => shadeName(locale, getShade(shadeId).nameKey);

/** Application order for steps: eyes, cheeks, lips. */
const STEP_ORDER: readonly Zone[] = ['eyes', 'cheeks', 'lips'];

export function templateText(r: RecipeFields, intent: UserIntent, locale: Locale): RecipeText {
  const es = locale === 'es';
  const vibe = intent.text.trim();
  const zones = STEP_ORDER.filter((z) => r[z].enabled);
  if (zones.length === 0) {
    const t = NO_ZONES[locale];
    return {
      tagline: t.tagline,
      explanation: t.explanation.replace('{vibe}', vibe),
      steps: [
        { zone: 'prep', minutes: 1, text: t.steps[0] },
        { zone: 'prep', minutes: 1, text: t.steps[1] },
        { zone: 'finish', minutes: 1, text: t.steps[2] },
      ],
    };
  }

  const parts = (['eyes', 'lips', 'cheeks'] as const)
    .filter((z) => r[z].enabled)
    .map((z) => {
      const n = name(locale, r[z].shadeId);
      return es ? { eyes: `ojos en ${n}`, lips: `un labio ${n}`, cheeks: `mejillas ${n}` }[z] : { eyes: `${n} eyes`, lips: `a ${n} lip`, cheeks: `${n} cheeks` }[z];
    });
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}${es ? ' y ' : ' and '}${parts.at(-1)}` : (parts[0] ?? '');
  const pref = INTENSITY_NAMES[locale][intent.intensity];
  const explanation = es
    ? `Tradujimos «${vibe}» en ${joined}, manteniendo la intensidad ${pref} que pediste.`
    : `We translated “${vibe}” into ${joined}, keeping the ${pref} intensity you asked for.`;

  return { tagline: TAGLINES[locale][r.variant], explanation, steps: templateSteps(r, intent, locale) };
}

function templateSteps(r: RecipeFields, intent: UserIntent, locale: Locale): RecipeStep[] {
  const es = locale === 'es';
  const zones = STEP_ORDER.filter((z) => r[z].enabled);
  const steps: RecipeStep[] = [];
  if (intent.time >= 10 || zones.length < 2) {
    steps.push({
      zone: 'prep',
      minutes: 1,
      text: es ? 'Hidrata y deja la piel tal como es; no hace falta base.' : 'Moisturize and leave your skin as it is; no foundation needed.',
    });
  }
  for (const z of zones) {
    const n = name(locale, r[z].shadeId);
    const fin = FINISH_NAMES[locale][r[z].finish];
    const soft = r[z].intensity <= 2;
    const text = {
      eyes: es
        ? `Aplica la sombra ${n} (${fin}) en el párpado ${soft ? 'con una capa ligera' : 'y difumina hacia afuera'}.`
        : `Apply the ${n} shadow (${fin}) on the lid ${soft ? 'in one light layer' : 'and blend outward'}.`,
      cheeks: es
        ? `Da toques de rubor ${n} (${fin}) en las mejillas y difumina hacia las sienes.`
        : `Tap ${n} blush (${fin}) on your cheeks and blend toward the temples.`,
      lips: es
        ? `Aplica el labial ${n} (${fin}) ${soft ? 'con el dedo, a toques' : 'definiendo el contorno'}.`
        : `Apply the ${n} lipstick (${fin}) ${soft ? 'with your finger, in dabs' : 'defining the outline'}.`,
    }[z];
    steps.push({ zone: z, minutes: 2, text });
  }
  if (steps.length < 3) {
    steps.push({
      zone: 'finish',
      minutes: 1,
      text: es ? 'Mírate con luz natural y suaviza cualquier borde.' : 'Check yourself in natural light and soften any edges.',
    });
  }
  return fitTime(steps.slice(0, 5), intent.time);
}

/** Scale step minutes down to the time budget (never below 1 minute per step). */
export function fitTime(steps: RecipeStep[], budget: number): RecipeStep[] {
  const total = steps.reduce((s, x) => s + x.minutes, 0);
  if (total <= budget) return steps;
  const scale = budget / total;
  return steps.map((s) => ({ ...s, minutes: Math.max(1, Math.floor(s.minutes * scale)) }));
}
