/**
 * Business validation of a look before anything is rendered (brief §6.4): shape, shade
 * library, finishes per zone, the person's constraints and declared kit. A recipe with any
 * problem never reaches the compiler, so a blocked change never consumes YouCam units.
 *
 * Constraint and kit rules are the app's own (`contracts/domain/constraints.ts`), so the UI
 * and the API can never disagree on what is allowed.
 */
import type { z } from 'zod';

import { recipeViolations, type Violation } from '../contracts/domain/constraints.js';
import { recipeId } from '../contracts/domain/recipe.js';
import { SHADES } from '../contracts/domain/shades.js';
import { FINISHES_BY_ZONE, ZONES, type Constraint, type Kit, type LookRecipe, type Zone } from '../contracts/domain/types.js';
import { constraintsSchema, kitSchema, lookRecipeSchema } from '../contracts/wire.js';

export type LookProblem =
  | { kind: 'shape'; target: 'recipe' | 'kit' | 'constraints'; path: string; message: string }
  | { kind: 'unknownShade'; zone: Zone; shadeId: string }
  | { kind: 'finishNotForZone'; zone: Zone; finish: string }
  | { kind: 'noActiveZone' }
  | { kind: 'idMismatch'; expected: string }
  | Violation;

export interface LookContext {
  constraints: Constraint[];
  kit: Kit;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: LookProblem[] };

const SHADE_ZONE = new Map(SHADES.map((s) => [s.id, s.zone]));

function shapeProblems(target: 'recipe' | 'kit' | 'constraints', error: z.ZodError): LookProblem[] {
  return error.issues.map((i) => ({ kind: 'shape', target, path: i.path.join('.'), message: i.message }));
}

function libraryProblems(zone: Zone, shadeId: string, finish: string): LookProblem[] {
  const out: LookProblem[] = [];
  if (SHADE_ZONE.get(shadeId) !== zone) out.push({ kind: 'unknownShade', zone, shadeId });
  if (!(FINISHES_BY_ZONE[zone] as readonly string[]).includes(finish)) out.push({ kind: 'finishNotForZone', zone, finish });
  return out;
}

/** Parse untrusted context (from the app) — kit items must also come from the shade library. */
export function checkContext(raw: { constraints: unknown; kit: unknown }): Checked<LookContext> {
  const constraints = constraintsSchema.safeParse(raw.constraints);
  const kit = kitSchema.safeParse(raw.kit);
  const problems: LookProblem[] = [
    ...(constraints.success ? [] : shapeProblems('constraints', constraints.error)),
    ...(kit.success ? [] : shapeProblems('kit', kit.error)),
  ];
  if (kit.success) {
    for (const zone of ZONES) for (const item of kit.data.items[zone]) problems.push(...libraryProblems(zone, item.shadeId, item.finish));
  }
  if (problems.length || !constraints.success || !kit.success) return { ok: false, problems };
  return { ok: true, value: { constraints: constraints.data, kit: kit.data } };
}

/** Full check of a recipe against an already-validated context. Empty problems = renderable. */
export function checkRecipe(raw: unknown, ctx: LookContext): Checked<LookRecipe> {
  const parsed = lookRecipeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: shapeProblems('recipe', parsed.error) };
  const recipe = parsed.data;

  const problems: LookProblem[] = [];
  for (const zone of ZONES) {
    const z = recipe[zone];
    if (z.enabled) problems.push(...libraryProblems(zone, z.shadeId, z.finish));
  }
  if (!ZONES.some((zone) => recipe[zone].enabled)) problems.push({ kind: 'noActiveZone' });
  problems.push(...recipeViolations(recipe, ctx.constraints, ctx.kit));

  // The id is the render cache key; a stale id would serve the wrong image.
  const expected = recipeId(recipe);
  if (recipe.id !== expected) problems.push({ kind: 'idMismatch', expected });

  return problems.length ? { ok: false, problems } : { ok: true, value: recipe };
}
