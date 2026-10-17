/**
 * Operator smoke test: one real YouCam render through the API's own client
 * (upload → task → poll → download → delete). Costs 1 unit.
 *   pnpm build && pnpm smoke:youcam <image.jpg> [out.jpg]
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { YoucamClient } from '../youcam/youcam.client.js';
import type { MakeupEffect } from '../youcam/youcam.types.js';

const [input, output = 'smoke-result.jpg'] = process.argv.slice(2);
if (!input) {
  console.error('usage: pnpm smoke:youcam <image.jpg> [out.jpg]');
  process.exit(2);
}

const log = new Logger('Smoke');
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
const yc = app.get(YoucamClient);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const effects: MakeupEffect[] = [
  { category: 'skin_smooth', skinSmoothStrength: 0, skinSmoothColorIntensity: 0 },
  { category: 'eye_shadow', pattern: { name: '1color1' }, palettes: [{ color: '#9D6E86', texture: 'matte', colorIntensity: 55 }] },
  { category: 'blush', pattern: { name: '1color1' }, palettes: [{ color: '#C98E9E', texture: 'matte', colorIntensity: 45 }] },
  {
    category: 'lip_color',
    shape: { name: 'original' },
    morphology: { fullness: 0, wrinkless: 0 },
    style: { type: 'full' },
    palettes: [{ color: '#B5737E', texture: 'satin', colorIntensity: 70 }],
  },
];

let taskId: string | undefined;
try {
  log.log(`units before: ${await yc.unitBalance()}`);
  const { fileId } = await yc.uploadImage(new Uint8Array(readFileSync(input)), input.endsWith('.png') ? 'image/png' : 'image/jpeg');
  log.log(`${at()} uploaded`);
  taskId = await yc.startMakeup(fileId, effects);
  log.log(`${at()} task started`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const state = await yc.getMakeup(taskId);
    if (state.status === 'running') continue;
    if (state.status === 'error') throw new Error(`task error: ${JSON.stringify(state.error)}`);
    const { bytes } = await yc.download(state.resultUrl);
    writeFileSync(output, bytes);
    log.log(`${at()} success → ${output} (${bytes.byteLength} bytes)`);
    break;
  }
} finally {
  if (taskId) {
    await yc.deleteTask(taskId);
    log.log(`${at()} task + files deleted`);
  }
  log.log(`units after: ${await yc.unitBalance()}`);
  await app.close();
}
