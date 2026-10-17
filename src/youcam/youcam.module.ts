import { Module } from '@nestjs/common';

import { YoucamClient } from './youcam.client.js';

@Module({
  providers: [YoucamClient],
  exports: [YoucamClient],
})
export class YoucamModule {}
