import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { ApiErrorFilter } from './common/api-error.js';
import { validateEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { TranslationModule } from './translation/translation.module.js';
import { YoucamModule } from './youcam/youcam.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    // Per client IP. Polling 3 renders every 1.5 s stays well under the default.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    YoucamModule,
    TranslationModule,
    SessionsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: ApiErrorFilter },
  ],
})
export class AppModule {}
