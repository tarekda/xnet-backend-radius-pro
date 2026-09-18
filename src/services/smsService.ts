/**
 * Twilio SMS transport.
 *
 * Reuses the Twilio account already configured for WhatsApp: the account SID
 * plus either an API-key pair or the account auth token. Recipients are sent
 * one at a time because Twilio's Messages API accepts a single `To` per call.
 */
import axios from "axios";

export type SendSmsInput = {
  to: string | string[];
  body: string;
};

export type SendSmsResult =
  | { sent: true; sid: string; status: string; to: string[]; failed: string[] }
  | { sent: false; reason: string };

export type SmsConfigSummary = {
  configured: boolean;
  issue: string | null;
  from: string | null;
  messagingServiceSid: string | null;
  authMode: "api-key" | "auth-token" | null;
};

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function accountSid(): string {
  return env("TWILIO_ACCOUNT_SID");
}

/** API-key pair wins when a secret is present, matching whatsappService. */
function auth(): { username: string; password: string } | null {
  const apiKeySid = env("TWILIO_API_KEY_SID");
  const apiKeySecret = env("TWILIO_API_KEY_SECRET");
  if (apiKeySid && apiKeySecret) return { username: apiKeySid, password: apiKeySecret };

  const authToken = env("TWILIO_AUTH_TOKEN");
  if (authToken) return { username: accountSid(), password: authToken };

  return null;
}

function smsFrom(): string {
  return env("TWILIO_SMS_FROM");
}

function messagingServiceSid(): string {
  return env("TWILIO_MESSAGING_SERVICE_SID");
}

export function isSmsConfigured(): boolean {
  return Boolean(accountSid() && auth() && (smsFrom() || messagingServiceSid()));
}

/** Human-readable reason SMS is unusable, or null when it is configured. */
export function smsConfigIssue(): string | null {
  if (!accountSid()) return "TWILIO_ACCOUNT_SID is not set";
  if (!auth()) return "Set TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET";
  if (!smsFrom() && !messagingServiceSid()) {
    return "Set TWILIO_SMS_FROM (E.164) or TWILIO_MESSAGING_SERVICE_SID";
  }
  return null;
}

/** Non-secret summary for diagnostics. Never exposes the auth token. */
export function smsConfigSummary(): SmsConfigSummary {
  const authMode = env("TWILIO_API_KEY_SID") && env("TWILIO_API_KEY_SECRET")
    ? "api-key"
    : env("TWILIO_AUTH_TOKEN")
      ? "auth-token"
      : null;

  return {
    configured: isSmsConfigured(),
    issue: smsConfigIssue(),
    from: smsFrom() || null,
    messagingServiceSid: messagingServiceSid() || null,
    authMode,
  };
}

/** Keeps a leading `+` and strips every other non-digit character. */
function normalizeNumber(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  if (!isSmsConfigured()) {
    return { sent: false, reason: smsConfigIssue() ?? "Twilio SMS is not configured" };
  }

  const credentials = auth() as { username: string; password: string };
  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map(normalizeNumber)
    .filter(Boolean);

  if (recipients.length === 0) return { sent: false, reason: "No recipients provided" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid()}/Messages.json`;
  const sentTo: string[] = [];
  const failedTo: string[] = [];
  const errors: string[] = [];
  let lastSid = "";
  let lastStatus = "";

  for (const to of recipients) {
    const params: Record<string, string> = { To: to, Body: input.body };
    if (messagingServiceSid()) params.MessagingServiceSid = messagingServiceSid();
    else params.From = smsFrom();

    try {
      const response = await axios.post(url, new URLSearchParams(params).toString(), {
        auth: credentials,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 12_000,
      });
      lastSid = String(response.data?.sid ?? "");
      lastStatus = String(response.data?.status ?? "");
      sentTo.push(to);
    } catch (err: unknown) {
      const detail =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : String(err);
      failedTo.push(to);
      errors.push(`${to}: ${detail}`);
    }
  }

  if (sentTo.length === 0) {
    return { sent: false, reason: errors.join("; ") || "Twilio rejected every recipient" };
  }

  return { sent: true, sid: lastSid, status: lastStatus, to: sentTo, failed: failedTo };
}
