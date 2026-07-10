import { Request, Response, NextFunction } from "express";
import { coerceToAppError } from "../errors/AppError";

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const appErr = coerceToAppError(err);

  if (appErr.statusCode >= 500) {
    console.error(err instanceof Error ? err.stack || err.message : err);
  } else {
    console.warn(`[${appErr.code}] ${appErr.message}`);
  }

  res.status(appErr.statusCode).json({
    success: false,
    message: appErr.expose ? appErr.message : "Internal Server Error",
    code: appErr.code,
    requestId: (req as { requestId?: string }).requestId,
  });
};
