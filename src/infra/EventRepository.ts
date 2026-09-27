/**
 * Event repository - atomic operations for event acceptance and work claiming.
 * All operations are scoped by tenantId for isolation.
 */

import { Collection } from 'mongodb';
import type {
  ValidatedEvent,
  EventRecord,
  WorkItem,
  AcceptResult,
  WorkResult,
  EventStatus,
} from '../domain/types.js';
import { isExactReplay } from '../domain/eventLogic.js';
import { getDb } from './mongodb.js';
import { logger } from '../utils/logger.js';

const COLLECTION_NAME = 'events';

function getCollection(): Collection<EventRecord> {
  return getDb().collection<EventRecord>(COLLECTION_NAME);
}

/**
 * Accept an event for processing.
 *
 * Atomicity guarantee:
 * - Single insertOne operation — atomic by MongoDB guarantee
 * - On duplicate key error, re-fetch and distinguish duplicate vs conflict
 * - Invalid events NEVER reserve an event ID (validation happens first)
 *
 * Returns:
 * - 'accepted': Event inserted successfully, ready for processing
 * - 'duplicate': Exact replay of existing event (idempotent)
 * - 'conflict': Event ID reused with different content (error)
 */
export async function acceptEvent(event: ValidatedEvent): Promise<AcceptResult> {
  const collection = getCollection();

  // Build event record — payload only present for upsert
  const record: EventRecord = {
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    eventId: event.eventId,
    externalJobId: event.externalJobId,
    version: event.version,
    operation: event.operation,
    ...(event.operation === 'upsert' ? { payload: event.payload } : {}),
    status: 'pending',
    attempts: 0,
    attemptHistory: [],
    acceptedAt: new Date(),
  };

  try {
    const result = await collection.insertOne(record);

    logger.debug('Event accepted', {
      eventId: event.eventId,
      tenantId: event.tenantId,
      insertedId: result.insertedId.toString(),
    });

    return { type: 'accepted', eventId: event.eventId };
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      // Re-fetch to distinguish duplicate vs conflict
      const existing = await collection.findOne({
        tenantId: event.tenantId,
        sourceId: event.sourceId,
        eventId: event.eventId,
      });

      if (!existing) {
        // Race: inserted then deleted — treat as available
        logger.warn('Event not found after duplicate key error — race condition', { eventId: event.eventId });
        return { type: 'accepted', eventId: event.eventId };
      }

      if (isExactReplay(existing, event)) {
        logger.debug('Event duplicate (exact replay)', { eventId: event.eventId, status: existing.status });
        return { type: 'duplicate', eventId: event.eventId, status: existing.status };
      }

      logger.warn('Event conflict (ID reused with different content)', { eventId: event.eventId });
      return { type: 'conflict', eventId: event.eventId, message: 'Event ID reused with different content' };
    }

    throw error;
  }
}

/**
 * Claim a pending event for processing (atomic).
 *
 * Uses findOneAndUpdate — only ONE worker can claim each event.
 * FIFO ordering via sort: { acceptedAt: 1 }.
 */
export async function claimWork(workerId: string, claimDurationMs: number): Promise<WorkItem | null> {
  const collection = getCollection();
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + claimDurationMs);

  const result = await collection.findOneAndUpdate(
    {
      status: 'pending',
      $or: [
        { claimedUntil: { $exists: false } },
        { claimedUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'processing' as EventStatus,
        claimedBy: workerId,
        claimedUntil,
        startedAt: now,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { acceptedAt: 1 }, // FIFO — oldest events first
      returnDocument: 'after',
    }
  );

  if (!result) return null;

  logger.debug('Work claimed', { eventId: result.eventId, workerId, attempts: result.attempts });

  return {
    eventId: result.eventId,
    tenantId: result.tenantId,
    sourceId: result.sourceId,
    externalJobId: result.externalJobId,
    version: result.version,
    operation: result.operation,
    ...(result.payload !== undefined ? { payload: result.payload } : {}),
    attempts: result.attempts,
    claimedBy: workerId,
    claimedUntil: result.claimedUntil!,
  };
}

/**
 * Extend the claim on a work item (heartbeat).
 */
export async function extendClaim(
  eventId: string,
  workerId: string,
  claimDurationMs: number
): Promise<boolean> {
  const collection = getCollection();
  const claimedUntil = new Date(Date.now() + claimDurationMs);

  const result = await collection.updateOne(
    { eventId, claimedBy: workerId, status: 'processing' },
    { $set: { claimedUntil } }
  );

  return result.modifiedCount > 0;
}

/**
 * Release a work item back to pending (recovery path).
 */
export async function releaseWork(eventId: string, workerId: string): Promise<void> {
  const collection = getCollection();

  await collection.updateOne(
    { eventId, claimedBy: workerId, status: 'processing' },
    {
      $set: { status: 'pending' as EventStatus, claimedUntil: new Date(0) },
      $unset: { claimedBy: '' },
    }
  );

  logger.debug('Work released back to pending', { eventId, workerId });
}

/**
 * Mark work as completed, stale, or failed.
 */
export async function completeWork(
  eventId: string,
  workerId: string,
  result: WorkResult
): Promise<void> {
  const collection = getCollection();
  const now = new Date();

  let status: EventStatus;
  let lastError: string | undefined;

  switch (result.type) {
    case 'completed':
      status = 'completed';
      break;
    case 'stale':
      status = 'stale';
      lastError = result.reason;
      break;
    case 'failed':
      status = 'failed';
      lastError = result.error;
      break;
  }

  await collection.updateOne(
    { eventId, claimedBy: workerId },
    {
      $set: {
        status,
        completedAt: now,
        ...(lastError !== undefined ? { lastError } : {}),
      },
    }
  );

  logger.debug('Work completed', { eventId, workerId, status });
}

/**
 * Record attempt start in attempt history.
 * Called BEFORE provider verification so a crash consumes an attempt.
 */
export async function recordAttemptStart(eventId: string, workerId: string): Promise<void> {
  const collection = getCollection();
  const now = new Date();

  const event = await collection.findOne({ eventId });
  if (!event) return;

  await collection.updateOne(
    { eventId },
    {
      $push: {
        attemptHistory: {
          $each: [{
            attemptNumber: event.attempts,
            workerId,
            startedAt: now,
            outcome: 'crash' as const,
          }],
        },
      },
    }
  );
}

/**
 * Update the outcome of the current attempt.
 */
export async function recordAttemptOutcome(
  eventId: string,
  attemptNumber: number,
  outcome: 'success' | 'retriable_error' | 'permanent_failure',
  error?: string
): Promise<void> {
  const collection = getCollection();
  const now = new Date();

  await collection.updateOne(
    { eventId, 'attemptHistory.attemptNumber': attemptNumber },
    {
      $set: {
        'attemptHistory.$.completedAt': now,
        'attemptHistory.$.outcome': outcome,
        ...(error !== undefined ? { 'attemptHistory.$.error': error } : {}),
      },
    }
  );
}

/**
 * Get event by identity (scoped by tenant).
 */
export async function getEvent(
  tenantId: string,
  sourceId: string,
  eventId: string
): Promise<EventRecord | null> {
  const collection = getCollection();
  return collection.findOne({ tenantId, sourceId, eventId });
}

/**
 * Get events by external job ID (for version lookups).
 */
export async function getEventsByJob(
  tenantId: string,
  sourceId: string,
  externalJobId: string
): Promise<EventRecord[]> {
  const collection = getCollection();
  return collection.find({ tenantId, sourceId, externalJobId }).sort({ version: -1 }).toArray();
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
