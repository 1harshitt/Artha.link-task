/**
 * Background worker for processing job events.
 * Handles atomic work claiming, provider verification, and job projection updates.
 */

import { randomUUID } from 'crypto';
import type { WorkItem, WorkResult, JobProjection } from '../domain/types.js';
import { shouldSkipVerification } from '../domain/eventLogic.js';
import * as EventRepo from '../infra/EventRepository.js';
import * as JobRepo from '../infra/JobRepository.js';
import { verifyJobWithProvider } from '../infra/ProviderClient.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class Worker {
  private workerId: string;
  private running: boolean = false;
  private currentWorkItem: WorkItem | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(name?: string) {
    this.workerId = name || `worker-${randomUUID()}`;
  }

  /**
   * Start the worker polling loop.
   * Continuously claims and processes work until stopped.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Worker already running', { workerId: this.workerId });
      return;
    }

    this.running = true;
    logger.info('🚀 Worker started', { workerId: this.workerId });

    // Main polling loop
    while (this.running) {
      try {
        await this.pollAndProcess();
      } catch (error) {
        logger.error('Worker polling error', {
          workerId: this.workerId,
          error: error instanceof Error ? error.message : String(error),
        });

        // Sleep before retry to avoid tight error loop
        await this.sleep(1000);
      }
    }

    logger.info('✅ Worker stopped', { workerId: this.workerId });
  }

  /**
   * Stop the worker gracefully.
   * Finishes current work item before stopping.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info('🛑 Stopping worker...', { workerId: this.workerId });
    this.running = false;

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Wait for current work to finish (with timeout)
    const maxWait = 30000; // 30 seconds
    const start = Date.now();
    while (this.currentWorkItem && Date.now() - start < maxWait) {
      await this.sleep(100);
    }

    if (this.currentWorkItem) {
      logger.warn('Worker stopped with unfinished work', {
        workerId: this.workerId,
        eventId: this.currentWorkItem.eventId,
      });
    }
  }

  /**
   * Check if worker is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get worker ID.
   */
  getWorkerId(): string {
    return this.workerId;
  }

  /**
   * Poll for work and process one item.
   */
  private async pollAndProcess(): Promise<void> {
    // Claim work atomically
    const workItem = await EventRepo.claimWork(this.workerId, env.WORKER_CLAIM_DURATION_MS);

    if (!workItem) {
      // No work available - sleep before next poll
      await this.sleep(env.WORKER_POLL_INTERVAL_MS);
      return;
    }

    // Process the work item
    this.currentWorkItem = workItem;
    try {
      await this.processWorkItem(workItem);
    } finally {
      this.currentWorkItem = null;
    }
  }

  /**
   * Process a single work item.
   *
   * Steps:
   * 1. Re-fetch current job state to check staleness
   * 2. If stale, mark and skip verification
   * 3. If not stale, verify with provider (with retries)
   * 4. On success, update job projection
   * 5. On failure, retry or mark as failed
   */
  private async processWorkItem(item: WorkItem): Promise<void> {
    logger.debug('Processing work item', {
      workerId: this.workerId,
      eventId: item.eventId,
      version: item.version,
      attempts: item.attempts,
    });

    // Start heartbeat to extend claim during long operations
    this.startHeartbeat(item.eventId);

    try {
      // Step 1: Check if event is stale
      const currentJob = await JobRepo.getJob(item.tenantId, item.sourceId, item.externalJobId);
      const currentVersion = currentJob?.version ?? null;

      if (shouldSkipVerification(item, currentVersion)) {
        // Event is stale - no need to verify or update
        const result: WorkResult = {
          type: 'stale',
          reason: `Version ${item.version} is stale (current: ${currentVersion})`,
        };

        await EventRepo.completeWork(item.eventId, this.workerId, result);

        logger.info('✓ Work item marked as stale', {
          eventId: item.eventId,
          version: item.version,
          currentVersion,
        });

        return;
      }

      // Step 2: Record attempt start (so crash consumes an attempt)
      await EventRepo.recordAttemptStart(item.eventId, this.workerId);

      // Step 3: Verify with provider
      const verifyResult = await verifyJobWithProvider(item.tenantId, item.externalJobId);

      // Step 4: Handle verification result
      if (verifyResult.type === 'verified' || verifyResult.type === 'not_found') {
        // Success - update job projection
        await this.applyJobProjection(item);

        // Mark event as completed
        await EventRepo.recordAttemptOutcome(item.eventId, item.attempts, 'success');
        await EventRepo.completeWork(item.eventId, this.workerId, { type: 'completed' });

        logger.info('✓ Work item completed successfully', {
          eventId: item.eventId,
          version: item.version,
          operation: item.operation,
        });
      } else if (verifyResult.type === 'permanent_failure') {
        // Permanent failure - don't retry
        await EventRepo.recordAttemptOutcome(
          item.eventId,
          item.attempts,
          'permanent_failure',
          verifyResult.message
        );

        const result: WorkResult = {
          type: 'failed',
          error: `Provider verification failed: ${verifyResult.message}`,
          retriable: false,
        };

        await EventRepo.completeWork(item.eventId, this.workerId, result);

        logger.warn('✗ Work item failed permanently', {
          eventId: item.eventId,
          error: verifyResult.message,
        });
      } else if (verifyResult.type === 'retriable_error') {
        // Retriable error - check if we should retry
        await EventRepo.recordAttemptOutcome(
          item.eventId,
          item.attempts,
          'retriable_error',
          verifyResult.message
        );

        if (item.attempts >= env.WORKER_MAX_ATTEMPTS) {
          // Max attempts exhausted
          const result: WorkResult = {
            type: 'failed',
            error: `Max attempts (${env.WORKER_MAX_ATTEMPTS}) exhausted. Last error: ${verifyResult.message}`,
            retriable: false,
          };

          await EventRepo.completeWork(item.eventId, this.workerId, result);

          logger.warn('✗ Work item failed after max attempts', {
            eventId: item.eventId,
            attempts: item.attempts,
            lastError: verifyResult.message,
          });
        } else {
          // Release back to pending for retry
          await EventRepo.releaseWork(item.eventId, this.workerId);

          // Exponential backoff delay before next attempt
          const delayMs = env.WORKER_RETRY_BASE_DELAY_MS * Math.pow(2, item.attempts - 1);
          logger.info('⟳ Work item released for retry', {
            eventId: item.eventId,
            attempts: item.attempts,
            nextRetryDelayMs: delayMs,
          });

          // Sleep before releasing claim so another worker doesn't immediately reclaim
          await this.sleep(delayMs);
        }
      }
    } catch (error) {
      // Unexpected error during processing
      logger.error('Worker processing error', {
        workerId: this.workerId,
        eventId: item.eventId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Release work back to pending for another worker to try
      try {
        await EventRepo.releaseWork(item.eventId, this.workerId);
      } catch (releaseError) {
        logger.error('Failed to release work after error', {
          eventId: item.eventId,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
    } finally {
      this.stopHeartbeat();
    }
  }

  /**
   * Apply job projection update based on event operation.
   */
  private async applyJobProjection(item: WorkItem): Promise<void> {
    if (item.operation === 'upsert') {
      if (!item.payload) {
        throw new Error('Upsert operation missing payload');
      }

      const job: JobProjection = {
        tenantId: item.tenantId,
        sourceId: item.sourceId,
        externalJobId: item.externalJobId,
        version: item.version,
        status: 'active',
        title: item.payload.title,
        company: item.payload.company,
        location: item.payload.location,
        experienceMin: item.payload.experienceMin,
        experienceMax: item.payload.experienceMax,
        skills: item.payload.skills,
        applyUrl: item.payload.applyUrl,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await JobRepo.upsertJobProjection(job);
    } else if (item.operation === 'archive') {
      const job: JobProjection = {
        tenantId: item.tenantId,
        sourceId: item.sourceId,
        externalJobId: item.externalJobId,
        version: item.version,
        status: 'archived',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await JobRepo.upsertJobProjection(job);
    }
  }

  /**
   * Start heartbeat to extend claim during long operations.
   */
  private startHeartbeat(eventId: string): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Extend claim every 10 seconds (well before the 30s timeout)
    this.heartbeatInterval = setInterval(async () => {
      try {
        const extended = await EventRepo.extendClaim(
          eventId,
          this.workerId,
          env.WORKER_CLAIM_DURATION_MS
        );

        if (!extended) {
          logger.warn('Failed to extend claim - may have been reclaimed', {
            eventId,
            workerId: this.workerId,
          });
        }
      } catch (error) {
        logger.error('Heartbeat error', {
          eventId,
          workerId: this.workerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 10000);
  }

  /**
   * Stop heartbeat.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
