/**
 * Turns the model's validated answer into app `LookRecipe`s and checks what a schema cannot:
 * kit finishes, step zones, variant order and distinctness, honest wording. Problems come back
 * as short English sentences, fed to the model on the retry.
 */
import { recipeId } from '../contracts/domain/recipe.js';
import {
  VARIANTS,
  ZONES,
  type LookRecipe,
  type RecipeStep,
  type UserIntent,
  type Zone,
  type ZoneIntensity,
  type ZoneRecipe,
} from '../contracts/domain/types.js';
import { checkRecipe, type LookContext } from '../looks/look.validator.js';
import type { ZoneRules } from './rules.js';
import type { DescribeOut, LookOut, LooksOut } from './schemas.js';
import { fitTime } from './templates.js';

export type Assembled<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** Brand names, URLs, accuracy claims and percentages are never shown (brief §4, DESIGN honesty). */
const FORBIDDEN = /%|https?:|www\.|™|®|\b(exact|exacto|exacta|garantiza|guarantee)\w*|\b[1-5] (of|de) 5\b/i;

/** Products outside the look (eyeshadow, blush, lipstick): steps must stay doable with the recipe. */
const OTHER_PRODUCTS =
  /\b(base de maquillaje|foundation|concealer|corrector|polvos?|powder|prebase|iluminador|highlighter|bronzer|bronceador|r[íi]mel|m[áa]scara de pesta[ñn]as|mascara|delineador|eyeliner|fijador|setting spray|contouring)\b/i;

export function textProblems(text: DescribeOut, enabled: Zone[], where: string): string[] {
  const problems: string[] = [];
  const all = [text.tagline, text.explanation, ...text.steps.map((s) => s.text)];
  if (all.some((t) => FORBIDDEN.test(t))) problems.push(`${where}: no percentages, intensity numbers, URLs, brands or accuracy claims.`);
  if (all.some((t) => OTHER_PRODUCTS.test(t))) problems.push(`${where}: mention only eyeshadow, blush and lipstick; no other products.`);
  for (const step of text.steps) {
    if (step.zone !== 'prep' && step.zone !== 'finish' && !enabled.includes(step.zone)) {
      problems.push(`${where}: a step uses the ${step.zone} zone, which is not part of this look.`);
    }
  }
  const zoneSteps = text.steps.filter((s) => s.zone !== 'prep' && s.zone !== 'finish').map((s) => s.zone as Zone);
  for (const zone of enabled) if (!zoneSteps.includes(zone)) problems.push(`${where}: add a step for the ${zone}.`);
  return problems;
}

function toZone(out: LookOut[Zone], rules: ZoneRules, source: 'kit' | 'guide'): ZoneRecipe {
  if (!rules.available || !out.enabled) {
    // Unavailable zones keep a placeholder shade: they are never rendered nor shown in steps.
    const reason = rules.available ? undefined : rules.reason;
    return { enabled: false, disabledReason: reason, shadeId: rules.allShades[0], finish: 'matte', intensity: 1, source };
  }
  return { enabled: true, shadeId: out.shadeId, finish: out.finish, intensity: out.intensity as ZoneIntensity, source };
}

export function assembleLooks(
  out: LooksOut,
  rules: Record<Zone, ZoneRules>,
  ctx: LookContext,
  intent: UserIntent,
): Assembled<LookRecipe[]> {
  const problems: string[] = [];
  const order = out.looks.map((l) => l.variant).join(',');
  if (order !== VARIANTS.join(',')) problems.push(`Return exactly one look per variant in this order: ${VARIANTS.join(', ')}.`);

  const source: 'kit' | 'guide' = ctx.kit.status === 'declared' ? 'kit' : 'guide';
  const looks: LookRecipe[] = [];
  for (const look of out.looks) {
    const where = `Look "${look.variant}"`;
    const zones = Object.fromEntries(ZONES.map((z) => [z, toZone(look[z], rules[z], source)])) as Record<Zone, ZoneRecipe>;
    for (const z of ZONES) {
      const r = rules[z];
      const zr = zones[z];
      if (r.available && r.kitFinishes && zr.enabled && !r.kitFinishes[zr.shadeId]?.includes(zr.finish)) {
        problems.push(`${where}: the person owns ${zr.shadeId} only as ${r.kitFinishes[zr.shadeId]?.join(' or ')}.`);
      }
    }
    const enabled = ZONES.filter((z) => zones[z].enabled);
    problems.push(...textProblems(look, enabled, where));

    const fields = {
      variant: look.variant,
      ...zones,
      paletteSource: source,
      kitShortfall: ctx.kit.status === 'declared' && (look.kitShortfall || ZONES.some((z) => zones[z].disabledReason === 'notInKit')),
      origin: 'model' as const,
    };
    const steps: RecipeStep[] = fitTime(look.steps, intent.time);
    const recipe: LookRecipe = { ...fields, id: recipeId(fields), tagline: look.tagline, explanation: look.explanation, steps };
    // Same gate the render endpoint uses: an assembled recipe is always renderable.
    const checked = checkRecipe(recipe, ctx);
    if (!checked.ok && checked.problems.some((p) => p.kind !== 'noActiveZone')) {
      problems.push(`${where}: ${checked.problems.map((p) => p.kind).join(', ')}.`);
    }
    looks.push(recipe);
  }

  if (problems.length === 0) {
    // Ids include the variant; compare the render-relevant fields only.
    const looksKey = (l: LookRecipe) => recipeId({ ...l, variant: 'whisper' });
    if (new Set(looks.map(looksKey)).size !== looks.length) problems.push('The three looks must differ in shades, finishes or intensities.');
    const weight = (l: LookRecipe) => ZONES.reduce((s, z) => s + (l[z].enabled ? l[z].intensity : 0), 0);
    const [w, b, s] = looks.map(weight);
    if (!(w <= b && b <= s && w < s)) problems.push('Intensity must grow from whisper to balance to statement.');
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: looks };
}

export function assembleText(out: DescribeOut, recipe: LookRecipe, intent: UserIntent): Assembled<DescribeOut> {
  const enabled = ZONES.filter((z) => recipe[z].enabled);
  const problems = textProblems(out, enabled, 'Text');
  return problems.length ? { ok: false, problems } : { ok: true, value: { ...out, steps: fitTime(out.steps, intent.time) } };
}
