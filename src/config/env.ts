import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Load .env file manually (no external dotenv dependency needed).
 * Only runs in non-production — production injects env vars directly.
 */
function loadDotenv(): void {
  if (process.env['NODE_ENV'] === 'production') return;
  try {
    const envPath = resolve(process.cwd(), '.env');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // Only set if not already set (process env takes precedence)
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — rely on process environment
  }
}

loadDotenv();

/**
 * Environment variable schema with strict validation.
 * All configuration must pass through this schema before use.
 */
const envSchema = z.object({
  // Server Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // MongoDB Configuration
  MONGODB_URI: z.string().url(),
  MONGODB_DATABASE: z.string().min(1),

  // Worker Configuration
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  WORKER_CLAIM_DURATION_MS: z.coerce.number().int().positive().default(30000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),

  // Provider Verification
  PROVIDER_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  PROVIDER_FIXTURE_PATH: z.string().default('./fixtures/provider-plan.json'),

  // Event Retention
  EVENT_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 * Throws a descriptive error if validation fails.
 */
export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.format();
    console.error('❌ Invalid environment configuration:', errors);
    throw new Error('Environment validation failed');
  }

  return result.data;
}

/**
 * Singleton environment configuration.
 * Loaded once at application startup.
 */
export const env = loadEnv();
