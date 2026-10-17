import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { YoucamClient } from './youcam/youcam.client.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const log = new Logger('Bootstrap');
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.disable('x-powered-by');
  // Live render state must never be answered from an HTTP cache (no ETag / 304).
  app.set('etag', false);
  const proxies = config.get('TRUST_PROXY', { infer: true });
  if (proxies > 0) app.set('trust proxy', proxies);
  // JSON only; the selfie body is read by its route after authentication (bounded).
  app.useBodyParser('json', { limit: '256kb' });
  const http = new Logger('Http');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const started = Date.now();
    // Access log without session ids, tokens, bodies or client IPs.
    res.on('finish', () => {
      if (req.path === '/health') return;
      const route = req.path.replace(/^\/v1\/sessions\/[^/]+/, '/v1/sessions/:id').replace(/\/renders\/[^/]+/, '/renders/:recipe');
      http.log(`${req.method} ${route} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  const host = config.get('HOST', { infer: true });
  await app.listen(port, host);
  log.log(`vibralook-api listening on ${host}:${port}`);

  // Operator visibility only; the API works without it.
  app
    .get(YoucamClient)
    .unitBalance()
    .then((units) => (units < 50 ? log.warn(`YouCam units low: ${units}`) : log.log(`YouCam units: ${units}`)))
    .catch(() => log.warn('YouCam unit balance unavailable'));
}
await bootstrap();
