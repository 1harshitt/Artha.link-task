/**
 * MongoDB index definitions and creation.
 * Indexes are critical for performance and correctness (unique constraints).
 */

import type { Db } from 'mongodb';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

const EVENTS_COLLECTION = 'events';
const JOBS_COLLECTION = 'jobs';

/**
 * Create all required indexes for the events and jobs collections.
 * Idempotent - safe to call multiple times.
 */
export async function createIndexes(db: Db): Promise<void> {
  logger.info('🔧 Creating MongoDB indexes...');

  await createEventsIndexes(db);
  await createJobsIndexes(db);

  logger.info('✅ MongoDB indexes created successfully');
}

/**
 * Events collection indexes.
 *
 * Reasoning:
 * 1. Compound unique index { tenantId, sourceId, eventId } enforces event identity.
 *    Prevents duplicate event insertion and enables efficient duplicate detection.
 *
 * 2. Index on { tenantId, sourceId, externalJobId, version } supports version lookups
 *    when checking if an incoming event is stale compared to current job state.
 *
 * 3. Compound index { status, claimedUntil } for atomic worker claim queries.
 *    Partial index where status='pending' reduces index size significantly since
 *    completed/failed events (majority) are excluded.
 *
 * 4. TTL index on { acceptedAt } for automatic cleanup after 7 days.
 *    Reduces storage and keeps working set in memory.
 */
async function createEventsIndexes(db: Db): Promise<void> {
  const collection = db.collection(EVENTS_COLLECTION);

  // Event identity - unique constraint
  await collection.createIndex(
    { tenantId: 1, sourceId: 1, eventId: 1 },
    {
      name: 'event_identity_unique',
      unique: true,
    }
  );

  // Version lookup for staleness checking
  await collection.createIndex(
    { tenantId: 1, sourceId: 1, externalJobId: 1, version: 1 },
    {
      name: 'job_version_lookup',
    }
  );

  // Worker claim query - partial index for pending events only
  await collection.createIndex(
    { status: 1, claimedUntil: 1 },
    {
      name: 'worker_claim',
      partialFilterExpression: { status: 'pending' },
    }
  );

  // Add acceptedAt to claim index for FIFO ordering
  await collection.createIndex(
    { status: 1, claimedUntil: 1, acceptedAt: 1 },
    {
      name: 'worker_claim_fifo',
      partialFilterExpression: { status: 'pending' },
    }
  );

  // TTL index for automatic cleanup after 7 days
  const ttlSeconds = env.EVENT_TTL_DAYS * 24 * 60 * 60;
  await collection.createIndex(
    { acceptedAt: 1 },
    {
      name: 'event_ttl',
      expireAfterSeconds: ttlSeconds,
    }
  );

  logger.debug('Created events collection indexes');
}

/**
 * Jobs collection indexes.
 *
 * Reasoning:
 * 1. Compound unique index { tenantId, sourceId, externalJobId } enforces job identity
 *    and enables efficient job lookups and version-guarded updates.
 *
 * 2. Compound index { tenantId, status, _id } supports paginated list queries with
 *    cursor-based pagination using _id (stable, monotonic).
 *
 * 3. Compound index { tenantId, sourceId, status, _id } for source-filtered lists.
 */
async function createJobsIndexes(db: Db): Promise<void> {
  const collection = db.collection(JOBS_COLLECTION);

  // Job identity - unique constraint
  await collection.createIndex(
    { tenantId: 1, sourceId: 1, externalJobId: 1 },
    {
      name: 'job_identity_unique',
      unique: true,
    }
  );

  // List query - tenant + status + cursor pagination
  await collection.createIndex(
    { tenantId: 1, status: 1, _id: 1 },
    {
      name: 'job_list_tenant_status',
    }
  );

  // List query - tenant + source + status + cursor pagination
  await collection.createIndex(
    { tenantId: 1, sourceId: 1, status: 1, _id: 1 },
    {
      name: 'job_list_tenant_source_status',
    }
  );

  logger.debug('Created jobs collection indexes');
}

/**
 * Drop all indexes (useful for testing).
 * WARNING: This will impact performance until indexes are recreated.
 */
export async function dropIndexes(db: Db): Promise<void> {
  logger.warn('🗑️  Dropping all indexes...');

  await db.collection(EVENTS_COLLECTION).dropIndexes();
  await db.collection(JOBS_COLLECTION).dropIndexes();

  logger.warn('⚠️  Indexes dropped');
}
