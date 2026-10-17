import { describe, expect, it, vi } from 'vitest';

import type { Constraint, Kit, LookRecipe, UserIntent } from '../contracts/domain/types.js';
import { compileLook } from '../looks/look.compiler.js';
import { EMPTY_KIT } from '../looks/look.fixtures.js';
import { editorialLooks } from './editorial.js';
import type { LlmClient, ToolCall } from './llm.client.js';
import { allZoneRules } from './rules.js';
import { looksOutSchema, toToolSchema } from './schemas.js';
import { TranslationService } from './translation.service.js';

const INTENT: UserIntent = { text: 'jazz en una azotea', time: 10, intensity: 'balanced' };
const NO_CTX = { constraints: [] as Constraint[], kit: EMPTY_KIT };

const steps = (zones: string[]) => [
  { zone: 'prep', text: 'Hidrata la piel y déjala tal como es.', minutes: 1 },
  ...zones.map((zone) => ({ zone, text: `Aplica el color en ${zone} con toques suaves.`, minutes: 2 })),
];

function look(variant: string, eyes: object, lips: object, cheeks: object, zones = ['eyes', 'cheeks', 'lips']) {
  return {
    variant,
    eyes,
    lips,
    cheeks,
    tagline: `Una dirección ${variant}`,
    explanation: 'Tradujimos «jazz en una azotea» en profundidad de ojos y un labio cálido.',
    steps: steps(zones),
    kitShortfall: false,
  };
}

const z = (shadeId: string, finish: string, intensity: number) => ({ enabled: true, shadeId, finish, intensity });

const VALID = {
  looks: [
    look('whisper', z('eye-champagne', 'satin', 2), z('lip-nude-rose', 'satin', 2), z('cheek-peach', 'matte', 2)),
    look('balance', z('eye-bronze', 'satin', 3), z('lip-terracotta', 'satin', 3), z('cheek-coral', 'satin', 3)),
    look('statement', z('eye-chocolate', 'metallic', 4), z('lip-wine', 'matte', 4), z('cheek-terracotta', 'luminous', 3)),
  ],
};

function service(...answers: unknown[]) {
  const calls: ToolCall[] = [];
  const callTool = vi.fn(async (call: ToolCall) => {
    calls.push(call);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return structuredClone(next);
  });
  const llm = { configured: true, callTool } as unknown as LlmClient;
  return { svc: new TranslationService(llm), calls };
}

const renderable = (looks: LookRecipe[], ctx = NO_CTX) => looks.forEach((l) => expect(() => compileLook(l, ctx)).not.toThrow());

