import { Request, Response, NextFunction } from "express";

export interface CsrfOptions {
  exemptPaths?: string[];
  cookieName?: string;
  headerName?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Enterprise CSRF protection middleware for REST APIs.
 *
 * Protects against Cross-Site Request Forgery on state-changing requests (POST, PUT, DELETE, PATCH).
 * - Safe HTTP methods (GET, HEAD, OPTIONS) are exempt.
 * - Requests with a valid Authorization Bearer token header or valid custom header
 *   (X-Requested-With, X-CSRF-Token) are exempt because cross-origin form submits
 *   cannot set custom headers without preflight CORS approval.
 * - Webhooks with external signatures are exempt.
 */
export function csrfProtectionMiddleware(options: CsrfOptions = {}) {
  const exemptPaths = options.exemptPaths || [
    "/api/webhooks/",
    "/health",
    "/ready",
    "/metrics",
    "/api/auth/login",
    "/api/auth/subscriber/",
    "/api/auth/mobile/",
    "/api/auth/mfa/verify-login",
    "/api/auth/refresh-token",
    "/api/subscriber/login",
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Safe methods bypass CSRF verification
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    // 2. Explicit exempt path prefixes
    const originalPath = (req.originalUrl || "").split("?")[0];
    const path = req.path || "";
    if (exemptPaths.some((prefix) => originalPath.startsWith(prefix) || path.startsWith(prefix))) {
      next();
      return;
    }

    // 3. If request contains an Authorization Bearer header, browser same-site CSRF is mitigated
    const authHeader = req.headers["authorization"] || "";
    if (typeof authHeader === "string" && authHeader.trim().toLowerCase().startsWith("bearer ")) {
      next();
      return;
    }

    // 4. Verify custom anti-CSRF request headers
    const customHeader = req.headers["x-requested-with"] || req.headers["x-csrf-token"];
    if (customHeader) {
      next();
      return;
    }

    // 5. Verify Origin / Referer matches the Host
    const host = req.headers["host"] || "";
    const origin = req.headers["origin"] || "";
    const referer = req.headers["referer"] || "";

    if (origin && typeof origin === "string") {
      try {
        const originUrl = new URL(origin);
        if (originUrl.host === host) {
          next();
          return;
        }
      } catch {}
    }

    if (referer && typeof referer === "string") {
      try {
        const refererUrl = new URL(referer);
        if (refererUrl.host === host) {
          next();
          return;
        }
      } catch {}
    }

    // In local development, permit requests from common dev ports
    if (process.env.NODE_ENV !== "production") {
      const allowedDevOrigins = ["localhost", "127.0.0.1", "5173", "3000"];
      if (allowedDevOrigins.some((d) => (origin && origin.includes(d)) || (referer && referer.includes(d)))) {
        next();
        return;
      }
    }

    console.warn(`[security] CSRF check failed for ${req.method} ${path} from origin: "${origin}" host: "${host}"`);
    res.status(403).json({
      success: false,
      message: "Forbidden: CSRF validation failed. Missing anti-CSRF token or mismatched origin.",
    });
    return;
  };
}
