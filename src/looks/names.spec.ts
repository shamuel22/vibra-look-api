import { describe, expect, it } from 'vitest';

import { SHADES } from '../contracts/domain/shades.js';
import { shadeName } from './names.js';

describe('names', () => {
  it('names every shade of the library in both languages', () => {
    for (const s of SHADES) for (const locale of ['es', 'en'] as const) expect(shadeName(locale, s.nameKey)).toMatch(/\S/);
  });
});
