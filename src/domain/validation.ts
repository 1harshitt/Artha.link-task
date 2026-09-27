import { z } from 'zod';
import type { RawEventInput, ValidatedEvent, JobPayload } from './types.js';
import { type Result, ok, err } from './result.js';

/**
 * Validation error with field-level details.
 */
export interface ValidationError {
  code: 'VALIDATION_ERROR';
  message: string;
  details?: unknown;
}

/**
 * String that must be non-blank and have no surrounding whitespace.
 * Surrounding whitespace is REJECTED, not trimmed.
 * This prevents subtle bugs where '  tenant-a  ' !== 'tenant-a'.
 */
const strictIdentifier = z
  .string()
  .min(1, 'Must not be empty')
  .refine((val) => val === val.trim(), {
    message: 'Must not have surrounding whitespace',
  })
  .refine((val) => val.length > 0, {
    message: 'Must not be blank',
  });

/**
 * String that is trimmed and non-blank (for display fields).
 */
const trimmedNonBlank = z
  .string()
  .transform((val) => val.trim())
  .pipe(z.string().min(1, 'Must not be blank after trimming'));

/**
 * Experience value: integer between 0 and 50.
 */
const experience = z.number().int().min(0).max(50);

/**
 * Skills array: deduplicated, trimmed, lowercase, preserving first occurrence order.
 * Example: [" TypeScript ", "MongoDB", "typescript"] → ["typescript", "mongodb"]
 */
const skillsArray = z
  .array(z.string())
  .transform((skills) => {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const skill of skills) {
      const normalized = skill.trim().toLowerCase();
      if (normalized.length > 0 && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }

    return result;
  })
  .pipe(z.array(z.string()).min(0));

/**
 * Apply URL must start with https://.
 */
const httpsUrl = z
  .string()
  .url()
  .refine((url) => url.startsWith('https://'), {
    message: 'Must start with https://',
  });

/**
 * Job payload schema for upsert operations.
 */
const jobPayloadSchema = z.object({
  title: trimmedNonBlank,
  company: trimmedNonBlank,
  location: trimmedNonBlank,
  experienceMin: experience,
  experienceMax: experience,
  skills: skillsArray,
  applyUrl: httpsUrl,
}) satisfies z.ZodType<JobPayload>;

/**
 * Base event schema (common fields).
 */
const baseEventSchema = z.object({
  tenantId: strictIdentifier,
  sourceId: strictIdentifier,
  eventId: strictIdentifier,
  externalJobId: strictIdentifier,
  version: z.number().int().positive().safe(),
});

/**
 * Upsert event schema.
 */
const upsertEventSchema = baseEventSchema.extend({
  operation: z.literal('upsert'),
  payload: jobPayloadSchema,
});

/**
 * Archive event schema (no payload allowed).
 */
const archiveEventSchema = baseEventSchema.extend({
  operation: z.literal('archive'),
  payload: z.undefined().optional(),
});

/**
 * Full event schema (discriminated union).
 */
const eventSchema = z.discriminatedUnion('operation', [upsertEventSchema, archiveEventSchema]);

/**
 * Parse and normalize an event from raw input.
 *
 * Validation rules:
 * - Identifiers (tenantId, sourceId, eventId, externalJobId): no surrounding whitespace
 * - Version: positive safe integer
 * - Operation: 'upsert' or 'archive'
 * - For upsert: title, company, location non-blank after trim
 * - experienceMin/Max: integers 0-50, min <= max
 * - applyUrl: must start with https://
 * - skills: deduplicated, trimmed lowercase, preserving first-occurrence order
 * - For archive: no payload field allowed
 *
 * @param raw - Raw input from HTTP request
 * @returns Result with validated event or validation error
 */
export function parseAndNormalizeEvent(raw: RawEventInput): Result<ValidatedEvent, ValidationError> {
  const result = eventSchema.safeParse(raw);

  if (!result.success) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Invalid event format',
      details: result.error.format(),
    });
  }

  const event = result.data;

  // Additional validation: experienceMin <= experienceMax for upsert
  if (event.operation === 'upsert') {
    if (event.payload.experienceMin > event.payload.experienceMax) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'experienceMin must be less than or equal to experienceMax',
        details: {
          experienceMin: event.payload.experienceMin,
          experienceMax: event.payload.experienceMax,
        },
      });
    }
  }

  return ok(event as ValidatedEvent);
}

/**
 * Validate list jobs query parameters.
 */
const listJobsParamsSchema = z.object({
  tenantId: strictIdentifier,
  sourceId: strictIdentifier.optional(),
  status: z.enum(['active', 'archived', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});

export function parseListJobsParams(raw: unknown): Result<z.infer<typeof listJobsParamsSchema>, ValidationError> {
  const result = listJobsParamsSchema.safeParse(raw);

  if (!result.success) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Invalid query parameters',
      details: result.error.format(),
    });
  }

  return ok(result.data);
}

/**
 * Validate event query parameters (for GET /events/:eventId).
 */
const eventQueryParamsSchema = z.object({
  tenantId: strictIdentifier,
  sourceId: strictIdentifier,
});

export function parseEventQueryParams(raw: unknown): Result<z.infer<typeof eventQueryParamsSchema>, ValidationError> {
  const result = eventQueryParamsSchema.safeParse(raw);

  if (!result.success) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Invalid query parameters',
      details: result.error.format(),
    });
  }

  return ok(result.data);
}
