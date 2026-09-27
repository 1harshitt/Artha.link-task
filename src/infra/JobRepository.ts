/**
 * Job repository - version-guarded job projection updates.
 * Ensures highest version always wins, regardless of processing order.
 */

import { Collection, ObjectId } from 'mongodb';
import type { JobProjection, JobStatus, ListJobsParams, JobListResponse } from '../domain/types.js';
import { getDb } from './mongodb.js';
import { logger } from '../utils/logger.js';

const COLLECTION_NAME = 'jobs';

function getCollection(): Collection<JobProjection> {
  return getDb().collection<JobProjection>(COLLECTION_NAME);
}

/**
 * Upsert a job projection with version guard.
 *
 * CRITICAL: Filter uses $lt so only higher versions can update.
 * Equal version is a no-op — safe for worker retries after crash.
 *
 * For archive: status='archived', job detail fields are unset.
 * Archive is a versioned tombstone — old upserts cannot reactivate.
 */
export async function upsertJobProjection(job: JobProjection): Promise<void> {
  const collection = getCollection();
  const now = new Date();

  // Build $set payload
  const setFields: Record<string, unknown> = {
    tenantId: job.tenantId,
    sourceId: job.sourceId,
    externalJobId: job.externalJobId,
    version: job.version,
    status: job.status,
    updatedAt: now,
  };

  // Include job detail fields for active jobs
  if (job.status === 'active') {
    if (job.title !== undefined) setFields['title'] = job.title;
    if (job.company !== undefined) setFields['company'] = job.company;
    if (job.location !== undefined) setFields['location'] = job.location;
    if (job.experienceMin !== undefined) setFields['experienceMin'] = job.experienceMin;
    if (job.experienceMax !== undefined) setFields['experienceMax'] = job.experienceMax;
    if (job.skills !== undefined) setFields['skills'] = job.skills;
    if (job.applyUrl !== undefined) setFields['applyUrl'] = job.applyUrl;
  }

  // For archive, unset job detail fields
  const unsetFields: Record<string, ''> = {};
  if (job.status === 'archived') {
    unsetFields['title'] = '';
    unsetFields['company'] = '';
    unsetFields['location'] = '';
    unsetFields['experienceMin'] = '';
    unsetFields['experienceMax'] = '';
    unsetFields['skills'] = '';
    unsetFields['applyUrl'] = '';
  }

  const updateDoc: Record<string, unknown> = {
    $set: setFields,
    $setOnInsert: { createdAt: now },
  };

  if (Object.keys(unsetFields).length > 0) {
    updateDoc['$unset'] = unsetFields;
  }

  try {
    const result = await collection.findOneAndUpdate(
      {
        tenantId: job.tenantId,
        sourceId: job.sourceId,
        externalJobId: job.externalJobId,
        $or: [
          { version: { $lt: job.version } },
          { version: { $exists: false } },
        ],
      },
      updateDoc,
      { upsert: true, returnDocument: 'after' }
    );

    if (result) {
      logger.debug('Job projection updated', { externalJobId: job.externalJobId, version: job.version, status: job.status });
    } else {
      logger.debug('Job projection not updated (stale version)', { externalJobId: job.externalJobId, version: job.version });
    }
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      logger.debug('Duplicate key on job upsert — retrying without $setOnInsert', { externalJobId: job.externalJobId });

      const retryUpdate: Record<string, unknown> = { $set: setFields };
      if (Object.keys(unsetFields).length > 0) retryUpdate['$unset'] = unsetFields;

      await collection.updateOne(
        {
          tenantId: job.tenantId,
          sourceId: job.sourceId,
          externalJobId: job.externalJobId,
          version: { $lt: job.version },
        },
        retryUpdate
      );
    } else {
      throw error;
    }
  }
}

/**
 * Get a single job by identity (scoped by tenant).
 */
export async function getJob(
  tenantId: string,
  sourceId: string,
  externalJobId: string
): Promise<JobProjection | null> {
  const collection = getCollection();
  return collection.findOne({ tenantId, sourceId, externalJobId });
}

/**
 * List jobs with cursor-based pagination.
 *
 * Pagination notes:
 * - Uses _id as cursor (stable, monotonic)
 * - No total count (expensive full scan at scale)
 * - New jobs after cursor are missed (acceptable)
 */
export async function listJobs(params: ListJobsParams): Promise<JobListResponse> {
  const collection = getCollection();

  const filter: Record<string, unknown> = { tenantId: params.tenantId };

  if (params.sourceId !== undefined) {
    filter['sourceId'] = params.sourceId;
  }

  if (params.status !== undefined && params.status !== 'all') {
    filter['status'] = params.status;
  }

  if (params.cursor !== undefined) {
    try {
      const cursorId = new ObjectId(params.cursor);
      filter['_id'] = { $gt: cursorId };
    } catch {
      logger.warn('Invalid pagination cursor', { cursor: params.cursor });
    }
  }

  const limit = params.limit ?? 20;
  const jobs = await collection.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();

  let nextCursor: string | null = null;
  if (jobs.length > limit) {
    const lastJob = jobs[limit - 1];
    const lastId = lastJob?._id;
    nextCursor = lastId !== undefined ? String(lastId) : null;
    jobs.pop();
  }

  return { jobs: jobs.slice(0, limit), nextCursor };
}

/**
 * Get all jobs for a tenant (demo/testing only).
 */
export async function getAllJobs(tenantId: string): Promise<JobProjection[]> {
  const collection = getCollection();
  return collection.find({ tenantId }).toArray();
}

/**
 * Count jobs by status (for monitoring).
 */
export async function countJobsByStatus(tenantId: string): Promise<Record<JobStatus, number>> {
  const collection = getCollection();

  const [active, archived] = await Promise.all([
    collection.countDocuments({ tenantId, status: 'active' }),
    collection.countDocuments({ tenantId, status: 'archived' }),
  ]);

  return { active, archived };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
