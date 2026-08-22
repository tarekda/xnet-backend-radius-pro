export const STAFF_PASSWORD_MIN_LENGTH = 10;

export function validateStaffPassword(password: string): { ok: true } | { ok: false; message: string } {
  if (typeof password !== "string" || password.length < STAFF_PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `Password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters` };
  }
  if (!/[A-Z]/.test(password)) {
    return { ok: false, message: "Password must include an uppercase letter" };
  }
  if (!/[a-z]/.test(password)) {
    return { ok: false, message: "Password must include a lowercase letter" };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, message: "Password must include a number" };
  }
  return { ok: true };
}
