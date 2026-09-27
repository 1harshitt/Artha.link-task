/**
 * Fastify HTTP server setup.
 * Configures routes, error handling, and validation.
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { ErrorResponse } from '../domain/types.js';

import { eventsRoutes } from './routes/events.js';
import { jobsRoutes } from './routes/jobs.js';
import { healthRoutes } from './routes/health.js';

/**
 * Create and configure Fastify server.
 */
export async function createServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false, // Use our custom logger
    ajv: {
      customOptions: {
        removeAdditional: false, // Don't remove extra properties
        coerceTypes: false, // Don't auto-coerce types
        useDefaults: true,
      },
    },
    trustProxy: true,
  });

  // CORS configuration
  await server.register(cors, {
    origin: true, // Allow all origins for development
    credentials: true,
  });

  // Custom error handler
  server.setErrorHandler((error, request, reply) => {
    logger.error('Request error', {
      method: request.method,
      url: request.url,
      error: error.message,
      stack: error.stack,
    });

    const response: ErrorResponse = {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };

    // Don't leak internal errors in production
    if (env.NODE_ENV === 'development') {
      response.details = {
        message: error.message,
        stack: error.stack,
      };
    }

    void reply.status(500).send(response);
  });

  // Custom not found handler
  server.setNotFoundHandler((request, reply) => {
    const response: ErrorResponse = {
      error: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
    };

    void reply.status(404).send(response);
  });

  // Request logging
  server.addHook('onRequest', async (request) => {
    logger.debug('Incoming request', {
      method: request.method,
      url: request.url,
      ip: request.ip,
    });
  });

  // Response logging
  server.addHook('onResponse', async (request, reply) => {
    logger.debug('Response sent', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.getResponseTime(),
    });
  });

  // Register routes
  await server.register(eventsRoutes, { prefix: '/events' });
  await server.register(jobsRoutes, { prefix: '/jobs' });
  await server.register(healthRoutes, { prefix: '/health' });

  return server;
}

/**
 * Start the HTTP server.
 */
export async function startServer(server: FastifyInstance): Promise<void> {
  try {
    await server.listen({
      host: env.HOST,
      port: env.PORT,
    });

    logger.info('🌐 HTTP server started', {
      host: env.HOST,
      port: env.PORT,
      environment: env.NODE_ENV,
    });
  } catch (error) {
    logger.error('Failed to start HTTP server', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Stop the HTTP server gracefully.
 */
export async function stopServer(server: FastifyInstance): Promise<void> {
  logger.info('🛑 Stopping HTTP server...');

  try {
    await server.close();
    logger.info('✅ HTTP server stopped');
  } catch (error) {
    logger.error('Error stopping HTTP server', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
