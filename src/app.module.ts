import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { YoucamModule } from './youcam/youcam.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }), YoucamModule],
  controllers: [HealthController],
})
export class AppModule {}
