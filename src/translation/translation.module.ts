import { Module } from '@nestjs/common';

import { LlmClient } from './llm.client.js';
import { TranslationService } from './translation.service.js';

@Module({
  providers: [LlmClient, TranslationService],
  exports: [TranslationService],
})
export class TranslationModule {}
