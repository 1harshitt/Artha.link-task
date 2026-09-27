/**
 * Load test script - measures performance and validates concurrency.
 * Generates synthetic events and measures throughput.
 */

import os from 'os';
import { env } from '../src/config/env.js';

const API_BASE_URL = `http://${env.HOST}:${env.PORT}`;
const TENANT_ID = 'load-test';
const SOURCE_ID = 'load-feed';

interface LoadTestConfig {
  uniqueEvents: number;
  replayEvents: number;
  outOfOrderJobs: number;
  concurrency: number;
}

interface LoadTestResult {
  submitted: number;
  accepted: number;
  duplicates: number;
  errors: number;
  httpP50Ms: number;
  httpP95Ms: number;
  httpP99Ms: number;
  drainTimeMs: number;
  finalJobs: number;
  activeJobs: number;
}

/**
 * Generate a random job event.
 */
function generateEvent(eventId: string, externalJobId: string, version: number): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    sourceId: SOURCE_ID,
    eventId,
    externalJobId,
    version,
    operation: 'upsert',
    payload: {
      title: `Software Engineer ${externalJobId}`,
      company: `Company ${Math.floor(Math.random() * 100)}`,
      location: ['Remote', 'San Francisco', 'New York', 'London'][Math.floor(Math.random() * 4)],
      experienceMin: Math.floor(Math.random() * 5),
      experienceMax: Math.floor(Math.random() * 10) + 5,
      skills: ['TypeScript', 'MongoDB', 'React', 'Node.js'].slice(0, Math.floor(Math.random() * 4) + 1),
      applyUrl: `https://example.com/apply/${externalJobId}`,
    },
  };
}

/**
 * Submit an event and measure latency.
 */
