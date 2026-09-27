/**
 * Unit tests for event validation.
 * Pure logic tests - no database dependencies.
 */

import { describe, it, expect } from 'vitest';
import { parseAndNormalizeEvent } from '../../src/domain/validation.js';
import { isOk, isErr } from '../../src/domain/result.js';

describe('Event Validation', () => {
  describe('Valid Events', () => {
    it('should accept valid upsert event', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-101',
        externalJobId: 'job-001',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Senior Software Engineer',
          company: 'Artha Inc',
          location: 'Remote',
          experienceMin: 3,
          experienceMax: 7,
          skills: ['TypeScript', 'MongoDB'],
          applyUrl: 'https://artha.link/apply/job-001',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);

      if (isOk(result)) {
        expect(result.value.tenantId).toBe('tenant-a');
        expect(result.value.operation).toBe('upsert');
        if (result.value.operation === 'upsert') {
          expect(result.value.payload.title).toBe('Senior Software Engineer');
        }
      }
    });

    it('should accept valid archive event', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-102',
        externalJobId: 'job-002',
        version: 5,
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);

      if (isOk(result)) {
        expect(result.value.operation).toBe('archive');
        expect(result.value.payload).toBeUndefined();
      }
    });
  });

  describe('Skills Deduplication', () => {
    it('should deduplicate skills preserving first occurrence order', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-103',
        externalJobId: 'job-003',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: [' TypeScript ', 'MongoDB', 'typescript', 'MONGODB', 'React'],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);

      if (isOk(result)) {
        // Skills should be: lowercase, trimmed, deduplicated, order preserved
        if (result.value.operation === 'upsert') {
          expect(result.value.payload.skills).toEqual(['typescript', 'mongodb', 'react']);
        }
      }
    });

    it('should handle empty skills array', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-104',
        externalJobId: 'job-004',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 0,
          experienceMax: 2,
          skills: [],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);

      if (isOk(result)) {
        if (result.value.operation === 'upsert') {
          expect(result.value.payload.skills).toEqual([]);
        }
      }
    });
  });

  describe('Identifier Whitespace Rejection', () => {
    it('should reject tenantId with surrounding whitespace', () => {
      const input = {
        tenantId: '  tenant-a  ',
        sourceId: 'feed-1',
        eventId: 'event-105',
        externalJobId: 'job-005',
        version: 1,
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject sourceId with surrounding whitespace', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: '  feed-1  ',
        eventId: 'event-106',
        externalJobId: 'job-006',
        version: 1,
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);
    });

    it('should reject eventId with surrounding whitespace', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: '  event-107  ',
        externalJobId: 'job-007',
        version: 1,
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('Display Field Trimming', () => {
    it('should trim title, company, location', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-108',
        externalJobId: 'job-008',
        version: 1,
        operation: 'upsert',
        payload: {
          title: '  Senior Engineer  ',
          company: '  Artha Inc  ',
          location: '  Remote  ',
          experienceMin: 3,
          experienceMax: 7,
          skills: ['TypeScript'],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);

      if (isOk(result)) {
        if (result.value.operation === 'upsert') {
          expect(result.value.payload.title).toBe('Senior Engineer');
          expect(result.value.payload.company).toBe('Artha Inc');
          expect(result.value.payload.location).toBe('Remote');
        }
      }
    });

    it('should reject blank title after trimming', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-109',
        externalJobId: 'job-009',
        version: 1,
        operation: 'upsert',
        payload: {
          title: '   ',
          company: 'Artha Inc',
          location: 'Remote',
          experienceMin: 3,
          experienceMax: 7,
          skills: ['TypeScript'],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);
    });
  });

  describe('Apply URL Validation', () => {
    it('should reject non-https URL', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-110',
        externalJobId: 'job-010',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['TypeScript'],
          applyUrl: 'http://example.com/job', // http not https
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);
    });

    it('should accept https URL', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-111',
        externalJobId: 'job-011',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['TypeScript'],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);
    });
  });

  describe('Experience Validation', () => {
    it('should reject experienceMin > experienceMax', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-112',
        externalJobId: 'job-012',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 7,
          experienceMax: 3, // Invalid: min > max
          skills: ['TypeScript'],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);

      if (isErr(result)) {
        expect(result.error.message).toContain('experienceMin');
      }
    });

    it('should accept experienceMin = experienceMax', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-113',
        externalJobId: 'job-013',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 5,
          experienceMax: 5,
          skills: ['TypeScript'],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);
    });
  });

  describe('Version Validation', () => {
    it('should reject version = 0', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-114',
        externalJobId: 'job-014',
        version: 0, // Invalid
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);
    });

    it('should reject negative version', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-115',
        externalJobId: 'job-015',
        version: -1, // Invalid
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);
    });

    it('should accept positive version', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-116',
        externalJobId: 'job-016',
        version: 42,
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);
    });
  });

  describe('Archive Validation', () => {
    it('should reject archive with payload', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-117',
        externalJobId: 'job-017',
        version: 5,
        operation: 'archive',
        payload: {
          // Payload not allowed for archive
          title: 'Developer',
          company: 'Tech Co',
          location: 'Remote',
          experienceMin: 2,
          experienceMax: 5,
          skills: ['TypeScript'],
          applyUrl: 'https://example.com/job',
        },
      };

      const result = parseAndNormalizeEvent(input);
      expect(isErr(result)).toBe(true);
    });

    it('should accept archive without payload', () => {
      const input = {
        tenantId: 'tenant-a',
        sourceId: 'feed-1',
        eventId: 'event-118',
        externalJobId: 'job-018',
        version: 5,
        operation: 'archive',
      };

      const result = parseAndNormalizeEvent(input);
      expect(isOk(result)).toBe(true);
    });
  });
});
