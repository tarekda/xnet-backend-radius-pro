// src/logger/index.ts
import winston from 'winston';
import expressWinston from 'express-winston';
import { Request, Response, NextFunction } from 'express';
import { getRepository } from 'typeorm';
import { Logs } from '../db/entities/Logs'; // Adjust the path as needed
import { TypeOrmTransport } from './TypeormTransport';
import { AppDataSource } from '../db/config';

function isJsonLoggingEnabled() {
  const v = String(process.env.LOG_FORMAT || "").toLowerCase();
  if (v === "json") return true;
  // default to JSON logs in production so Loki parsing is clean
  return process.env.NODE_ENV === "production";
}

export function serializeMetaValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * Winston drops extra log arguments (e.g. `logger.error("failed", err)`) because they
 * live under a splat symbol that format.json() ignores, and Error properties are
 * non-enumerable. This format lifts them into an explicit `meta` field so error
 * details survive in console, file, JSON, and DB transports.
 */
const captureMeta = winston.format((info) => {
  const splat = (info as Record<PropertyKey, unknown>)[Symbol.for("splat")];
  if (Array.isArray(splat) && splat.length > 0) {
    const serialized = splat.map(serializeMetaValue);
    const existing = (info as Record<string, unknown>).meta;
    const merged = serialized.length === 1 ? serialized[0] : serialized;
    (info as Record<string, unknown>).meta = existing ? [existing, merged].flat() : merged;
  }
  return info;
});

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable meta]";
  }
}

function baseFormat() {
  if (isJsonLoggingEnabled()) {
    return winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      captureMeta(),
      winston.format.json()
    );
  }

  return winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    captureMeta(),
    winston.format.printf((info) => {
      const msg = info.message ?? "";
      const meta = (info as Record<string, unknown>).meta;
      const metaStr = meta !== undefined ? ` ${safeStringify(meta)}` : "";
      const stackStr = info.stack ? `\n${info.stack}` : "";
      return `${info.timestamp} ${info.level}: ${msg}${metaStr}${stackStr}`;
    })
  );
}

class Logger {
  private static instance: winston.Logger;

  private static createLogger(params?: { level?: string; format?: winston.Logform.Format }): winston.Logger {
    const baseTransports: winston.transport[] = [
      new winston.transports.Console(),
      new winston.transports.File({ filename: 'combined.log' })
    ];

    // Only add TypeORM transport if DataSource is initialized
    if (AppDataSource.isInitialized) {
      try {
        const logRepository = AppDataSource.getRepository(Logs);
        baseTransports.push(new TypeOrmTransport({ repository: logRepository }));
      } catch (err) {
        console.warn('🟡 Logger: Unable to attach TypeORM transport (repository not available yet). Falling back to file/console.', err);
      }
    } else {
      console.warn('🟡 Logger: AppDataSource not initialized. Using file/console transports only.');
    }

    return winston.createLogger({
      level: params?.level || 'info',
      format: params?.format || baseFormat(),
      transports: baseTransports
    });
  }

  // Private constructor to enforce singleton
  private constructor() {}

  public static getInstance(params?: { level?: string; format?: winston.Logform.Format }): winston.Logger {
    if (!Logger.instance) {
      Logger.instance = Logger.createLogger(params);
    } else if (AppDataSource.isInitialized && !(Logger.instance.transports.some(t => t instanceof TypeOrmTransport))) {
      // Add DB transport dynamically once DataSource is ready
      try {
        const logRepository = AppDataSource.getRepository(Logs);
        Logger.instance.add(new TypeOrmTransport({ repository: logRepository }));
        console.log('✅ Logger: TypeORM transport attached after DataSource initialization');
      } catch (err) {
        console.warn('🟡 Logger: Failed to add TypeORM transport post-initialization', err);
      }
    }
    return Logger.instance;
  }
}

// Middleware to log all requests using the singleton logger instance
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const log = Logger.getInstance();
  log.info('Incoming request', {
    requestId: (req as any).requestId,
    method: req.method,
    url: req.url,
  });
  next();
}

// Express-Winston middleware (using our custom TypeOrmTransport)
export const loggerMiddleware = expressWinston.logger({
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' })
    // DB transport will be added dynamically once DataSource is ready
  ],
  format: baseFormat(),
  dynamicMeta: (req) => ({
    requestId: (req as any).requestId,
  }),
  // keep express-winston message consistent
  msg: "HTTP {{req.method}} {{req.url}}",
});

export { Logger };