describe('TranslationService.translate', () => {
  it('returns three validated model recipes with ids, sources and fitted steps', async () => {
    const { svc, calls } = service(VALID);
    const looks = await svc.translate({ intent: INTENT, ctx: NO_CTX, locale: 'es' });
    expect(looks.map((l) => [l.variant, l.origin, l.paletteSource])).toEqual([
      ['whisper', 'model', 'guide'],
      ['balance', 'model', 'guide'],
      ['statement', 'model', 'guide'],
    ]);
    expect(looks.every((l) => l.steps.reduce((s, x) => s + x.minutes, 0) <= INTENT.time)).toBe(true);
    renderable(looks);
    // Forced tool, thinking handled by the client, vibe passed as data.
    expect(calls[0].tool.name).toBe('submit_looks');
    expect(calls[0].user).toContain('"vibe": "jazz en una azotea"');
  });

  it('retries once with the problems, then accepts a fixed answer', async () => {
    const bad = structuredClone(VALID);
    bad.looks[0].steps[0].text = 'Aplica base y corrector antes de empezar.';
    const { svc, calls } = service(bad, VALID);
    const looks = await svc.translate({ intent: INTENT, ctx: NO_CTX, locale: 'es' });
    expect(looks[0].origin).toBe('model');
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('no other products');
  });

  it('rejects shades outside the schema, looks out of order and flat intensity', async () => {
    const wrongShade = structuredClone(VALID);
    (wrongShade.looks[0].lips as { shadeId: string }).shadeId = 'eye-sand';
    const flat = { looks: [VALID.looks[1], VALID.looks[1], VALID.looks[1]].map((l, i) => ({ ...l, variant: ['whisper', 'balance', 'statement'][i] })) };
    const { svc, calls } = service(wrongShade, flat);
    const looks = await svc.translate({ intent: INTENT, ctx: NO_CTX, locale: 'es' });
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('lips.shadeId');
    expect(looks.every((l) => l.origin === 'editorial')).toBe(true);
    renderable(looks);
  });

  it('falls back to labelled editorial recipes when the model is unavailable', async () => {
    const { svc } = service(new Error('timeout'), new Error('timeout'));
    const looks = await svc.translate({ intent: INTENT, ctx: NO_CTX, locale: 'en' });
    expect(looks.map((l) => l.origin)).toEqual(['editorial', 'editorial', 'editorial']);
    expect(looks[0].explanation).toContain('“jazz en una azotea”');
    renderable(looks);
  });

  it('restricts the tool schema to what constraints allow', () => {
    const rules = allZoneRules({ constraints: ['noShadow', 'noShine', 'discreetLips'], kit: EMPTY_KIT });
    const schema = toToolSchema(looksOutSchema(rules));
    const text = JSON.stringify(schema);
    expect(text).not.toContain('metallic');
    expect(text).not.toContain('gloss');
    expect(text).not.toContain('eye-bronze');
    const props = (schema as unknown as { properties: { looks: { items: { properties: Record<string, { properties: Record<string, { maximum?: number }> }> } } } })
      .properties.looks.items.properties;
    expect(props.lips.properties.intensity.maximum).toBe(2);
    expect(props.eyes.properties.enabled).toEqual({ type: 'boolean', const: false });
  });

  it('enforces a declared kit (shade and owned finish) and marks kit sources', async () => {
    const kit: Kit = {
      status: 'declared',
      items: { eyes: [{ shadeId: 'eye-bronze', finish: 'satin' }], lips: [{ shadeId: 'lip-wine', finish: 'matte' }, { shadeId: 'lip-nude-rose', finish: 'satin' }], cheeks: [] },
    };
    const ctx = { constraints: [] as Constraint[], kit };
    const answer = {
      looks: ['whisper', 'balance', 'statement'].map((variant, i) =>
        look(variant, z('eye-bronze', 'satin', i + 2), i < 2 ? z('lip-nude-rose', 'satin', i + 2) : z('lip-wine', 'matte', 4), { enabled: false }, ['eyes', 'lips']),
      ),
    };
    const { svc } = service(answer);
    const looks = await svc.translate({ intent: INTENT, ctx, locale: 'es' });
    expect(looks[0].origin).toBe('model');
    expect(looks.every((l) => l.paletteSource === 'kit' && l.kitShortfall && l.cheeks.disabledReason === 'notInKit')).toBe(true);
    renderable(looks, ctx);

    const wrongFinish = structuredClone(answer);
    (wrongFinish.looks[2].lips as { finish: string }).finish = 'satin';
    const { svc: svc2, calls } = service(wrongFinish, wrongFinish);
    const fallback = await svc2.translate({ intent: INTENT, ctx, locale: 'es' });
    expect(calls[1].user).toContain('owns lip-wine only as matte');
    expect(fallback[0].origin).toBe('editorial');
    renderable(fallback, ctx);
  });
});

describe('TranslationService.describe', () => {
  const recipe = editorialLooks(INTENT, NO_CTX, 'es')[1];

  it('uses the model text when valid', async () => {
    const text = { tagline: 'Noche de terciopelo', explanation: 'Tradujimos «jazz» en un párpado profundo y un labio cálido.', steps: steps(['eyes', 'cheeks', 'lips']) };
    const { svc } = service(text);
    expect(await svc.describe(recipe, INTENT, 'es')).toMatchObject({ tagline: 'Noche de terciopelo' });
  });

  it('falls back to template text derived from the recipe', async () => {
    const { svc } = service(new Error('down'), new Error('down'));
    const text = await svc.describe(recipe, INTENT, 'en');
    expect(text.explanation).toContain('bronze eyes');
    expect(text.steps.length).toBeGreaterThanOrEqual(3);
  });
});

describe('editorialLooks', () => {
  const kits: Kit[] = [
    EMPTY_KIT,
    { status: 'declared', items: { eyes: [{ shadeId: 'eye-sand', finish: 'metallic' }], lips: [{ shadeId: 'lip-cherry', finish: 'gloss' }], cheeks: [{ shadeId: 'cheek-peach', finish: 'matte' }] } },
  ];
  const sets: Constraint[][] = [[], ['noShadow'], ['noShine'], ['discreetLips'], ['noShadow', 'noShine', 'discreetLips']];

  it('is always valid for every constraint set and kit (renderable unless nothing is left)', () => {
    for (const kit of kits)
      for (const constraints of sets)
        for (const locale of ['es', 'en'] as const) {
          const ctx = { constraints, kit };
          const looks = editorialLooks(INTENT, ctx, locale);
          expect(looks).toHaveLength(3);
          for (const l of looks) {
            if (['eyes', 'lips', 'cheeks'].some((zone) => l[zone as 'eyes'].enabled)) expect(() => compileLook(l, ctx)).not.toThrow();
            expect(l.steps.length).toBeGreaterThanOrEqual(3);
          }
        }
  });
});
