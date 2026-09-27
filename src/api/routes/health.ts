/**
 * Health check routes.
 * Monitors service and dependency health.
 */

import type { FastifyInstance } from 'fastify';
import { healthCheck as mongoHealthCheck } from '../../infra/mongodb.js';
import { getRunningWorkerCount } from '../../worker/index.js';
import type { HealthCheckResponse } from '../../domain/types.js';
import { logger } from '../../utils/logger.js';

const VERSION = '1.0.0'; // In production, read from package.json

/**
 * Register health check routes.
 */
export async function healthRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /health - Service health check.
   *
   * Returns:
   * - 200 OK: All systems operational
   * - 503 Service Unavailable: Critical dependency down
   *
   * Status meanings:
   * - ok: All dependencies healthy, workers running
   * - degraded: MongoDB ok but workers not running (can accept but not process)
   * - down: MongoDB unreachable
   */
  server.get('/', async (_request, reply) => {
    try {
      // Check MongoDB
      const mongoHealth = await mongoHealthCheck();

      // Check workers
      const workerCount = getRunningWorkerCount();

      // Determine overall status
      let status: 'ok' | 'degraded' | 'down';
      let httpStatus: number;

      if (mongoHealth.status === 'down') {
        status = 'down';
        httpStatus = 503;
      } else if (workerCount === 0) {
        status = 'degraded';
        httpStatus = 200; // Still accepting requests
      } else {
        status = 'ok';
        httpStatus = 200;
      }

      const response: HealthCheckResponse = {
        status,
        checks: {
          mongodb: mongoHealth,
        },
        workerCount,
        version: VERSION,
      };

      logger.debug('Health check', {
        status,
        mongoStatus: mongoHealth.status,
        workerCount,
      });

      return reply.status(httpStatus).send(response);
    } catch (error) {
      logger.error('Health check error', {
        error: error instanceof Error ? error.message : String(error),
      });

      const response: HealthCheckResponse = {
        status: 'down',
        checks: {
          mongodb: {
            status: 'down',
            latencyMs: -1,
          },
        },
        workerCount: 0,
        version: VERSION,
      };

      return reply.status(503).send(response);
    }
  });
}
