/**
 * What each zone may use for one request, derived from the person's constraints and kit with
 * the app's own rules. The prompt, the per-request output schema, the assembler and the
 * editorial fallback all read this, so they can never disagree.
 */
import { allowedFinishes, isFinishAllowed, isZoneAllowed, maxIntensity } from '../contracts/domain/constraints.js';
import { shadesForZone } from '../contracts/domain/shades.js';
import { ZONES, type Finish, type Zone, type ZoneIntensity } from '../contracts/domain/types.js';
import type { LookContext } from '../looks/look.validator.js';

export type ZoneRules =
  | { available: false; reason: 'constraint' | 'notInKit'; allShades: string[] }
  | {
      available: true;
      allShades: string[];
      /** Shades the recipe may use (the kit's, when declared). */
      shades: string[];
      finishes: Finish[];
      maxIntensity: ZoneIntensity;
      /** Declared kit only: the finishes the person owns for each shade. */
      kitFinishes?: Record<string, Finish[]>;
    };

export function zoneRules(zone: Zone, ctx: LookContext): ZoneRules {
  const allShades = shadesForZone(zone).map((s) => s.id);
  if (!isZoneAllowed(zone, ctx.constraints)) return { available: false, reason: 'constraint', allShades };
  const max = maxIntensity(zone, ctx.constraints);

  if (ctx.kit.status !== 'declared') {
    return { available: true, allShades, shades: allShades, finishes: allowedFinishes(zone, ctx.constraints), maxIntensity: max };
  }
  const usable = ctx.kit.items[zone].filter((i) => isFinishAllowed(i.finish, ctx.constraints));
  if (usable.length === 0) return { available: false, reason: 'notInKit', allShades };
  const kitFinishes: Record<string, Finish[]> = {};
  for (const item of usable) (kitFinishes[item.shadeId] ??= []).push(item.finish);
  return {
    available: true,
    allShades,
    shades: Object.keys(kitFinishes),
    finishes: [...new Set(usable.map((i) => i.finish))],
    maxIntensity: max,
    kitFinishes,
  };
}

export function allZoneRules(ctx: LookContext): Record<Zone, ZoneRules> {
  return Object.fromEntries(ZONES.map((z) => [z, zoneRules(z, ctx)])) as Record<Zone, ZoneRules>;
}
