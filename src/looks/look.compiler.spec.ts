import { describe, expect, it } from 'vitest';

import { recipeViolations } from '../contracts/domain/constraints.js';
import { recipeId } from '../contracts/domain/recipe.js';
import { shadesForZone } from '../contracts/domain/shades.js';
import {
  FINISHES_BY_ZONE,
  VARIANTS,
  ZONES,
  type Constraint,
  type Kit,
  type LookRecipe,
  type Zone,
  type ZoneIntensity,
} from '../contracts/domain/types.js';
import { COLOR_INTENSITY, compileLook, LookRejectedError } from './look.compiler.js';
import { EMPTY_KIT, makeRecipe, SAMPLE_LOOKS, zone } from './look.fixtures.js';
import { checkContext, type LookProblem } from './look.validator.js';
import { whitelistedEffectsSchema } from './whitelist.js';

const NO_CTX = { constraints: [] as Constraint[], kit: EMPTY_KIT };
const BASE = SAMPLE_LOOKS[1];
const INTENSITIES: ZoneIntensity[] = [1, 2, 3, 4, 5];
const CONSTRAINT_SETS: Constraint[][] = [[], ['noShadow'], ['noShine'], ['discreetLips'], ['noShadow', 'noShine', 'discreetLips']];

function problems(raw: unknown, ctx = NO_CTX): LookProblem[] {
  try {
    compileLook(raw, ctx);
    return [];
  } catch (e) {
    if (e instanceof LookRejectedError) return e.problems;
    throw e;
  }
}

function withZone(r: LookRecipe, z: Zone, next: LookRecipe[Zone]): LookRecipe {
  const draft = { ...r, [z]: next };
  return { ...draft, id: recipeId(draft) };
}

/** Every single-zone variation of the sample looks: all shades × finishes × intensities × variants. */
function* allVariations(): Generator<LookRecipe> {
  for (const variant of VARIANTS) {
    const base = { ...BASE, variant };
    for (const z of ZONES)
      for (const shade of shadesForZone(z))
        for (const finish of FINISHES_BY_ZONE[z])
          for (const intensity of INTENSITIES) yield withZone({ ...base, id: '' }, z, zone(shade.id, finish, intensity));
  }
}

describe('compileLook — exhaustive', () => {
  it('compiles every valid recipe and rejects every invalid one, under each constraint set', () => {
    let compiled = 0;
    let rejected = 0;
    for (const constraints of CONSTRAINT_SETS) {
      const ctx = { constraints, kit: EMPTY_KIT };
      for (const recipe of allVariations()) {
        // Constraints may disable the eyes; the app does so, and so does this test.
        const r = constraints.includes('noShadow') ? withZone(recipe, 'eyes', { ...recipe.eyes, enabled: false, disabledReason: 'constraint' }) : recipe;
        const valid = recipeViolations(r, constraints, EMPTY_KIT).length === 0;
        if (valid) {
          const { effects } = compileLook(r, ctx);
          expect(whitelistedEffectsSchema.safeParse(effects).success).toBe(true);
          compiled++;
        } else {
          expect(() => compileLook(r, ctx)).toThrow(LookRejectedError);
          rejected++;
        }
      }
    }
    expect(compiled).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(100);
  });

  it('gives every distinct recipe a distinct id (render cache key)', () => {
    const ids = new Map<string, string>();
    for (const r of allVariations()) {
      const key = `${r.variant}|${ZONES.map((z) => `${r[z].shadeId}:${r[z].finish}:${r[z].intensity}`).join('|')}`;
      const seen = ids.get(r.id);
      expect(seen === undefined || seen === key).toBe(true);
      ids.set(r.id, key);
    }
    expect(ids.size).toBeGreaterThan(900);
  });

  it('is deterministic', () => {
    for (const look of SAMPLE_LOOKS) expect(compileLook(structuredClone(look), NO_CTX)).toEqual(compileLook(look, NO_CTX));
  });
});

