import { Request, Response } from 'express';
import { APP_VERSION } from './version';

export interface ApiResponseMeta {
  requestId?: string;
  timestamp: string;
  version: string;
  [key: string]: any;
}

export interface ApiPaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface ApiResponseEnvelope<T = any> {
  success: boolean;
  code?: string;
  message?: string;
  data?: T;
  pagination?: ApiPaginationMeta;
  meta: ApiResponseMeta;
}

export function buildMeta(req?: Request, extra?: Record<string, any>): ApiResponseMeta {
  return {
    requestId: req?.id || (req?.headers ? (req.headers['x-request-id'] as string) : undefined),
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    ...extra,
  };
}

export function apiSuccess<T>(
  res: Response,
  data: T,
  options?: {
    statusCode?: number;
    message?: string;
    code?: string;
    meta?: Record<string, any>;
    req?: Request;
  }
): Response {
  const statusCode = options?.statusCode ?? 200;
  const payload: ApiResponseEnvelope<T> = {
    success: true,
    code: options?.code ?? 'OK',
    message: options?.message,
    data,
    meta: buildMeta(options?.req, options?.meta),
  };
  return res.status(statusCode).json(payload);
}

export function apiError(
  res: Response,
  message: string,
  options?: {
    statusCode?: number;
    code?: string;
    errors?: any;
    meta?: Record<string, any>;
    req?: Request;
  }
): Response {
  const statusCode = options?.statusCode ?? 400;
  const payload: ApiResponseEnvelope<null> = {
    success: false,
    code: options?.code ?? (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST'),
    message,
    data: options?.errors ?? null,
    meta: buildMeta(options?.req, options?.meta),
  };
  return res.status(statusCode).json(payload);
}

export function apiPaginated<T>(
  res: Response,
  data: T[],
  pagination: { page: number; limit: number; total: number },
  options?: {
    statusCode?: number;
    message?: string;
    code?: string;
    meta?: Record<string, any>;
    req?: Request;
  }
): Response {
  const totalPages = Math.ceil(pagination.total / Math.max(1, pagination.limit));
  const paginationMeta: ApiPaginationMeta = {
    page: pagination.page,
    limit: pagination.limit,
    total: pagination.total,
    totalPages,
    hasNext: pagination.page < totalPages,
    hasPrev: pagination.page > 1,
  };

  const payload: ApiResponseEnvelope<T[]> = {
    success: true,
    code: options?.code ?? 'OK',
    message: options?.message,
    data,
    pagination: paginationMeta,
    meta: buildMeta(options?.req, options?.meta),
  };
  return res.status(options?.statusCode ?? 200).json(payload);
}
