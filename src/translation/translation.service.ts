/**
 * Vibe translation (brief §6): the model interprets, deterministic code decides.
 *
 *   model → schema (per-request enums) → assembler checks → 1 retry with feedback
 *         → editorial recipe labelled as such
 *
 * `describe` rewrites tagline/explanation/steps for an edited recipe with the same pipeline,
 * falling back to deterministic template text.
 */
import { Injectable, Logger } from '@nestjs/common';

import { ZONES, type Locale, type LookRecipe, type UserIntent } from '../contracts/domain/types.js';
import type { LookContext } from '../looks/look.validator.js';
import { assembleLooks, assembleText } from './assemble.js';
import { editorialLooks } from './editorial.js';
import { LlmClient } from './llm.client.js';
import { describeSystemPrompt, describeUserMessage, looksSystemPrompt, looksUserMessage } from './prompt.js';
import { allZoneRules } from './rules.js';
import { describeOutSchema, looksOutSchema, toToolSchema } from './schemas.js';
import { templateText, type RecipeText } from './templates.js';

/** Per attempt; two attempts stay under the proxy's 75 s read timeout. */
const LOOKS_TIMEOUT_MS = 22_000;
const DESCRIBE_TIMEOUT_MS = 12_000;

export interface TranslateRequest {
  intent: UserIntent;
  ctx: LookContext;
  locale: Locale;
}

@Injectable()
export class TranslationService {
  private readonly log = new Logger(TranslationService.name);

  constructor(private readonly llm: LlmClient) {}

  /** Three recipes in VARIANTS order; never throws for model problems (editorial fallback). */
  async translate({ intent, ctx, locale }: TranslateRequest, signal?: AbortSignal): Promise<LookRecipe[]> {
    const rules = allZoneRules(ctx);
    // Nothing can be applied: no model call, honest editorial text explains why.
    if (ZONES.every((z) => !rules[z].available)) return editorialLooks(intent, ctx, locale);

    const schema = looksOutSchema(rules);
    const tool = {
      name: 'submit_looks',
      description: 'Submit the three makeup looks (whisper, balance, statement) for this vibe.',
      inputSchema: toToolSchema(schema),
    };
    let feedback: string[] | undefined;
    for (let attempt = 1; attempt <= 2 && this.llm.configured; attempt++) {
      try {
        const raw = await this.llm.callTool({
          system: looksSystemPrompt(locale),
          user: looksUserMessage(intent, ctx.constraints, ctx.kit, rules, locale, feedback),
          tool,
          maxTokens: 3000,
          temperature: 0.8,
          timeoutMs: LOOKS_TIMEOUT_MS,
          signal,
        });
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          feedback = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`);
        } else {
          const assembled = assembleLooks(parsed.data, rules, ctx, intent);
          if (assembled.ok) return assembled.value;
          feedback = assembled.problems.slice(0, 8);
        }
        // Problems describe structure only (never the person's words).
        this.log.warn(`translate attempt ${attempt} rejected: ${feedback.join(' | ')}`);
      } catch (e) {
        if (signal?.aborted) throw e;
        this.log.warn(`translate attempt ${attempt} failed: ${(e as Error).message}`);
        feedback = undefined;
      }
    }
    this.log.warn('translate: using editorial recipes');
    return editorialLooks(intent, ctx, locale);
  }

  /** Text for an (edited) recipe; never throws for model problems (template fallback). */
  async describe(recipe: LookRecipe, intent: UserIntent, locale: Locale, signal?: AbortSignal): Promise<RecipeText> {
    const fallback = () => templateText(recipe, intent, locale);
    if (ZONES.every((z) => !recipe[z].enabled)) return fallback();
    const tool = {
      name: 'submit_text',
      description: 'Submit the tagline, explanation and steps for this exact look.',
      inputSchema: toToolSchema(describeOutSchema),
    };
    let feedback: string[] | undefined;
    for (let attempt = 1; attempt <= 2 && this.llm.configured; attempt++) {
      try {
        const raw = await this.llm.callTool({
          system: describeSystemPrompt(locale),
          user: describeUserMessage(recipe, intent, locale, feedback),
          tool,
          maxTokens: 1200,
          temperature: 0.6,
          timeoutMs: DESCRIBE_TIMEOUT_MS,
          signal,
        });
        const parsed = describeOutSchema.safeParse(raw);
        if (!parsed.success) {
          feedback = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`);
        } else {
          const assembled = assembleText(parsed.data, recipe, intent);
          if (assembled.ok) return assembled.value;
          feedback = assembled.problems.slice(0, 8);
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        feedback = undefined;
      }
    }
    return fallback();
  }
}
