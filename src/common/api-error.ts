/**
 * One error envelope for every failure the app sees:
 *   { "error": { "code": "...", "message": "...", "retriable": bool, "details"?: [...] } }
 * Messages are for developers; the app maps `code` to its own localized copy.
 */
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found' // unknown or expired session / render
  | 'selfie_required'
  | 'selfie_exists'
  | 'invalid_image'
  | 'look_rejected'
  | 'limit' // per-session or daily render cap
  | 'rate_limited'
  | 'busy' // too many concurrent sessions
  | 'not_ready'
  | 'upstream' // provider failure
  | 'internal';

export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: ApiErrorCode, message: string, retriable = false, details?: unknown) {
    super({ error: { code, message, retriable, ...(details === undefined ? {} : { details }) } }, status);
  }
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    if (exception instanceof ApiError) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof ThrottlerException) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests', retriable: true } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ApiErrorCode = status === 404 ? 'not_found' : status === 413 || status < 500 ? 'bad_request' : 'internal';
      res.status(status).json({ error: { code, message: exception.message, retriable: status >= 500 } });
      return;
    }
    // Body-parser errors (invalid JSON, payload too large) carry their own 4xx status.
    const status = (exception as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: 'bad_request', message: 'Invalid request body', retriable: false } });
      return;
    }
    this.log.error(`Unhandled: ${(exception as Error)?.name}: ${(exception as Error)?.message}`);
    res.status(500).json({ error: { code: 'internal', message: 'Internal error', retriable: true } });
  }
}
