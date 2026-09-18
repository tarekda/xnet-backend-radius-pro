/**
 * Subscriber invoice email delivery.
 *
 * Renders an invoice (or credit note) into an email and sends it over the
 * configured SMTP transport. The subscriber's address comes from the invoice
 * record, falling back to their profile contact details.
 */
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { UserDetails } from "../db/entities/UserDetails";
import { sendEmail } from "./emailService";

export type InvoiceEmailOptions = {
  /** Absolute URL to the printable invoice, when the caller knows its origin. */
  printUrl?: string | null;
  /** Overrides the address on file — used to send a copy elsewhere. */
  overrideTo?: string | null;
  /** Optional operator note rendered above the invoice table. */
  note?: string | null;
};

export type InvoiceEmailResult =
  | { sent: true; to: string[]; subject: string }
  | { sent: false; reason: string };

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatMoney(value: number): string {
  return round(Number(value) || 0).toFixed(2);
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString();
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Billed total, collected amount, and what is still outstanding. */
export function invoiceAmounts(invoice: ExternalInvoice) {
  const billed = Number(invoice.totalAmount ?? invoice.amount ?? 0);
  const paid = Number(invoice.amountPaid ?? 0);
  return { billed: round(billed), paid: round(paid), remaining: round(billed - paid) };
}

/** Prefers the invoice's own address, then the subscriber's profile email. */
export async function resolveExternalInvoiceEmail(
  invoice: ExternalInvoice
): Promise<string> {
  const stored = String(invoice.email ?? "").trim();
  if (stored) return stored;

  const details = await AppDataSource.getRepository(UserDetails).findOne({
    where: { username: invoice.username },
  });
  return String(details?.email ?? "").trim();
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function buildInvoiceEmail(invoice: ExternalInvoice, options: InvoiceEmailOptions = {}) {
  const isCreditNote = invoice.documentType === "credit_note";
  const { billed, paid, remaining } = invoiceAmounts(invoice);
  const docLabel = isCreditNote ? "Credit note" : "Invoice";
  const subject = `${docLabel} #${invoice.id} · ${invoice.billingMonth} · ${formatMoney(billed)} USD`;

  const rows: Array<[string, string]> = [
    ["Subscriber", invoice.fullName || invoice.username],
    ["Username", invoice.username],
    ["Billing month", invoice.billingMonth],
    ["Status", String(invoice.status).toUpperCase()],
    ["Billed", `${formatMoney(billed)} USD`],
  ];
  if (paid > 0) rows.push(["Collected", `${formatMoney(paid)} USD`]);
  if (remaining > 0 && !isCreditNote) rows.push(["Outstanding", `${formatMoney(remaining)} USD`]);
  if (invoice.payDueDate) rows.push(["Pay by", formatDate(invoice.payDueDate)]);
  rows.push(["Issued", formatDate(invoice.createdAt)]);
  if (invoice.paidAt) rows.push(["Paid on", formatDate(invoice.paidAt)]);

  const text = [
    `Dear ${invoice.fullName || invoice.username},`,
    "",
    options.note ? `${options.note}\n` : "",
    `${docLabel} for ${invoice.billingMonth}`,
    ...rows.map(([label, value]) => `  ${label}: ${value}`),
    "",
    options.printUrl ? `View or download the ${docLabel.toLowerCase()}: ${options.printUrl}` : "",
    "",
    "Thank you,",
    process.env.SMTP_FROM_NAME || "XNet RADIUS Pro",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const accent = isCreditNote ? "#0ea5e9" : remaining > 0 ? "#d97706" : "#059669";

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;color:#0f172a">
  <div style="border-left:4px solid ${accent};padding:12px 16px;background:#f8fafc">
    <h2 style="margin:0 0 4px;font-size:17px">${escapeHtml(docLabel)} #${escapeHtml(invoice.id)}</h2>
    <div style="font-size:12px;font-weight:600;color:${accent}">${escapeHtml(invoice.billingMonth)} · ${escapeHtml(String(invoice.status).toUpperCase())}</div>
  </div>
  <p style="margin:14px 0 4px;font-size:14px">Dear ${escapeHtml(invoice.fullName || invoice.username)},</p>
  ${options.note ? `<p style="margin:0 0 10px;font-size:14px;color:#334155">${escapeHtml(options.note)}</p>` : ""}
  <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:10px">
    ${rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:6px 8px;color:#64748b;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 8px;font-weight:500">${escapeHtml(value)}</td></tr>`
      )
      .join("")}
  </table>
  ${
    remaining > 0 && !isCreditNote
      ? `<p style="margin:16px 0 0;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:14px">
           <strong>Amount due: ${escapeHtml(formatMoney(remaining))} USD</strong>
         </p>`
      : ""
  }
  ${
    options.printUrl
      ? `<p style="margin:18px 0 0">
           <a href="${escapeHtml(options.printUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:600">
             View ${escapeHtml(docLabel.toLowerCase())}
           </a>
         </p>`
      : ""
  }
  <p style="margin-top:20px;font-size:11px;color:#94a3b8">
    Sent by ${escapeHtml(process.env.SMTP_FROM_NAME || "XNet RADIUS Pro")}
  </p>
</div>`;

  return { subject, text, html, rows };
}

/** Renders and sends an invoice email. Never throws — returns a result object. */
export async function sendExternalInvoiceEmail(
  invoice: ExternalInvoice,
  options: InvoiceEmailOptions = {}
): Promise<InvoiceEmailResult> {
  const override = String(options.overrideTo ?? "").trim();
  const to = override || (await resolveExternalInvoiceEmail(invoice));

  if (!to) {
    return {
      sent: false,
      reason: "No email address is on file for this subscriber — set one on the invoice or subscriber profile",
    };
  }
  if (!isLikelyEmail(to)) {
    return { sent: false, reason: `"${to}" does not look like a valid email address` };
  }

  const { subject, text, html } = buildInvoiceEmail(invoice, options);
  const result = await sendEmail({ to, subject, text, html });

  if (!result.sent) return { sent: false, reason: result.reason };
  return { sent: true, to: result.accepted.length > 0 ? result.accepted : [to], subject };
}
