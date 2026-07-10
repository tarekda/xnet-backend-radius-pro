import crypto from "crypto";
import { authenticator } from "otplib";
import { getJwtSecret } from "../config/requireSecrets";

const SERVICE_NAME = process.env.MFA_ISSUER || "XNet Radius Pro";

function encryptionKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY || getJwtSecret();
  return crypto.createHash("sha256").update(String(raw)).digest();
}

export function encryptTotpSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

export function decryptTotpSecret(payload: string): string {
  const [ver, ivB64, tagB64, dataB64] = payload.split(":");
  if (ver !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid TOTP secret payload");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpKeyUri(username: string, secret: string): string {
  return authenticator.keyuri(username, SERVICE_NAME, secret);
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const cleaned = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return authenticator.check(cleaned, secret);
  } catch {
    return false;
  }
}

export function mfaRequiredForRole(role: string | null | undefined): boolean {
  const raw = String(process.env.MFA_REQUIRED_ROLES || "").trim();
  if (!raw) return false;
  const roles = raw.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  return roles.includes(String(role || "").toLowerCase());
}

export function hashBackupCodes(codes: string[]): string {
  return JSON.stringify(
    codes.map((c) => crypto.createHash("sha256").update(c).digest("hex"))
  );
}

export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString("hex")
  );
}

export function consumeBackupCode(
  storedJson: string | null | undefined,
  code: string
): { ok: boolean; remainingJson: string | null } {
  if (!storedJson) return { ok: false, remainingJson: null };
  let hashes: string[];
  try {
    hashes = JSON.parse(storedJson);
  } catch {
    return { ok: false, remainingJson: storedJson };
  }
  const target = crypto.createHash("sha256").update(String(code).trim()).digest("hex");
  const idx = hashes.indexOf(target);
  if (idx < 0) return { ok: false, remainingJson: storedJson };
  const next = hashes.filter((_, i) => i !== idx);
  return { ok: true, remainingJson: next.length ? JSON.stringify(next) : null };
}
