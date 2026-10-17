/**
 * Operator smoke test: renders the sample looks (whisper, balance, statement — every finish)
 * through the real pipeline: compile → one upload → parallel tasks → poll → download → delete.
 * Costs 1 unit per look (3 by default).
 *   pnpm build && pnpm smoke:youcam <image.jpg> [outDir] [whisper,balance,statement]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { compileLook } from '../looks/look.compiler.js';
import { EMPTY_KIT, SAMPLE_LOOKS } from '../looks/look.fixtures.js';
import { YoucamClient } from '../youcam/youcam.client.js';

const [input, outDir = 'smoke-out', only] = process.argv.slice(2);
if (!input) {
  console.error('usage: pnpm smoke:youcam <image.jpg> [outDir] [whisper,balance,statement]');
  process.exit(2);
}
const looks = SAMPLE_LOOKS.filter((l) => !only || only.split(',').includes(l.variant));

const log = new Logger('Smoke');
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
const yc = app.get(YoucamClient);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
mkdirSync(outDir, { recursive: true });

async function render(fileId: string, look: (typeof looks)[number]): Promise<string> {
  const { effects } = compileLook(look, { constraints: [], kit: EMPTY_KIT });
  const taskId = await yc.startMakeup(fileId, effects);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const state = await yc.getMakeup(taskId);
    if (state.status === 'running') continue;
    if (state.status === 'error') {
      log.error(`${at()} ${look.variant}: task error ${JSON.stringify(state.error)}`);
      return taskId;
    }
    const { bytes } = await yc.download(state.resultUrl);
    const file = join(outDir, `${look.variant}.jpg`);
    writeFileSync(file, bytes);
    log.log(`${at()} ${look.variant}: success → ${file}`);
    return taskId;
  }
  log.error(`${at()} ${look.variant}: timed out`);
  return taskId;
}

const tasks: string[] = [];
try {
  log.log(`units before: ${await yc.unitBalance()}`);
  const { fileId } = await yc.uploadImage(new Uint8Array(readFileSync(input)), input.endsWith('.png') ? 'image/png' : 'image/jpeg');
  log.log(`${at()} uploaded once; rendering ${looks.map((l) => l.variant).join(', ')}`);
  const results = await Promise.allSettled(looks.map((l) => render(fileId, l)));
  for (const r of results) {
    if (r.status === 'fulfilled') tasks.push(r.value);
    else log.error(String(r.reason));
  }
} finally {
  // Deleting a task also removes the shared upload, so only at the very end.
  for (const id of tasks) await yc.deleteTask(id).catch((e: unknown) => log.warn(`delete failed: ${String(e)}`));
  log.log(`${at()} ${tasks.length} task(s) + files deleted`);
  log.log(`units after: ${await yc.unitBalance()}`);
  await app.close();
}
