/**
 * HTTP API used by the app. Every route except `POST /v1/sessions` needs the session's bearer
 * token. Bodies are validated with the shared wire schemas; errors use the `ApiError` envelope.
 *
 *   POST   /v1/sessions                              → { sessionId, token, expiresAt }
 *   PUT    /v1/sessions/:id/selfie   (image/jpeg|png) → { status: 'valid' } | 422 { issue }
 *   POST   /v1/sessions/:id/looks    { intent, constraints, kit, locale } → { variants }
 *   POST   /v1/sessions/:id/describe { recipe, intent, constraints, kit, locale } → { tagline, explanation, steps }
 *   POST   /v1/sessions/:id/renders  { recipe, constraints, kit } → 202 RenderStatus
 *   GET    /v1/sessions/:id/renders/:recipeId        → RenderStatus
 *   GET    /v1/sessions/:id/renders/:recipeId/image  → image/jpeg
 *   DELETE /v1/sessions/:id                          → 204 (YouCam tasks and files deleted)
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { ApiError } from '../common/api-error.js';
import { lookRecipeSchema, userIntentSchema } from '../contracts/wire.js';
import { checkContext, checkRecipe, type LookContext } from '../looks/look.validator.js';
import { TranslationService } from '../translation/translation.service.js';
import { RenderService } from './render.service.js';
import { checkSelfie, SELFIE_MAX_BYTES } from './selfie.js';
import { SessionStore, type RenderEntry, type Session } from './session.store.js';

const localeSchema = z.enum(['es', 'en']);

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

function context(body: { constraints?: unknown; kit?: unknown }): LookContext {
  const ctx = checkContext({ constraints: body.constraints, kit: body.kit });
  if (!ctx.ok) throw new ApiError(HttpStatus.BAD_REQUEST, 'bad_request', 'Invalid constraints or kit', false, ctx.problems);
  return ctx.value;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ApiError(HttpStatus.BAD_REQUEST, 'bad_request', `Invalid ${what}`, false, details);
  }
  return r.data;
}

/** Per-session caps on model-backed requests (each may make 2 model calls with its retry). */
const LLM_CAPS = { translations: 6, describes: 40 } as const;

/** Reads a raw body up to `max` bytes; `null` if it is larger (the rest is not buffered). */
function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.removeAllListeners('data');
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(size > max ? null : new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/** Aborts model work when the app stops waiting (closed connection before the response). */
function disconnectSignal(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}

const renderView = (e: RenderEntry) => ({ recipeId: e.recipeId, status: e.status, ...(e.error ? { error: e.error } : {}) });

@Controller('v1/sessions')
export class SessionsController {
  constructor(
    private readonly store: SessionStore,
    private readonly renders: RenderService,
    private readonly translation: TranslationService,
  ) {}

  private session(id: string, req: Request): Session {
    return this.store.get(id, bearer(req));
  }

  /** Model-backed requests need a session with a selfie and stay within its per-session cap. */
  private llmSession(id: string, req: Request, kind: 'translations' | 'describes'): Session {
    const s = this.session(id, req);
    if (!s.selfie && !s.fileId) throw new ApiError(HttpStatus.CONFLICT, 'selfie_required', 'Upload the selfie first', false);
    if (s[kind] >= LLM_CAPS[kind]) throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'limit', 'Limit reached for this session', false);
    s[kind] += 1;
    return s;
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 10 * 60_000 } })
  create() {
    const { session, token, expiresAt } = this.store.create();
    return { sessionId: session.id, token, expiresAt };
  }

  @Put(':id/selfie')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async selfie(@Param('id') id: string, @Req() req: Request) {
    // Authenticate before reading a single byte of the body.
    const s = this.session(id, req);
    if (s.selfie || s.fileId) throw new ApiError(HttpStatus.CONFLICT, 'selfie_exists', 'This session already has a selfie; start a new session', false);
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    if (type !== 'image/jpeg' && type !== 'image/png') {
      throw new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'invalid_image', 'Send the image bytes as image/jpeg or image/png', false, { issue: 'unsupported' });
    }
    const bytes = await readBody(req, SELFIE_MAX_BYTES);
    if (!bytes) throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, 'invalid_image', 'Image too large', false, { issue: 'unsupported' });
    const check = checkSelfie(bytes);
    if (!check.ok) throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_image', 'Image not accepted', false, { issue: check.issue });
    if (s.closed) throw new ApiError(HttpStatus.NOT_FOUND, 'not_found', 'Session not found or expired', false);
    // Uploaded privately to YouCam with the first render (see RenderService).
    s.selfie = { bytes, contentType: check.contentType };
    return { status: 'valid', expiresAt: this.store.expiresAt(s) };
  }

  @Post(':id/looks')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async looks(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    this.llmSession(id, req, 'translations');
    const intent = parse(userIntentSchema, body?.intent, 'intent');
    const locale = parse(localeSchema, body?.locale, 'locale');
    const variants = await this.translation.translate({ intent, ctx: context(body ?? {}), locale }, disconnectSignal(res));
    return { variants };
  }

  @Post(':id/describe')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async describe(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    this.llmSession(id, req, 'describes');
    const intent = parse(userIntentSchema, body?.intent, 'intent');
    const locale = parse(localeSchema, body?.locale, 'locale');
    const ctx = context(body ?? {});
    // Text is only written for a recipe that could be rendered as-is.
    const checked = checkRecipe(body?.recipe, ctx);
    if (!checked.ok && checked.problems.some((p) => p.kind !== 'noActiveZone')) {
      throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'look_rejected', 'The look breaks a rule', false, checked.problems);
    }
    const recipe = checked.ok ? checked.value : lookRecipeSchema.parse(body.recipe);
    return this.translation.describe(recipe, intent, locale, disconnectSignal(res));
  }

  @Post(':id/renders')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  startRender(@Param('id') id: string, @Req() req: Request, @Body() body: Record<string, unknown>) {
    return renderView(this.renders.start(this.session(id, req), body ?? {}));
  }

  @Get(':id/renders/:recipeId')
  renderStatus(@Param('id') id: string, @Param('recipeId') recipeId: string, @Req() req: Request) {
    return renderView(this.renders.status(this.session(id, req), recipeId));
  }

  @Get(':id/renders/:recipeId/image')
  async renderImage(@Param('id') id: string, @Param('recipeId') recipeId: string, @Req() req: Request, @Res() res: Response) {
    const bytes = await this.renders.image(this.session(id, req), recipeId);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(bytes));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async close(@Param('id') id: string, @Req() req: Request) {
    await this.store.close(this.session(id, req));
  }
}
