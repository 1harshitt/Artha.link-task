/**
 * MongoDB connection management.
 * Provides singleton client with connection pooling and health checking.
 */

import { MongoClient, Db } from 'mongodb';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Connect to MongoDB with connection pooling.
 * Safe to call multiple times - returns existing connection if already connected.
 */
export async function connect(): Promise<{ client: MongoClient; db: Db }> {
  if (client && db) {
    return { client, db };
  }

  logger.info('📦 Connecting to MongoDB', { uri: env.MONGODB_URI.replace(/\/\/.*@/, '//<credentials>@') });

  client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
  });

  await client.connect();
  db = client.db(env.MONGODB_DATABASE);

  // Verify connection with ping
  await db.admin().ping();

  logger.info('✅ MongoDB connected', { database: env.MONGODB_DATABASE });

  return { client, db };
}

/**
 * Get the active database connection.
 * Throws if not connected - call connect() first.
 */
export function getDb(): Db {
  if (!db) {
    throw new Error('Database not connected. Call connect() first.');
  }
  return db;
}

/**
 * Get the active MongoDB client.
 * Throws if not connected - call connect() first.
 */
export function getClient(): MongoClient {
  if (!client) {
    throw new Error('Database not connected. Call connect() first.');
  }
  return client;
}

/**
 * Close MongoDB connection gracefully.
 * Safe to call even if not connected.
 */
export async function disconnect(): Promise<void> {
  if (client) {
    logger.info('📦 Closing MongoDB connection');
    await client.close();
    client = null;
    db = null;
    logger.info('✅ MongoDB connection closed');
  }
}

/**
 * Health check: ping MongoDB and measure latency.
 * Returns status and latency in milliseconds.
 */
export async function healthCheck(): Promise<{ status: 'ok' | 'down'; latencyMs: number }> {
  try {
    const start = Date.now();
    const database = getDb();
    await database.admin().ping();
    const latencyMs = Date.now() - start;
    return { status: 'ok', latencyMs };
  } catch (error) {
    logger.error('MongoDB health check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'down', latencyMs: -1 };
  }
}
