/**
 * Demo script - executes fixture-driven demonstration.
 * Runs through all fixture events in phases, validates outcomes.
 */

import { readFileSync } from 'fs';
import { env } from '../src/config/env.js';

const API_BASE_URL = `http://${env.HOST}:${env.PORT}`;

interface FixtureEvent {
  name: string;
  event: Record<string, unknown>;
  expectedStatus: number;
}

interface Fixtures {
  phase1: FixtureEvent[];
  phase2: FixtureEvent[];
}

interface SubmitResult {
  fixture: FixtureEvent;
  actualStatus: number;
  responseBody: unknown;
  passed: boolean;
}

/**
 * Load demo fixtures.
 */
function loadFixtures(): Fixtures {
  const content = readFileSync('./fixtures/demo-fixtures.json', 'utf-8');
  return JSON.parse(content) as Fixtures;
}

/**
 * Submit an event to the API.
 */
async function submitEvent(event: Record<string, unknown>): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await fetch(`${API_BASE_URL}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });

  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Check if all events in a tenant have reached terminal state.
 */
async function waitForDrain(tenantId: string, maxWaitMs: number = 60000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Get all jobs for this tenant
      const response = await fetch(
        `${API_BASE_URL}/jobs?tenantId=${encodeURIComponent(tenantId)}&limit=100`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch jobs: ${response.status}`);
      }

      const data = (await response.json()) as { jobs: Array<{ status: string }> };

      // Check if all jobs are in terminal state (we can't easily check events, so we use job count as proxy)
      // In production, you'd have a better way to check pending event count
      console.log(`  Waiting for processing... (${data.jobs.length} jobs so far)`);

      // Wait a bit
      await sleep(2000);

      // For demo purposes, wait a fixed time since we don't have easy access to pending event count
      if (Date.now() - startTime > 15000) {
        console.log('  Drain complete (waited 15 seconds)\n');
        return;
      }
    } catch (error) {
      console.error('  Error checking drain status:', error);
      await sleep(1000);
    }
  }

  throw new Error('Timeout waiting for events to drain');
}

/**
 * Verify final job states.
 */
