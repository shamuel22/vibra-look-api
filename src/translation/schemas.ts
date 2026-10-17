/**
 * Output schemas for the language model, built per request from the zone rules so the model
 * can only choose shades, finishes and intensities that are allowed for this person.
 * The same zod schema validates the answer and (as JSON Schema) defines the forced tool.
 */
import { z } from 'zod';

import { VARIANTS, ZONES, type Zone } from '../contracts/domain/types.js';
import type { ZoneRules } from './rules.js';

const nonEmpty = <T extends string>(values: T[]) => values as [T, ...T[]];

function zoneOut(rules: ZoneRules) {
  if (!rules.available) return z.strictObject({ enabled: z.literal(false) });
  return z.strictObject({
    enabled: z.literal(true),
    shadeId: z.enum(nonEmpty(rules.shades)),
    finish: z.enum(nonEmpty(rules.finishes)),
    intensity: z.number().int().min(1).max(rules.maxIntensity),
  });
}

export const stepOut = z.strictObject({
  zone: z.enum(['prep', 'eyes', 'cheeks', 'lips', 'finish']),
  text: z.string().min(5).max(200),
  minutes: z.number().int().min(1).max(10),
});

export const textOut = {
  tagline: z.string().min(3).max(90),
  explanation: z.string().min(20).max(360),
  steps: z.array(stepOut).min(3).max(5),
};

export function looksOutSchema(rules: Record<Zone, ZoneRules>) {
  const zones = Object.fromEntries(ZONES.map((zone) => [zone, zoneOut(rules[zone])])) as {
    [K in Zone]: ReturnType<typeof zoneOut>;
  };
  const look = z.strictObject({
    variant: z.enum(nonEmpty([...VARIANTS])),
    ...zones,
    ...textOut,
    kitShortfall: z.boolean(),
  });
  return z.strictObject({ looks: z.array(look).length(3) });
}

export type LooksOut = z.infer<ReturnType<typeof looksOutSchema>>;
export type LookOut = LooksOut['looks'][number];

export const describeOutSchema = z.strictObject(textOut);
export type DescribeOut = z.infer<typeof describeOutSchema>;

/** JSON Schema for a tool's `input_schema` (root must be an object). */
export function toToolSchema(schema: z.ZodType): Record<string, unknown> & { type: 'object' } {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  return json as Record<string, unknown> & { type: 'object' };
}
