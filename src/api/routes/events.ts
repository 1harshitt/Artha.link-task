/**
 * Events API routes.
 * Handles event submission and status queries.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseAndNormalizeEvent, parseEventQueryParams } from '../../domain/validation.js';
import { isOk } from '../../domain/result.js';
import * as EventRepo from '../../infra/EventRepository.js';
import type { ErrorResponse } from '../../domain/types.js';
import { logger } from '../../utils/logger.js';

/**
 * Register event routes.
 */
export async function eventsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * POST /events - Submit a new event for processing.
   *
   * Returns:
   * - 202 Accepted: Event accepted and queued for processing
   * - 200 OK: Exact duplicate (idempotent)
   * - 409 Conflict: Event ID reused with different content
   * - 400 Bad Request: Validation failed
   */
  server.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    // Parse and validate event
    const result = parseAndNormalizeEvent(request.body);

    if (!isOk(result)) {
      const response: ErrorResponse = {
        error: result.error.code,
        message: result.error.message,
        details: result.error.details,
      };

      return reply.status(400).send(response);
    }

    const event = result.value;

    try {
      // Accept event (atomic operation)
      const acceptResult = await EventRepo.acceptEvent(event);

      if (acceptResult.type === 'accepted') {
        logger.info('Event accepted', {
          tenantId: event.tenantId,
          eventId: event.eventId,
          version: event.version,
          operation: event.operation,
        });

        return reply.status(202).send({
          eventId: acceptResult.eventId,
          status: 'pending',
          message: 'Event accepted for processing',
        });
      }

      if (acceptResult.type === 'duplicate') {
        logger.debug('Event duplicate', {
          eventId: event.eventId,
          status: acceptResult.status,
        });

        return reply.status(200).send({
          eventId: acceptResult.eventId,
          status: acceptResult.status,
          message: 'Event already received (duplicate)',
        });
      }

      if (acceptResult.type === 'conflict') {
        logger.warn('Event conflict', {
          eventId: event.eventId,
        });

        const response: ErrorResponse = {
          error: 'EVENT_CONFLICT',
          message: 'Event ID reused with different content',
          details: { eventId: acceptResult.eventId },
        };

        return reply.status(409).send(response);
      }
    } catch (error) {
      logger.error('Event acceptance error', {
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error; // Let error handler deal with it
    }
  });

  /**
   * GET /events/:eventId - Get event processing status.
   *
   * Query params:
   * - tenantId (required): Tenant scope
   * - sourceId (required): Source scope
   *
   * Returns:
   * - 200 OK: Event found
   * - 404 Not Found: Event not found in specified tenant/source
   * - 400 Bad Request: Missing required query params
   */
  server.get(
    '/:eventId',
    async (
      request: FastifyRequest<{ Params: { eventId: string }; Querystring: unknown }>,
      reply: FastifyReply
    ) => {
      // Validate query params
      const paramsResult = parseEventQueryParams(request.query);

      if (!isOk(paramsResult)) {
        const response: ErrorResponse = {
          error: paramsResult.error.code,
          message: paramsResult.error.message,
          details: paramsResult.error.details,
        };

        return reply.status(400).send(response);
      }

      const { tenantId, sourceId } = paramsResult.value;
      const { eventId } = request.params;

      try {
        // Fetch event (scoped by tenant and source)
        const event = await EventRepo.getEvent(tenantId, sourceId, eventId);

        if (!event) {
          const response: ErrorResponse = {
            error: 'EVENT_NOT_FOUND',
            message: 'Event not found',
            details: { eventId, tenantId, sourceId },
          };

          return reply.status(404).send(response);
        }

        // Return event status with processing details
        return reply.status(200).send({
          eventId: event.eventId,
          tenantId: event.tenantId,
          sourceId: event.sourceId,
          externalJobId: event.externalJobId,
          version: event.version,
          operation: event.operation,
          status: event.status,
          attempts: event.attempts,
          lastError: event.lastError,
          acceptedAt: event.acceptedAt,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
          attemptHistory: event.attemptHistory,
        });
      } catch (error) {
        logger.error('Event fetch error', {
          eventId,
          error: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    }
  );
}
