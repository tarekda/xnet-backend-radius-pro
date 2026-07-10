/**
 * Fail fast in production when critical secrets are missing or still set to
 * known insecure defaults. Dev/test may keep fallbacks for local convenience.
 */

const INSECURE_DEFAULTS = new Set([
  "your_jwt_secret",
  "your_refresh_jwt_secret",
  "your_secret",
  "123456",
  "password",
  "changeme",
  "change_me",
  "secret",
]);

function isProduction(): boolean {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function isInsecure(value: string | undefined): boolean {
  if (!value || !value.trim()) return true;
  return INSECURE_DEFAULTS.has(value.trim());
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (isProduction() && isInsecure(secret)) {
    throw new Error(
      "FATAL: JWT_SECRET must be set to a strong non-default value in production"
    );
  }
  return secret || "your_jwt_secret";
}

export function getRefreshTokenSecret(): string {
  const secret = process.env.REFRESH_TOKEN_SECRET;
  if (isProduction() && isInsecure(secret)) {
    throw new Error(
      "FATAL: REFRESH_TOKEN_SECRET must be set to a strong non-default value in production"
    );
  }
  return secret || "your_refresh_jwt_secret";
}

export function getMikroTikPassword(): string | undefined {
  const password = process.env.MIKROTIK_PASSWORD;
  const trimmed = password?.trim();

  // Never invent a production password. If the operator set one explicitly
  // (even a weak one), use it — blanking it silently breaks bandwidth/API.
  if (trimmed) {
    if (isProduction() && isInsecure(trimmed)) {
      console.warn(
        "WARNING: MIKROTIK_PASSWORD is a known weak default; change it on the router and in .env"
      );
    }
    return trimmed;
  }

  if (isProduction()) {
    console.warn(
      "WARNING: MIKROTIK_PASSWORD is not set; MikroTik API calls will fail authentication"
    );
    return undefined;
  }

  return "123456";
}

export function getRadiusSecret(): string {
  const secret = process.env.RADIUS_SECRET;
  if (isProduction() && isInsecure(secret)) {
    throw new Error(
      "FATAL: RADIUS_SECRET must be set to a strong non-default value in production"
    );
  }
  return secret || "your_secret";
}

/** Call once at process start before listening. */
export function assertProductionSecrets(): void {
  if (!isProduction()) return;
  // Touch getters so missing secrets throw before the server accepts traffic.
  getJwtSecret();
  getRefreshTokenSecret();
  getRadiusSecret();
}
