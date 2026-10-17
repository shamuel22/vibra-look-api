import { Module } from '@nestjs/common';

import { TranslationModule } from '../translation/translation.module.js';
import { YoucamModule } from '../youcam/youcam.module.js';
import { RenderService } from './render.service.js';
import { SessionStore } from './session.store.js';
import { SessionsController } from './sessions.controller.js';

@Module({
  imports: [YoucamModule, TranslationModule],
  providers: [SessionStore, RenderService],
  controllers: [SessionsController],
  exports: [SessionStore],
})
export class SessionsModule {}
