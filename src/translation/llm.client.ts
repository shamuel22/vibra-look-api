/**
 * Language model client: DeepSeek through its Anthropic-compatible Messages endpoint
 * (https://api.deepseek.com/anthropic, model `deepseek-flash`).
 *
 * Verified behaviour (17-oct-2026): a forced `tool_choice` returns the tool input as structured
 * JSON, but only with thinking disabled (thinking mode rejects forced tool choice). The key
 * stays server-side and prompts/answers are never logged (they contain the person's words).
 */
import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.js';

export interface ToolCall {
  system: string;
  user: string;
  tool: { name: string; description: string; inputSchema: Record<string, unknown> & { type: 'object' } };
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export class LlmUnavailableError extends Error {
  constructor(reason: string) {
    super(`LLM unavailable: ${reason}`);
    this.name = 'LlmUnavailableError';
  }
}

@Injectable()
export class LlmClient {
  private readonly log = new Logger(LlmClient.name);
  private readonly client: Anthropic | null;
  private readonly model: string;
  private readonly dailyLimit: number;
  private day = '';
  private callsToday = 0;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('DEEPSEEK_API_KEY', { infer: true });
    this.model = config.get('DEEPSEEK_MODEL', { infer: true });
    this.dailyLimit = config.get('DAILY_LLM_LIMIT', { infer: true });
    this.client = apiKey
      ? // Retries are decided by TranslationService (one, with feedback), never stacked here.
        new Anthropic({ apiKey, baseURL: config.get('DEEPSEEK_BASE_URL', { infer: true }), maxRetries: 0 })
      : null;
    if (!apiKey) this.log.warn('DEEPSEEK_API_KEY not set: translations use editorial recipes only');
  }

  get configured(): boolean {
    return this.client !== null;
  }

  /** Forces one tool call and returns its raw input (validated by the caller). */
  async callTool(call: ToolCall): Promise<unknown> {
    if (!this.client) throw new LlmUnavailableError('not configured');
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.callsToday = 0;
    }
    if (this.callsToday >= this.dailyLimit) throw new LlmUnavailableError('daily limit reached');
    this.callsToday += 1;
    const started = Date.now();
    try {
      const msg = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: call.maxTokens,
          temperature: call.temperature,
          thinking: { type: 'disabled' },
          system: call.system,
          messages: [{ role: 'user', content: call.user }],
          tools: [{ name: call.tool.name, description: call.tool.description, input_schema: call.tool.inputSchema }],
          tool_choice: { type: 'tool', name: call.tool.name },
        },
        { timeout: call.timeoutMs, signal: call.signal },
      );
      const block = msg.content.find((b) => b.type === 'tool_use' && b.name === call.tool.name);
      this.log.log(`${call.tool.name} ${Date.now() - started}ms in=${msg.usage.input_tokens} out=${msg.usage.output_tokens} stop=${msg.stop_reason}`);
      if (!block || block.type !== 'tool_use') throw new LlmUnavailableError(`no tool call (stop=${msg.stop_reason})`);
      return block.input;
    } catch (e) {
      if (e instanceof LlmUnavailableError) throw e;
      const status = e instanceof Anthropic.APIError ? e.status : undefined;
      this.log.warn(`${call.tool.name} failed after ${Date.now() - started}ms: ${(e as Error).name}${status ? ` ${status}` : ''}`);
      throw new LlmUnavailableError((e as Error).name);
    }
  }
}
