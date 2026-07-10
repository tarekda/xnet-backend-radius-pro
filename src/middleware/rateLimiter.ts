import rateLimit from "express-rate-limit";

/** General API limiter (authenticated app traffic). */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests from this IP, please try again later." },
  // trust proxy is set to 1 hop in server.ts; silence permissive-proxy validation noise
  validate: { trustProxy: false },
});

/** Stricter limiter for password login (credential stuffing). */
export const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts. Please try again later." },
  validate: { trustProxy: false },
});

/** Refresh-token limiter (slightly higher than login; still blocks abuse). */
export const authRefreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many token refresh attempts. Please try again later." },
  validate: { trustProxy: false },
});