async function submitEvent(event: Record<string, unknown>): Promise<{
  status: number;
  latencyMs: number;
}> {
  const start = Date.now();

  try {
    const response = await fetch(`${API_BASE_URL}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });

    const latencyMs = Date.now() - start;
    return { status: response.status, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - start;
    return { status: 0, latencyMs };
  }
}

/**
 * Submit events in batches with controlled concurrency.
 */
async function submitBatch(
  events: Array<Record<string, unknown>>,
  concurrency: number
): Promise<Array<{ status: number; latencyMs: number }>> {
  const results: Array<{ status: number; latencyMs: number }> = [];
  const queue = [...events];

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const event = queue.shift();
      if (!event) break;

      const result = await submitEvent(event);
      results.push(result);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Wait for all events to be processed.
 */
async function waitForDrain(_tenantId: string): Promise<number> {
  const startTime = Date.now();

  // Simple approach: wait for fixed time since we don't have direct pending count
  // In production, you'd poll an internal metrics endpoint
  await sleep(30000); // 30 seconds

  return Date.now() - startTime;
}

/**
 * Get all jobs for a tenant.
 */
async function getAllJobs(tenantId: string): Promise<Array<{ status: string; externalJobId: string; version: number }>> {
  const jobs: Array<{ status: string; externalJobId: string; version: number }> = [];
  let cursor: string | null = null;

  while (true) {
    const url = cursor
      ? `${API_BASE_URL}/jobs?tenantId=${encodeURIComponent(tenantId)}&limit=100&cursor=${encodeURIComponent(cursor)}`
      : `${API_BASE_URL}/jobs?tenantId=${encodeURIComponent(tenantId)}&limit=100`;

    const response = await fetch(url);
    if (!response.ok) break;

    const data = (await response.json()) as {
      jobs: Array<{ status: string; externalJobId: string; version: number }>;
      nextCursor: string | null;
    };

    jobs.push(...data.jobs);

    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }

  return jobs;
}

/**
 * Calculate percentile from sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Run load test.
 */
async function runLoad(config: LoadTestConfig): Promise<LoadTestResult> {
  console.log('═'.repeat(80));
  console.log('🔥 ARTHA.LINK LOAD TEST');
  console.log('═'.repeat(80));
  console.log();
  console.log('Configuration:');
  console.log(`  Unique events: ${config.uniqueEvents}`);
  console.log(`  Replay events: ${config.replayEvents}`);
  console.log(`  Out-of-order jobs: ${config.outOfOrderJobs}`);
  console.log(`  Concurrency: ${config.concurrency}`);
  console.log();

  // Phase 1: Generate unique events
  console.log('📝 Generating test data...');
  const uniqueEvents: Array<Record<string, unknown>> = [];

  for (let i = 0; i < config.uniqueEvents; i++) {
    const eventId = `load-event-${i}`;
    const externalJobId = `load-job-${i}`;
    uniqueEvents.push(generateEvent(eventId, externalJobId, 1));
  }

  // Phase 2: Generate out-of-order events (v3, v1, v2 for same job)
  const outOfOrderEvents: Array<Record<string, unknown>> = [];

  for (let i = 0; i < config.outOfOrderJobs; i++) {
    const externalJobId = `load-job-${i}`;
    outOfOrderEvents.push(generateEvent(`load-event-${i}-v3`, externalJobId, 3));
    outOfOrderEvents.push(generateEvent(`load-event-${i}-v1`, externalJobId, 1));
    outOfOrderEvents.push(generateEvent(`load-event-${i}-v2`, externalJobId, 2));
  }

  console.log(`  Generated ${uniqueEvents.length + outOfOrderEvents.length} events`);
  console.log();

  // Phase 3: Submit all events
  console.log('📤 Submitting events...');
  const startTime = Date.now();

  const allEvents = [...uniqueEvents, ...outOfOrderEvents];
  const results = await submitBatch(allEvents, config.concurrency);

  const submitTimeMs = Date.now() - startTime;
  console.log(`  Submitted ${results.length} events in ${submitTimeMs}ms`);
  console.log(`  Throughput: ${Math.round((results.length / submitTimeMs) * 1000)} events/sec`);
  console.log();

  // Phase 4: Generate and submit replays
  console.log('📤 Submitting replay events...');
  const replayEvents = uniqueEvents.slice(0, config.replayEvents);
  const replayResults = await submitBatch(replayEvents, config.concurrency);
  console.log(`  Submitted ${replayResults.length} replays`);
  console.log();

  // Phase 5: Wait for drain
  console.log('⏳ Waiting for processing to complete...');
  const drainTimeMs = await waitForDrain(TENANT_ID);
  console.log(`  Drained in ${drainTimeMs}ms`);
  console.log();

  // Phase 6: Fetch final job states
  console.log('📊 Fetching final job states...');
  const jobs = await getAllJobs(TENANT_ID);
  console.log(`  Retrieved ${jobs.length} jobs`);
  console.log();

  // Calculate metrics
  const allResults = [...results, ...replayResults];
  const latencies = allResults.map((r) => r.latencyMs).sort((a, b) => a - b);

  const accepted = results.filter((r) => r.status === 202).length;
  const duplicates = replayResults.filter((r) => r.status === 200).length;
  const errors = allResults.filter((r) => r.status >= 400 || r.status === 0).length;

  // Verify out-of-order correctness
  let outOfOrderCorrect = 0;
  for (let i = 0; i < config.outOfOrderJobs; i++) {
    const externalJobId = `load-job-${i}`;
    const job = jobs.find((j) => j.externalJobId === externalJobId);
    if (job && job.version === 3) {
      outOfOrderCorrect++;
    }
  }

  const result: LoadTestResult = {
    submitted: results.length,
    accepted,
    duplicates,
    errors,
    httpP50Ms: percentile(latencies, 50),
    httpP95Ms: percentile(latencies, 95),
    httpP99Ms: percentile(latencies, 99),
    drainTimeMs,
    finalJobs: jobs.length,
    activeJobs: jobs.filter((j) => j.status === 'active').length,
  };

  // Print results
  console.log('═'.repeat(80));
  console.log('📊 RESULTS');
  console.log('═'.repeat(80));
  console.log();
  console.log('Environment:');
  console.log(`  Machine: ${os.hostname()}`);
  console.log(`  CPUs: ${os.cpus().length}`);
  console.log(`  Node: ${process.version}`);
  console.log(`  Platform: ${os.platform()}`);
  console.log();
  console.log('HTTP Performance:');
  console.log(`  Submitted: ${result.submitted}`);
  console.log(`  Accepted (202): ${result.accepted}`);
  console.log(`  Duplicates (200): ${result.duplicates}`);
  console.log(`  Errors: ${result.errors}`);
  console.log(`  HTTP P50: ${result.httpP50Ms}ms`);
  console.log(`  HTTP P95: ${result.httpP95Ms}ms`);
  console.log(`  HTTP P99: ${result.httpP99Ms}ms`);
  console.log();
  console.log('Processing:');
  console.log(`  Drain time: ${result.drainTimeMs}ms`);
  console.log(`  Final jobs: ${result.finalJobs}`);
  console.log(`  Active jobs: ${result.activeJobs}`);
  console.log();
  console.log('Correctness:');
  console.log(`  Out-of-order correct: ${outOfOrderCorrect}/${config.outOfOrderJobs} (expecting v3 to win)`);
  console.log();
  console.log('═'.repeat(80));
  console.log();

  return result;
}

/**
 * Sleep helper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run load test
const config: LoadTestConfig = {
  uniqueEvents: 1000,
  replayEvents: 200,
  outOfOrderJobs: 50,
  concurrency: 50,
};

runLoad(config).catch((error) => {
  console.error('Load test failed:', error);
  process.exit(1);
});
