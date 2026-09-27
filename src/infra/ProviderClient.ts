/**
 * Provider verification client.
 * Simulates external provider API calls using fixture data.
 */

import { readFileSync } from 'fs';
import type { VerificationResult } from '../domain/types.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Provider fixture data structure.
 */
interface ProviderFixture {
  [externalJobId: string]: {
    status: number;
    message?: string;
  };
}

let fixtureData: ProviderFixture | null = null;

/**
 * Load provider fixture data.
 * In production, this would be replaced with actual HTTP calls.
 */
function loadFixture(): ProviderFixture {
  if (fixtureData) {
    return fixtureData;
  }

  try {
    const content = readFileSync(env.PROVIDER_FIXTURE_PATH, 'utf-8');
    fixtureData = JSON.parse(content) as ProviderFixture;
    logger.info('✅ Provider fixture loaded', {
      path: env.PROVIDER_FIXTURE_PATH,
      jobCount: Object.keys(fixtureData).length,
    });
    return fixtureData;
  } catch (error) {
    logger.warn('⚠️  Provider fixture not found - all jobs will verify successfully', {
      path: env.PROVIDER_FIXTURE_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
    fixtureData = {};
    return fixtureData;
  }
}

/**
 * Verify a job with the external provider.
 *
 * HTTP Response Handling:
 * - 200: Job verified, proceed with update
 * - 404: Job not found at provider (treat as success for this assignment)
 * - 429/503: Retriable error (rate limit, service unavailable)
 * - 422: Permanent failure (validation error, don't retry)
 * - Other 4xx/5xx: Retriable (could be transient)
 *
 * Production considerations:
 * - Replace fixture lookup with actual HTTP client (axios/fetch)
 * - Add circuit breaker for provider outages
 * - Add timeout and retry logic at this layer
 * - Track provider latency and error rates
 */
export async function verifyJobWithProvider(
  tenantId: string,
  externalJobId: string
): Promise<VerificationResult> {
  const fixture = loadFixture();
  const entry = fixture[externalJobId];

  // Simulate network delay
  await sleep(10);

  if (!entry) {
    // Job not in fixture - default to success
    logger.debug('Provider verification: not in fixture (default success)', {
      tenantId,
      externalJobId,
    });
    return { type: 'verified' };
  }

  const { status, message } = entry;

  logger.debug('Provider verification response', {
    tenantId,
    externalJobId,
    status,
  });

  // Map HTTP status to verification result
  if (status === 200) {
    return { type: 'verified' };
  }

  if (status === 404) {
    return { type: 'not_found' };
  }

  if (status === 422) {
    return {
      type: 'permanent_failure',
      statusCode: status,
      message: message || 'Validation error',
    };
  }

  if (status === 429 || status === 503) {
    return {
      type: 'retriable_error',
      statusCode: status,
      message: message || 'Service temporarily unavailable',
    };
  }

  // Other errors - treat as retriable
  if (status >= 400) {
    return {
      type: 'retriable_error',
      statusCode: status,
      message: message || 'Provider error',
    };
  }

  // Unexpected status - treat as verified
  return { type: 'verified' };
}

/**
 * Sleep helper for simulating network delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clear cached fixture data (useful for testing).
 */
export function clearFixtureCache(): void {
  fixtureData = null;
}
