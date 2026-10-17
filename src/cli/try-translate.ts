/**
 * Operator check of the vibe translation with the real model (no YouCam units).
 *   pnpm build && pnpm try:translate ["vibe"] [es|en]
 * Without a vibe, runs the three example vibes of the brief.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import type { Locale } from '../contracts/domain/types.js';
import { EMPTY_KIT } from '../looks/look.fixtures.js';
import { TranslationService } from '../translation/translation.service.js';

const [vibe, locale = 'es'] = process.argv.slice(2);
const vibes = vibe ? [vibe] : ['Sakura en una tarde lluviosa', 'reunión importante pero relajada', 'jazz en una azotea'];

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
const svc = app.get(TranslationService);
const log = new Logger('Translate');
try {
  for (const text of vibes) {
    const t0 = Date.now();
    const looks = await svc.translate({
      intent: { text, time: 10, intensity: 'balanced' },
      ctx: { constraints: [], kit: EMPTY_KIT },
      locale: locale as Locale,
    });
    log.log(`"${text}" → ${looks[0].origin} in ${Date.now() - t0}ms`);
    for (const l of looks) {
      const zones = (['eyes', 'lips', 'cheeks'] as const).map((z) => (l[z].enabled ? `${z}=${l[z].shadeId}/${l[z].finish}/${l[z].intensity}` : `${z}=off`));
      console.log(`  ${l.variant.padEnd(9)} ${zones.join('  ')}\n    ${l.tagline}\n    ${l.explanation}\n${l.steps.map((s) => `    - [${s.zone} ${s.minutes}m] ${s.text}`).join('\n')}`);
    }
  }
} finally {
  await app.close();
}
