/**
 * Domain types for the job feed ingestion service.
 * These types encode correctness invariants and make illegal states unrepresentable.
 */

/**
 * Raw event input from HTTP request (unknown shape, must be validated).
 */
export type RawEventInput = unknown;

/**
 * Job payload for upsert operations (after validation and normalization).
 */
export interface JobPayload {
  title: string; // Non-blank, trimmed
  company: string; // Non-blank, trimmed
  location: string; // Non-blank, trimmed
  experienceMin: number; // 0-50, integer
  experienceMax: number; // 0-50, integer, >= experienceMin
  skills: string[]; // Deduplicated, trimmed, lowercase, order preserved
  applyUrl: string; // Must start with https://
}

/**
 * Discriminated union for event operations.
 * Makes illegal states unrepresentable: archive cannot have payload.
 */
export type ValidatedEvent =
  | {
      tenantId: string; // Non-blank, no surrounding whitespace
      sourceId: string; // Non-blank, no surrounding whitespace
      eventId: string; // Non-blank, no surrounding whitespace
      externalJobId: string; // Non-blank, no surrounding whitespace
      version: number; // Positive safe integer
      operation: 'upsert';
      payload: JobPayload;
    }
  | {
      tenantId: string;
      sourceId: string;
      eventId: string;
      externalJobId: string;
      version: number;
      operation: 'archive';
      payload?: never; // Archive must NOT have payload
    };

/**
 * Event status lifecycle.
 * Terminal states: completed, failed, stale
 */
export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'stale';

/**
 * Job status.
 */
export type JobStatus = 'active' | 'archived';

/**
 * Event record as stored in MongoDB.
 * Includes processing metadata and attempt history.
 */
export interface EventRecord {
  _id?: string; // MongoDB ObjectId
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: 'upsert' | 'archive';
  payload?: JobPayload; // Present only for upsert
  status: EventStatus;
  attempts: number; // Number of processing attempts
  lastError?: string; // Present only when status is 'failed'
  claimedBy?: string; // Worker ID that claimed this event
  claimedUntil?: Date; // Claim expiry timestamp
  acceptedAt: Date; // When event was accepted
  startedAt?: Date; // When processing started
  completedAt?: Date; // When processing completed or failed
  attemptHistory: AttemptRecord[]; // Full history of attempts
}

/**
 * Single processing attempt record.
 */
export interface AttemptRecord {
  attemptNumber: number;
  workerId: string;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  outcome: 'success' | 'retriable_error' | 'permanent_failure' | 'crash';
}

/**
 * Job projection (current computed state of a job).
 * This is what gets returned from GET /jobs.
 */
export interface JobProjection {
  _id?: string; // MongoDB ObjectId
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number; // Highest successfully processed version
  status: JobStatus;
  title?: string; // Present only for active jobs
  company?: string;
  location?: string;
  experienceMin?: number;
  experienceMax?: number;
  skills?: string[];
  applyUrl?: string;
  createdAt: Date; // When first version was applied
  updatedAt: Date; // When current version was applied
}

/**
 * Work item claimed by a worker.
 * Contains the event to process and metadata for tracking.
 */
export interface WorkItem {
  eventId: string;
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number;
  operation: 'upsert' | 'archive';
  payload?: JobPayload;
  attempts: number;
  claimedBy: string;
  claimedUntil: Date;
}

/**
 * Result of accepting an event.
 */
export type AcceptResult =
  | { type: 'accepted'; eventId: string }
  | { type: 'duplicate'; eventId: string; status: EventStatus }
  | { type: 'conflict'; eventId: string; message: string };

/**
 * Result of processing a work item.
 */
export type WorkResult =
  | { type: 'completed' }
  | { type: 'stale'; reason: string }
  | { type: 'failed'; error: string; retriable: boolean };

/**
 * Provider verification response.
 */
export type VerificationResult =
  | { type: 'verified' }
  | { type: 'not_found' }
  | { type: 'retriable_error'; statusCode: number; message: string }
  | { type: 'permanent_failure'; statusCode: number; message: string };

/**
 * Pagination parameters for job listing.
 */
export interface ListJobsParams {
  tenantId: string;
  sourceId?: string;
  status?: JobStatus | 'all';
  limit?: number; // Max 100
  cursor?: string; // Base64 encoded ObjectId
}

/**
 * Paginated job list response.
 */
export interface JobListResponse {
  jobs: JobProjection[];
  nextCursor: string | null;
}

/**
 * API error response format.
 */
export interface ErrorResponse {
  error: string; // Machine-readable code
  message: string; // Human-readable message
  details?: unknown; // Additional context (e.g., Zod validation errors)
}

/**
 * Health check response.
 */
export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'down';
  checks: {
    mongodb: {
      status: 'ok' | 'down';
      latencyMs: number;
    };
  };
  workerCount: number;
  version: string;
}
