/**
 * Pure business logic for event processing.
 * No infrastructure dependencies - can be tested without MongoDB.
 */

import type { ValidatedEvent, EventRecord, WorkItem } from './types.js';

/**
 * Canonical JSON stringify for content comparison.
 * Ensures consistent object key ordering for deep equality checks.
 */
function canonicalStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    // Array order IS significant - preserve it
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }

  if (typeof obj === 'object') {
    // Sort object keys for consistent ordering
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map((key) => {
      const value = (obj as Record<string, unknown>)[key];
      return `"${key}":${canonicalStringify(value)}`;
    });
    return '{' + pairs.join(',') + '}';
  }

  // Primitives
  return JSON.stringify(obj);
}

/**
 * Check if an incoming event is an exact replay of an existing event.
 *
 * Comparison rules:
 * - Object key order is ignored (use canonical JSON)
 * - Array order IS significant
 * - All fields must match exactly
 *
 * Examples:
 * - Same content, different key order → true (replay)
 * - Same content, different array order → false (different content)
 * - Same eventId, different payload → false (conflict)
 *
 * @param existing - Event already in database
 * @param incoming - New event to compare
 * @returns true if exact replay, false if content differs
 */
export function isExactReplay(existing: EventRecord, incoming: ValidatedEvent): boolean {
  // Must match all identity fields
  if (
    existing.tenantId !== incoming.tenantId ||
    existing.sourceId !== incoming.sourceId ||
    existing.eventId !== incoming.eventId ||
    existing.externalJobId !== incoming.externalJobId
  ) {
    return false;
  }

  // Must match operation and version
  if (existing.operation !== incoming.operation || existing.version !== incoming.version) {
    return false;
  }

  // For upsert, compare payload using canonical JSON
  if (incoming.operation === 'upsert') {
    if (!existing.payload) {
      return false; // Existing is archive, incoming is upsert
    }

    const existingPayloadJson = canonicalStringify(existing.payload);
    const incomingPayloadJson = canonicalStringify(incoming.payload);

    return existingPayloadJson === incomingPayloadJson;
  }

  // For archive, no payload to compare
  if (incoming.operation === 'archive') {
    return !existing.payload; // Both must be archive
  }

  return false;
}

/**
 * Check if an incoming event is stale (lower or equal version than current job state).
 *
 * Staleness rules:
 * - If no current job exists (null version), event is NOT stale
 * - If incoming.version <= currentJobVersion, event IS stale
 * - If incoming.version > currentJobVersion, event is NOT stale
 *
 * Equal version is considered stale because the highest version already won.
 * We use strict less-than in the MongoDB update filter to prevent overwrites.
 *
 * @param incoming - Event to check
 * @param currentJobVersion - Current job version, or null if job doesn't exist
 * @returns true if stale (should not update job projection)
 */
export function isStale(incoming: ValidatedEvent, currentJobVersion: number | null): boolean {
  if (currentJobVersion === null) {
    return false; // No existing job, so not stale
  }

  return incoming.version <= currentJobVersion;
}

/**
 * Check if a work item can skip provider verification.
 *
 * Skip verification when:
 * - Work item version <= current job version (stale, already processed or superseded)
 *
 * This handles:
 * - Delayed events that arrive after higher versions processed
 * - Concurrent processing where another worker already applied a higher version
 * - Recovery scenarios where stale work gets reclaimed
 *
 * Skipping verification for stale items is safe because:
 * - The version guard in job projection prevents overwrite
 * - The provider state doesn't matter if we won't update the job
 * - Saves external API calls for work that won't be applied
 *
 * @param workItem - Claimed work item
 * @param currentJobVersion - Current job version, or null if job doesn't exist
 * @returns true if verification can be skipped
 */
export function shouldSkipVerification(workItem: WorkItem, currentJobVersion: number | null): boolean {
  // WorkItem carries the same version semantics as ValidatedEvent for staleness purposes
  return currentJobVersion !== null && workItem.version <= currentJobVersion;
}
