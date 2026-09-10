import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

/**
 * Middleware that assigns a unique Request ID to each incoming HTTP request.
 * If the client already supplies an `X-Request-Id` header (e.g. from an API gateway,
 * load balancer, or Next.js proxy), that ID is preserved for end-to-end tracing.
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incomingId = (req.headers['x-request-id'] as string) || (req.headers['x-correlation-id'] as string);
  const requestId = incomingId && incomingId.trim().length > 0
    ? incomingId.trim()
    : crypto.randomUUID();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};
