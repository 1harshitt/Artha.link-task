/**
 * Worker manager - runs multiple worker instances concurrently.
 * Demonstrates concurrent worker safety with competitive claim.
 */

import { Worker } from './Worker.js';
import { logger } from '../utils/logger.js';

const workers: Worker[] = [];
let shutdownRequested = false;

/**
 * Start N worker instances.
 * All workers compete for the same events collection via atomic claim.
 */
export async function startWorkers(count: number = 2): Promise<Worker[]> {
  logger.info(`🚀 Starting ${count} workers...`);

  for (let i = 0; i < count; i++) {
    const worker = new Worker(`worker-${i + 1}`);
    workers.push(worker);

    // Start worker in background (don't await - let them run concurrently)
    worker.start().catch((error) => {
      logger.error('Worker crashed', {
        workerId: worker.getWorkerId(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Give workers a moment to start
  await new Promise((resolve) => setTimeout(resolve, 100));

  logger.info(`✅ ${count} workers started`);
  return workers;
}

/**
 * Stop all workers gracefully.
 * Waits for workers to finish current work before shutting down.
 */
export async function stopWorkers(): Promise<void> {
  if (shutdownRequested) {
    logger.warn('Shutdown already in progress');
    return;
  }

  shutdownRequested = true;
  logger.info('🛑 Stopping all workers...');

  // Request all workers to stop
  await Promise.all(workers.map((worker) => worker.stop()));

  logger.info('✅ All workers stopped');
}

/**
 * Get count of running workers.
 */
export function getRunningWorkerCount(): number {
  return workers.filter((w) => w.isRunning()).length;
}

/**
 * Get all worker instances.
 */
export function getWorkers(): Worker[] {
  return workers;
}

/**
 * Handle graceful shutdown on SIGTERM/SIGINT.
 */
export function setupGracefulShutdown(): void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} - initiating graceful shutdown`);

    try {
      await stopWorkers();
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
}
