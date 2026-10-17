/**
 * Environment contract. The process refuses to start with a missing or malformed value,
 * so a misconfigured deploy fails loudly instead of failing on the first user request.
 */
import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  YOUCAM_API_KEY: z.string().min(20, 'YOUCAM_API_KEY is required'),
  YOUCAM_BASE_URL: z.url().default('https://yce-api-01.makeupar.com'),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  MAX_RENDERS_PER_SESSION: z.coerce.number().int().min(3).max(50).default(12),
  // Vibe translation (F2.3): DeepSeek through its Anthropic-compatible Messages endpoint.
  DEEPSEEK_API_KEY: z.string().min(20).optional(),
  DEEPSEEK_BASE_URL: z.url().default('https://api.deepseek.com/anthropic'),
  DEEPSEEK_MODEL: z.string().min(1).default('deepseek-flash'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    // Never echo values: only the names and reasons of what is wrong.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}
