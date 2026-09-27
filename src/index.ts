/**
 * Main entry point for the job feed ingestion service.
 * Starts MongoDB, HTTP server, and background workers.
 */

import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { connect as connectMongo, disconnect as disconnectMongo } from './infra/mongodb.js';
import { createIndexes } from './infra/indexes.js';
import { createServer, startServer, stopServer } from './api/server.js';
import { startWorkers, stopWorkers, setupGracefulShutdown } from './worker/index.js';

/**
 * Application bootstrap.
 */
async function main(): Promise<void> {
  logger.info('🚀 Starting Artha Job Feed Ingestion Service', {
    nodeVersion: process.version,
    env: env.NODE_ENV,
  });

  // 1. Connect to MongoDB
  const { db } = await connectMongo();

  // 2. Create indexes
  await createIndexes(db);

  // 3. Create and start HTTP server
  const server = await createServer();
  await startServer(server);

  // 4. Start background workers
  await startWorkers(2); // Run 2 workers

  // 5. Setup graceful shutdown
  setupGracefulShutdown();

  // Also handle server shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} - shutting down gracefully`);

    try {
      // Stop accepting new requests
      await stopServer(server);

      // Stop workers
      await stopWorkers();

      // Close MongoDB connection
      await disconnectMongo();

      logger.info('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('✅ Application started successfully');
  logger.info('📡 Ready to accept events');
}

// Run application
main().catch((error: unknown) => {
  logger.error('💥 Application failed to start', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
