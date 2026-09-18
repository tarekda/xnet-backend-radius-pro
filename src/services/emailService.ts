/**
 * SMTP email transport.
 *
 * Configuration comes from the environment so the app can point at any mail
 * host (Gmail, Office 365, cPanel, a local relay). When SMTP is not configured
 * every send reports a clear failure — it never reports a fake success.
 */
import nodemailer, { type Transporter } from "nodemailer";

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
};

export type SendEmailResult =
  | { sent: true; messageId: string; accepted: string[]; rejected: string[] }
  | { sent: false; reason: string };

export type EmailConfigSummary = {
  configured: boolean;
  issue: string | null;
  host: string | null;
  port: number;
  secure: boolean;
  from: string | null;
  hasAuth: boolean;
};

let cachedTransport: Transporter | null = null;
let cachedKey = "";

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function smtpPort(): number {
  const parsed = parseInt(env("SMTP_PORT"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 587;
}

/** Implicit TLS defaults to on for port 465, off otherwise. */
function smtpSecure(): boolean {
  const raw = env("SMTP_SECURE").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return smtpPort() === 465;
}

function fromAddress(): string {
  return env("SMTP_FROM") || env("SMTP_USER");
}

function fromName(): string {
  return env("SMTP_FROM_NAME") || "XNet RADIUS Pro";
}

export function isEmailConfigured(): boolean {
  return Boolean(env("SMTP_HOST") && fromAddress());
}

/** Human-readable reason SMTP is unusable, or null when it is configured. */
export function emailConfigIssue(): string | null {
  if (!env("SMTP_HOST")) return "SMTP_HOST is not set";
  if (!fromAddress()) return "SMTP_FROM (or SMTP_USER) is not set";
  return null;
}

/** Non-secret summary for diagnostics. Never exposes SMTP_PASS. */
export function emailConfigSummary(): EmailConfigSummary {
  const from = fromAddress();
  return {
    configured: isEmailConfigured(),
    issue: emailConfigIssue(),
    host: env("SMTP_HOST") || null,
    port: smtpPort(),
    secure: smtpSecure(),
    from: from ? `${fromName()} <${from}>` : null,
    hasAuth: Boolean(env("SMTP_USER") && env("SMTP_PASS")),
  };
}

function getTransport(): Transporter {
  // Credentials are part of the key so a rotated password rebuilds the pool.
  const key = [
    env("SMTP_HOST"),
    String(smtpPort()),
    String(smtpSecure()),
    env("SMTP_USER"),
    env("SMTP_PASS"),
  ].join("|");

  if (cachedTransport && cachedKey === key) return cachedTransport;

  cachedTransport?.close?.();

  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");

  cachedTransport = nodemailer.createTransport({
    host: env("SMTP_HOST"),
    port: smtpPort(),
    secure: smtpSecure(),
    auth: user ? { user, pass } : undefined,
    // Only relax certificate checks when explicitly opted in.
    tls: env("SMTP_ALLOW_SELF_SIGNED") === "1" ? { rejectUnauthorized: false } : undefined,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cachedKey = key;
  return cachedTransport;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    return { sent: false, reason: emailConfigIssue() ?? "SMTP is not configured" };
  }

  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  if (recipients.length === 0) return { sent: false, reason: "No recipients provided" };

  try {
    const info = await getTransport().sendMail({
      from: `"${fromName()}" <${fromAddress()}>`,
      to: recipients.join(", "),
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      attachments: input.attachments,
    });

    return {
      sent: true,
      messageId: String(info.messageId ?? ""),
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Verifies SMTP connectivity and credentials without sending a message. */
export async function verifyEmailTransport(): Promise<{ ok: boolean; message: string }> {
  if (!isEmailConfigured()) {
    return { ok: false, message: emailConfigIssue() ?? "SMTP is not configured" };
  }
  try {
    await getTransport().verify();
    return {
      ok: true,
      message: `SMTP connection to ${env("SMTP_HOST")}:${smtpPort()} succeeded`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Drops the pooled transport, e.g. after rotating SMTP credentials. */
export function resetEmailTransport(): void {
  cachedTransport?.close?.();
  cachedTransport = null;
  cachedKey = "";
}
