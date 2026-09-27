/**
 * Simple structured logger.
 * Production would use winston or pino, but this is sufficient for the assignment.
 */

import { env } from '../config/env.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[env.LOG_LEVEL];
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('debug')) {
      console.log(formatMessage('debug', message, meta));
    }
  },

  info(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('info')) {
      console.log(formatMessage('info', message, meta));
    }
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('warn')) {
      console.warn(formatMessage('warn', message, meta));
    }
  },

  error(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('error')) {
      console.error(formatMessage('error', message, meta));
    }
  },
};