describe('compileLook — mapping', () => {
  it('never alters features: skin_smooth 0/0 first, original lip line, no plumping', () => {
    for (const look of SAMPLE_LOOKS) {
      const { effects } = compileLook(look, NO_CTX);
      expect(effects[0]).toEqual({ category: 'skin_smooth', skinSmoothStrength: 0, skinSmoothColorIntensity: 0 });
      expect(effects.find((e) => e.category === 'lip_color')).toMatchObject({
        shape: { name: 'original' },
        morphology: { fullness: 0, wrinkless: 0 },
        style: { type: 'full' },
      });
    }
  });

  it('maps intensity 1–5 to colorIntensity and the shade hex (uppercase)', () => {
    for (const i of INTENSITIES) {
      const r = withZone(BASE, 'lips', zone('lip-cherry', 'matte', i));
      const lip = compileLook(r, NO_CTX).effects.find((e) => e.category === 'lip_color');
      expect(lip?.palettes[0]).toEqual({ color: '#B5323F', texture: 'matte', colorIntensity: COLOR_INTENSITY[i] });
    }
  });

  it('maps finishes to YouCam textures with their required parameters', () => {
    const [whisper, balance, statement] = SAMPLE_LOOKS.map((l) => compileLook(l, NO_CTX).effects);
    const pick = (fx: typeof whisper, c: string) => fx.find((e) => e.category === c) as { pattern?: { name: string }; palettes: Record<string, unknown>[] };

    expect(pick(whisper, 'eye_shadow')).toMatchObject({ pattern: { name: '1color1' }, palettes: [{ texture: 'matte' }] });
    expect(pick(balance, 'eye_shadow').palettes[0]).toMatchObject({ texture: 'shimmer', shimmerIntensity: 20 });
    expect(pick(balance, 'eye_shadow').palettes[0].shimmerColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(pick(balance, 'blush').palettes[0]).toMatchObject({ texture: 'satin', glowStrength: 35 });
    expect(pick(balance, 'lip_color').palettes[0]).toMatchObject({ texture: 'gloss', gloss: 60, transparencyIntensity: 25 });
    expect(pick(statement, 'blush').palettes[0]).toMatchObject({ texture: 'shimmer', glowStrength: 50, shimmerDensity: 35 });
    expect(pick(statement, 'eye_shadow')).toMatchObject({
      pattern: { name: '1color1' },
      palettes: [{ texture: 'metallic', shimmerIntensity: 45, metallicIntensity: 55 }],
    });
  });

  it('leaves disabled zones out of the request', () => {
    const r = withZone(BASE, 'eyes', { ...BASE.eyes, enabled: false, disabledReason: 'constraint' });
    const { effects } = compileLook(r, { constraints: ['noShadow'], kit: EMPTY_KIT });
    expect(effects.map((e) => e.category)).toEqual(['skin_smooth', 'blush', 'lip_color']);
  });
});

describe('compileLook — rejections (nothing reaches YouCam)', () => {
  const kinds = (raw: unknown, ctx = NO_CTX) => problems(raw, ctx).map((p) => p.kind);

  it('rejects malformed input and unknown fields', () => {
    expect(kinds(null)).toEqual(['shape']);
    expect(kinds({ ...BASE, eyes: { ...BASE.eyes, intensity: 6 } })).toContain('shape');
    expect(kinds({ ...BASE, foundation: { color: '#000000' } })).toContain('shape');
    expect(kinds({ ...BASE, lips: { ...BASE.lips, shape: 'plump' } })).toContain('shape');
  });

  it('rejects shades outside the library or from another zone, and finishes of another zone', () => {
    expect(kinds(withZone(BASE, 'lips', zone('lip-neon', 'matte', 3)))).toContain('unknownShade');
    expect(kinds(withZone(BASE, 'lips', zone('eye-mauve', 'matte', 3)))).toContain('unknownShade');
    expect(kinds(withZone(BASE, 'eyes', zone('eye-mauve', 'gloss', 3)))).toContain('finishNotForZone');
  });

  it('rejects a look with no zone to render and a stale id', () => {
    const off = makeRecipe('whisper', {
      eyes: zone('eye-sand', 'matte', 1, false),
      lips: zone('lip-mauve', 'matte', 1, false),
      cheeks: zone('cheek-peach', 'matte', 1, false),
    });
    expect(kinds(off)).toContain('noActiveZone');
    expect(kinds({ ...BASE, id: 'r0' })).toEqual(['idMismatch']);
    expect(kinds({ ...BASE, lips: { ...BASE.lips, intensity: 1 } })).toEqual(['idMismatch']);
  });

  it('enforces the person’s constraints', () => {
    expect(kinds(BASE, { constraints: ['noShadow'], kit: EMPTY_KIT })).toEqual(['zoneBlocked']);
    expect(kinds(BASE, { constraints: ['noShine'], kit: EMPTY_KIT })).toEqual(['finishBlocked']);
    expect(kinds(SAMPLE_LOOKS[2], { constraints: ['discreetLips'], kit: EMPTY_KIT })).toEqual(['intensityTooHigh']);
  });

  it('enforces a declared kit', () => {
    const kit: Kit = {
      status: 'declared',
      items: { eyes: [{ shadeId: 'eye-mauve', finish: 'satin' }], lips: [{ shadeId: 'lip-mauve', finish: 'gloss' }], cheeks: [] },
    };
    const r = withZone(BASE, 'cheeks', { ...BASE.cheeks, enabled: false, disabledReason: 'notInKit' });
    expect(kinds(r, { constraints: [], kit })).toEqual([]);
    expect(problems(BASE, { constraints: [], kit })).toEqual([{ kind: 'notInKit', zone: 'cheeks', shadeId: 'cheek-soft-mauve' }]);
    // The person owns the gloss lipstick, not a satin one in that shade.
    const satinLip = withZone(r, 'lips', { ...r.lips, finish: 'satin' });
    expect(problems(satinLip, { constraints: [], kit })).toEqual([{ kind: 'notInKit', zone: 'lips', shadeId: 'lip-mauve' }]);
  });
});

describe('checkContext', () => {
  it('accepts a valid context and rejects malformed or out-of-library kits', () => {
    expect(checkContext({ constraints: ['noShine'], kit: EMPTY_KIT }).ok).toBe(true);
    const bad = (raw: { constraints: unknown; kit: unknown }) => {
      const r = checkContext(raw);
      return r.ok ? [] : r.problems.map((p) => p.kind);
    };
    expect(bad({ constraints: ['noShine', 'noShine'], kit: EMPTY_KIT })).toEqual(['shape']);
    expect(bad({ constraints: ['noGlitter'], kit: EMPTY_KIT })).toEqual(['shape']);
    expect(bad({ constraints: [], kit: { ...EMPTY_KIT, items: { ...EMPTY_KIT.items, lips: [{ shadeId: 'lip-x', finish: 'matte' }] } } })).toEqual([
      'unknownShade',
    ]);
    expect(bad({ constraints: [], kit: { ...EMPTY_KIT, items: { ...EMPTY_KIT.items, eyes: [{ shadeId: 'eye-sand', finish: 'gloss' }] } } })).toEqual([
      'finishNotForZone',
    ]);
  });
});
