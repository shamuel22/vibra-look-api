import { Controller, Get } from '@nestjs/common';

/** Liveness for the deploy (process manager / reverse proxy). Never calls YouCam. */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'vibralook-api', time: new Date().toISOString() };
  }
}
