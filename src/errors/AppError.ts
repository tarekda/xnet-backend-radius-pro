/**
 * Typed application errors so the Express error handler can map to correct HTTP status
 * and a consistent JSON envelope instead of always returning 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(message: string, statusCode = 500, code = "INTERNAL_ERROR", expose = statusCode < 500) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", code = "BAD_REQUEST") {
    super(message, 400, code, true);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code = "UNAUTHORIZED") {
    super(message, 401, code, true);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code = "FORBIDDEN") {
    super(message, 403, code, true);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", code = "NOT_FOUND") {
    super(message, 404, code, true);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", code = "CONFLICT") {
    super(message, 409, code, true);
    this.name = "ConflictError";
  }
}

/** Map common thrown Error messages from legacy services into AppError. */
export function coerceToAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : "Internal Server Error";
  const lower = message.toLowerCase();
  const status = typeof (err as { status?: unknown })?.status === "number"
    ? (err as { status: number }).status
    : undefined;
  if (status && status >= 400 && status < 500) {
    return new AppError(message, status, status === 400 ? "BAD_REQUEST" : "CLIENT_ERROR", true);
  }
  if (lower === "invoice not found" || lower.includes("not found")) {
    return new NotFoundError(message);
  }
  if (lower === "forbidden" || lower.includes("forbidden")) {
    return new ForbiddenError(message);
  }
  if (
    lower.includes("not collected") ||
    lower.includes("only cash") ||
    lower.includes("required") ||
    lower.includes("invalid") ||
    lower.includes("insufficient") ||
    lower.includes("exceeds remaining") ||
    lower.includes("must be greater") ||
    lower.includes("must be positive")
  ) {
    return new BadRequestError(message);
  }
  return new AppError(message, 500, "INTERNAL_ERROR", false);
}
