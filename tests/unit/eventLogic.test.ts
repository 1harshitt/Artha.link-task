/**
 * Unit tests for event business logic.
 * Pure logic tests - no database dependencies.
 */

import { describe, it, expect } from 'vitest';
import { isExactReplay, isStale, shouldSkipVerification } from '../../src/domain/eventLogic.js';
import type { EventRecord, ValidatedEvent, WorkItem } from '../../src/domain/types.js';

describe('Event Logic', () => {
  describe('isExactReplay', () => {
    it('should return true for exact replay with same content', () => {
      const existing: EventRecord = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-001',
        externalJobId: 'job-001',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['typescript', 'mongodb'],
          applyUrl: 'https://example.com/job',
        },
        status: 'completed',
        attempts: 1,
        attemptHistory: [],
        acceptedAt: new Date(),
      };

      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-001',
        externalJobId: 'job-001',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['typescript', 'mongodb'],
          applyUrl: 'https://example.com/job',
        },
      };

      expect(isExactReplay(existing, incoming)).toBe(true);
    });

    it('should return true for same content with different object key order', () => {
      const existing: EventRecord = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-002',
        externalJobId: 'job-002',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['typescript'],
          applyUrl: 'https://example.com/job',
        },
        status: 'completed',
        attempts: 1,
        attemptHistory: [],
        acceptedAt: new Date(),
      };

      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-002',
        externalJobId: 'job-002',
        version: 1,
        operation: 'upsert',
        payload: {
          // Different key order - should still be replay
          applyUrl: 'https://example.com/job',
          title: 'Developer',
          experienceMax: 5,
          company: 'Tech Co',
          experienceMin: 2,
          location: 'Remote',
          skills: ['typescript'],
        },
      };

      expect(isExactReplay(existing, incoming)).toBe(true);
    });

    it('should return false for different array order', () => {
      const existing: EventRecord = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-003',
        externalJobId: 'job-003',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['typescript', 'mongodb'], // Order matters!
          applyUrl: 'https://example.com/job',
        },
        status: 'completed',
        attempts: 1,
        attemptHistory: [],
        acceptedAt: new Date(),
      };

      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-003',
        externalJobId: 'job-003',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['mongodb', 'typescript'], // Different order
          applyUrl: 'https://example.com/job',
        },
      };

      expect(isExactReplay(existing, incoming)).toBe(false);
    });

    it('should return false for same eventId but different payload', () => {
      const existing: EventRecord = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-004',
        externalJobId: 'job-004',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Senior Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 5,
          experienceMax: 10,
          skills: ['typescript'],
          applyUrl: 'https://example.com/job',
        },
        status: 'completed',
        attempts: 1,
        attemptHistory: [],
        acceptedAt: new Date(),
      };

      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-004',
        externalJobId: 'job-004',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Junior Developer', // Different title
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 0,
          experienceMax: 2,
          skills: ['typescript'],
          applyUrl: 'https://example.com/job',
        },
      };

      expect(isExactReplay(existing, incoming)).toBe(false);
    });

    it('should return false for different versions', () => {
      const existing: EventRecord = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-005',
        externalJobId: 'job-005',
        version: 1,
        operation: 'archive',
        status: 'completed',
        attempts: 1,
        attemptHistory: [],
        acceptedAt: new Date(),
      };

      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-005',
        externalJobId: 'job-005',
        version: 2, // Different version
        operation: 'archive',
      };

      expect(isExactReplay(existing, incoming)).toBe(false);
    });
  });

  describe('isStale', () => {
    it('should return false when no current job exists', () => {
      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-006',
        externalJobId: 'job-006',
        version: 1,
        operation: 'archive',
      };

      expect(isStale(incoming, null)).toBe(false);
    });

    it('should return true when incoming version < current version', () => {
      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-007',
        externalJobId: 'job-007',
        version: 3,
        operation: 'archive',
      };

      expect(isStale(incoming, 5)).toBe(true);
    });

    it('should return true when incoming version = current version', () => {
      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-008',
        externalJobId: 'job-008',
        version: 5,
        operation: 'archive',
      };

      expect(isStale(incoming, 5)).toBe(true); // Equal = stale
    });

    it('should return false when incoming version > current version', () => {
      const incoming: ValidatedEvent = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-009',
        externalJobId: 'job-009',
        version: 7,
        operation: 'archive',
      };

      expect(isStale(incoming, 5)).toBe(false); // Can update
    });
  });

  describe('shouldSkipVerification', () => {
    it('should return false when no current job exists', () => {
      const workItem: WorkItem = {
        eventId: 'event-010',
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        externalJobId: 'job-010',
        version: 1,
        operation: 'archive',
        attempts: 1,
        claimedBy: 'worker-1',
        claimedUntil: new Date(),
      };

      expect(shouldSkipVerification(workItem, null)).toBe(false);
    });

    it('should return true when work item version <= current version', () => {
      const workItem: WorkItem = {
        eventId: 'event-011',
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        externalJobId: 'job-011',
        version: 3,
        operation: 'archive',
        attempts: 1,
        claimedBy: 'worker-1',
        claimedUntil: new Date(),
      };

      expect(shouldSkipVerification(workItem, 5)).toBe(true);
    });

    it('should return false when work item version > current version', () => {
      const workItem: WorkItem = {
        eventId: 'event-012',
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        externalJobId: 'job-012',
        version: 7,
        operation: 'archive',
        attempts: 1,
        claimedBy: 'worker-1',
        claimedUntil: new Date(),
      };

      expect(shouldSkipVerification(workItem, 5)).toBe(false);
    });
  });
});