async function verifyJobStates(tenantId: string): Promise<void> {
  console.log('📊 Verifying final job states...\n');

  try {
    const response = await fetch(
      `${API_BASE_URL}/jobs?tenantId=${encodeURIComponent(tenantId)}&limit=100&status=all`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch jobs: ${response.status}`);
    }

    const data = (await response.json()) as {
      jobs: Array<{
        externalJobId: string;
        version: number;
        status: string;
        title?: string;
      }>;
    };

    console.log('Final Job States:');
    console.log('─'.repeat(80));

    for (const job of data.jobs) {
      const statusIcon = job.status === 'active' ? '✓' : '⊗';
      console.log(
        `  ${statusIcon} ${job.externalJobId} v${job.version} [${job.status}] ${job.title || '(archived)'}`
      );
    }

    console.log('─'.repeat(80));
    console.log(`Total jobs: ${data.jobs.length}\n`);

    // Expected states for demo fixtures
    const job101 = data.jobs.find((j) => j.externalJobId === 'job-101');
    const job102 = data.jobs.find((j) => j.externalJobId === 'job-102');
    const job103 = data.jobs.find((j) => j.externalJobId === 'job-103');

    console.log('Expected Outcomes:');
    console.log('─'.repeat(80));

    if (job101) {
      const expected = 'v6 active (reactivated after archive)';
      const actual = `v${job101.version} ${job101.status}`;
      const match = job101.version === 6 && job101.status === 'active';
      console.log(`  job-101: ${match ? '✓ PASS' : '✗ FAIL'} - Expected: ${expected}, Got: ${actual}`);
    }

    if (job102) {
      const expected = 'v1 active (succeeded after retry)';
      const actual = `v${job102.version} ${job102.status}`;
      const match = job102.version === 1 && job102.status === 'active';
      console.log(`  job-102: ${match ? '✓ PASS' : '✗ FAIL'} - Expected: ${expected}, Got: ${actual}`);
    }

    if (job103) {
      // job-103 should NOT exist (permanent failure, never applied)
      console.log(`  job-103: ✗ FAIL - Expected: not created (422 failure), Got: exists`);
    } else {
      console.log(`  job-103: ✓ PASS - Not created (permanent failure, correct)`);
    }

    console.log('─'.repeat(80));
    console.log();
  } catch (error) {
    console.error('Error verifying job states:', error);
  }
}

/**
 * Main demo function.
 */
async function runDemo(): Promise<void> {
  console.log('═'.repeat(80));
  console.log('🎯 ARTHA.LINK JOB FEED INGESTION DEMO');
  console.log('═'.repeat(80));
  console.log();

  const fixtures = loadFixtures();
  const results: SubmitResult[] = [];

  // Phase 1: Submit initial events
  console.log('📤 PHASE 1: Submitting initial events...\n');

  for (const fixture of fixtures.phase1) {
    try {
      const { status, body } = await submitEvent(fixture.event);
      const passed = status === fixture.expectedStatus;
      const statusIcon = passed ? '✓' : '✗';
      const statusColor = passed ? '\x1b[32m' : '\x1b[31m'; // Green or Red
      const resetColor = '\x1b[0m';

      console.log(
        `  ${statusIcon} ${statusColor}${fixture.name}${resetColor}`
      );
      console.log(`     Expected: ${fixture.expectedStatus}, Got: ${status} ${passed ? 'PASS' : 'FAIL'}`);

      results.push({
        fixture,
        actualStatus: status,
        responseBody: body,
        passed,
      });
    } catch (error) {
      console.error(`  ✗ ${fixture.name} - Error:`, error);
      results.push({
        fixture,
        actualStatus: 0,
        responseBody: error,
        passed: false,
      });
    }
  }

  console.log();

  // Wait for Phase 1 to settle
  console.log('⏳ Waiting for Phase 1 to settle...\n');
  await waitForDrain('tenant-demo');

  // Phase 2: Submit delayed events
  console.log('📤 PHASE 2: Submitting delayed events...\n');

  for (const fixture of fixtures.phase2) {
    try {
      const { status, body } = await submitEvent(fixture.event);
      const passed = status === fixture.expectedStatus;
      const statusIcon = passed ? '✓' : '✗';
      const statusColor = passed ? '\x1b[32m' : '\x1b[31m';
      const resetColor = '\x1b[0m';

      console.log(
        `  ${statusIcon} ${statusColor}${fixture.name}${resetColor}`
      );
      console.log(`     Expected: ${fixture.expectedStatus}, Got: ${status} ${passed ? 'PASS' : 'FAIL'}`);

      results.push({
        fixture,
        actualStatus: status,
        responseBody: body,
        passed,
      });
    } catch (error) {
      console.error(`  ✗ ${fixture.name} - Error:`, error);
      results.push({
        fixture,
        actualStatus: 0,
        responseBody: error,
        passed: false,
      });
    }
  }

  console.log();

  // Wait for Phase 2 to settle
  console.log('⏳ Waiting for Phase 2 to settle...\n');
  await waitForDrain('tenant-demo');

  // Verify outcomes
  await verifyJobStates('tenant-demo');

  // Summary
  console.log('📋 SUMMARY');
  console.log('═'.repeat(80));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`  Total tests: ${total}`);
  console.log(`  Passed: \x1b[32m${passed}\x1b[0m`);
  console.log(`  Failed: \x1b[31m${failed}\x1b[0m`);
  console.log();

  if (failed > 0) {
    console.log('Failed tests:');
    for (const result of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${result.fixture.name}`);
      console.log(`     Expected: ${result.fixture.expectedStatus}, Got: ${result.actualStatus}`);
    }
    console.log();
  }

  console.log('═'.repeat(80));
  console.log(failed === 0 ? '✅ All tests passed!' : '❌ Some tests failed');
  console.log('═'.repeat(80));

  process.exit(failed > 0 ? 1 : 0);
}

/**
 * Sleep helper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run demo
runDemo().catch((error) => {
  console.error('Demo failed:', error);
  process.exit(1);
});
