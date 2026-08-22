const ENROLLMENT_ALLOWED: Array<{ method: string; suffix: string }> = [
  { method: "GET", suffix: "/auth/mfa/status" },
  { method: "POST", suffix: "/auth/mfa/setup" },
  { method: "POST", suffix: "/auth/mfa/confirm" },
  { method: "POST", suffix: "/auth/change-password" },
  { method: "GET", suffix: "/auth/profile" },
];

export function normalizeRequestPath(originalUrl: string): string {
  const path = String(originalUrl || "").split("?")[0];
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path || "/";
}

/** Paths a required-MFA user may call before TOTP enrollment completes. */
export function isMfaEnrollmentAllowedPath(method: string, originalUrl: string): boolean {
  const path = normalizeRequestPath(originalUrl);
  const verb = String(method || "GET").toUpperCase();
  return ENROLLMENT_ALLOWED.some((rule) => verb === rule.method && path.endsWith(rule.suffix));
}
