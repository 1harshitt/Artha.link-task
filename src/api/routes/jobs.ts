/**
 * Jobs API routes.
 * Handles job listing and retrieval.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseListJobsParams } from '../../domain/validation.js';
import { isOk } from '../../domain/result.js';
import * as JobRepo from '../../infra/JobRepository.js';
import type { ErrorResponse } from '../../domain/types.js';
import { logger } from '../../utils/logger.js';

/**
 * Register job routes.
 */
export async function jobsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /jobs - List jobs with cursor-based pagination.
   *
   * Query params:
   * - tenantId (required): Tenant scope
   * - sourceId (optional): Filter by source
   * - status (optional): Filter by status (active|archived|all)
   * - limit (optional): Page size (default 20, max 100)
   * - cursor (optional): Pagination cursor from previous response
   *
   * Returns:
   * - 200 OK: Job list with next cursor
   * - 400 Bad Request: Invalid query params
   *
   * Notes:
   * - No total count (expensive at scale)
   * - Cursor-based pagination is stable and efficient
   * - New jobs after cursor position are missed (acceptable)
   */
  server.get('/', async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply) => {
    // Validate query params
    const paramsResult = parseListJobsParams(request.query);

    if (!isOk(paramsResult)) {
      const response: ErrorResponse = {
        error: paramsResult.error.code,
        message: paramsResult.error.message,
        details: paramsResult.error.details,
      };

      return reply.status(400).send(response);
    }

    const params = paramsResult.value;

    try {
      // Fetch jobs with pagination
      const result = await JobRepo.listJobs({
        tenantId: params.tenantId,
        ...(params.sourceId !== undefined ? { sourceId: params.sourceId } : {}),
        ...(params.status !== undefined ? { status: params.status as 'active' | 'archived' | 'all' } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      });

      logger.debug('Jobs listed', {
        tenantId: params.tenantId,
        count: result.jobs.length,
        hasMore: !!result.nextCursor,
      });

      return reply.status(200).send({
        jobs: result.jobs,
        nextCursor: result.nextCursor,
        // Note: No total count - expensive at scale
      });
    } catch (error) {
      logger.error('Job listing error', {
        tenantId: params.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  });

  /**
   * GET /jobs/:externalJobId - Get a single job by ID.
   *
   * Query params:
   * - tenantId (required): Tenant scope
   * - sourceId (required): Source scope
   *
   * Returns:
   * - 200 OK: Job found
   * - 404 Not Found: Job not found in specified tenant/source
   * - 400 Bad Request: Missing required query params
   */
  server.get(
    '/:externalJobId',
    async (
      request: FastifyRequest<{ Params: { externalJobId: string }; Querystring: unknown }>,
      reply: FastifyReply
    ) => {
      // Parse query params (reuse event query params schema)
      const paramsResult = parseListJobsParams({
        tenantId: (request.query as Record<string, unknown>)['tenantId'],
        sourceId: (request.query as Record<string, unknown>)['sourceId'],
      });

      if (!isOk(paramsResult)) {
        const response: ErrorResponse = {
          error: paramsResult.error.code,
          message: 'Missing required query params: tenantId, sourceId',
        };

        return reply.status(400).send(response);
      }

      const { tenantId, sourceId } = paramsResult.value;
      const { externalJobId } = request.params;

      try {
        // Fetch job (scoped by tenant and source)
        const job = await JobRepo.getJob(tenantId, sourceId!, externalJobId);

        if (!job) {
          const response: ErrorResponse = {
            error: 'JOB_NOT_FOUND',
            message: 'Job not found',
            details: { externalJobId, tenantId, sourceId },
          };

          return reply.status(404).send(response);
        }

        return reply.status(200).send(job);
      } catch (error) {
        logger.error('Job fetch error', {
          externalJobId,
          error: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    }
  );
}
