/**
 * Human names for the shade library, finishes, variants and intensity preferences, in the
 * app's two languages. Copied from the app's i18n (`src/i18n/{es,en}.ts` → `shades`,
 * `finishes`, `variants`, `intent.intensity`); `names.spec.ts` fails if a shade is missing.
 * Used in prompts (the model must call colors what the app calls them) and editorial text.
 */
import type { Finish, IntensityPreference, Locale, VariantKey, Zone } from '../contracts/domain/types.js';

export const SHADE_NAMES: Record<Locale, Record<string, string>> = {
  es: {
    lipNudeRose: 'nude rosado',
    lipMauve: 'rosa malva',
    lipDustyPink: 'rosa empolvado',
    lipSoftCoral: 'coral suave',
    lipTerracotta: 'terracota',
    lipCherry: 'rojo cereza',
    lipWine: 'vino',
    lipPlum: 'ciruela',
    eyeChampagne: 'champán',
    eyeSand: 'arena',
    eyeTaupe: 'taupe',
    eyeBronze: 'bronce',
    eyeLavender: 'lavanda',
    eyeMauve: 'malva',
    eyeSmokyPlum: 'ciruela ahumada',
    eyeChocolate: 'chocolate',
    cheekPetal: 'rosa pétalo',
    cheekPeach: 'durazno',
    cheekCoral: 'coral',
    cheekSoftMauve: 'malva suave',
    cheekBrickRose: 'rosa ladrillo',
    cheekTerracotta: 'terracota',
  },
  en: {
    lipNudeRose: 'rosy nude',
    lipMauve: 'mauve pink',
    lipDustyPink: 'dusty pink',
    lipSoftCoral: 'soft coral',
    lipTerracotta: 'terracotta',
    lipCherry: 'cherry red',
    lipWine: 'wine',
    lipPlum: 'plum',
    eyeChampagne: 'champagne',
    eyeSand: 'sand',
    eyeTaupe: 'taupe',
    eyeBronze: 'bronze',
    eyeLavender: 'lavender',
    eyeMauve: 'mauve',
    eyeSmokyPlum: 'smoky plum',
    eyeChocolate: 'chocolate',
    cheekPetal: 'petal pink',
    cheekPeach: 'peach',
    cheekCoral: 'coral',
    cheekSoftMauve: 'soft mauve',
    cheekBrickRose: 'brick rose',
    cheekTerracotta: 'terracotta',
  },
};

export const FINISH_NAMES: Record<Locale, Record<Finish, string>> = {
  es: { matte: 'mate', satin: 'satinado', gloss: 'brillo', metallic: 'metálico', luminous: 'luminoso' },
  en: { matte: 'matte', satin: 'satin', gloss: 'gloss', metallic: 'metallic', luminous: 'luminous' },
};

export const VARIANT_NAMES: Record<Locale, Record<VariantKey, string>> = {
  es: { whisper: 'Susurro', balance: 'Equilibrio', statement: 'Declaración' },
  en: { whisper: 'Whisper', balance: 'Balance', statement: 'Statement' },
};

export const INTENSITY_NAMES: Record<Locale, Record<IntensityPreference, string>> = {
  es: { subtle: 'sutil', balanced: 'equilibrada', expressive: 'expresiva' },
  en: { subtle: 'subtle', balanced: 'balanced', expressive: 'expressive' },
};

export const ZONE_NAMES: Record<Locale, Record<Zone, string>> = {
  es: { eyes: 'ojos', lips: 'labios', cheeks: 'mejillas' },
  en: { eyes: 'eyes', lips: 'lips', cheeks: 'cheeks' },
};

/** `shades.lipMauve` → `rosa malva`. */
export function shadeName(locale: Locale, nameKey: string): string {
  const key = nameKey.replace(/^shades\./, '');
  const name = SHADE_NAMES[locale][key];
  if (!name) throw new Error(`Missing shade name: ${nameKey}`);
  return name;
}
