import crypto from "crypto";
import { Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { PaymentIntent } from "../db/entities/PaymentIntent";
import { payExternalInvoice } from "./invoiceService";
import {
  createWhishPaymentInvoice,
  isWhishConfigured,
  resolveWhishAmount,
  type WhishCurrency,
} from "./whishGateway";

export type PaymentProvider = "stub" | "whish";

function webhookSecret(): string {
  return process.env.PAYMENT_WEBHOOK_SECRET || process.env.JWT_SECRET || "dev-webhook-secret";
}

function publicApiBase(): string {
  return (
    process.env.PUBLIC_API_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    "http://localhost:3000/api"
  ).replace(/\/$/, "");
}

function publicAppBase(): string {
  return (
    process.env.PUBLIC_APP_BASE_URL ||
    process.env.FRONTEND_PUBLIC_URL ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
}

export function resolvePaymentProvider(): PaymentProvider {
  const forced = String(process.env.PAYMENT_PROVIDER || "")
    .trim()
    .toLowerCase();
  if (forced === "stub" || forced === "whish") return forced;
  return isWhishConfigured() ? "whish" : "stub";
}

export function getPaymentProviderStatus() {
  const provider = resolvePaymentProvider();
  const currency =
    (process.env.PAYMENT_CURRENCY || "USD").toUpperCase() === "LBP" ? "LBP" : "USD";
  const qrImageUrl = String(process.env.WHISH_QR_IMAGE_URL || "").trim();
  const qrEnabled =
    String(process.env.WHISH_QR_ENABLED || "").toLowerCase() === "1" ||
    String(process.env.WHISH_QR_ENABLED || "").toLowerCase() === "true" ||
    Boolean(qrImageUrl);
  const qrLabel = String(process.env.WHISH_QR_LABEL || "Xnet Whish Pay").trim();
  const qrHint = String(
    process.env.WHISH_QR_HINT ||
      "Scan with the Whish Money app, enter the exact invoice amount, then refresh this page."
  ).trim();
  const qrDeepLink = String(
    process.env.WHISH_QR_DEEP_LINK || "https://www.whish.money/add-transfer?id=71158661"
  ).trim();

  return {
    provider,
    whishConfigured: isWhishConfigured(),
    currency,
    /** Static Whish Me / receive QR for subscribers to scan */
    qrEnabled,
    qrImageUrl: qrImageUrl || (qrEnabled ? "/whish-pay-qr.png" : null),
    qrLabel,
    qrHint,
    /** Direct Whish add-transfer URL encoded in the QR (tap-to-open on mobile) */
    qrDeepLink: qrDeepLink || null,
  };
}

function splitName(fullName: string | null | undefined): { firstName?: string; lastName?: string } {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function resolvePayerContact(invoice: ExternalInvoice): { email: string; phone: string } {
  const email =
    (invoice.email && String(invoice.email).trim()) ||
    (process.env.WHISH_DEFAULT_EMAIL && String(process.env.WHISH_DEFAULT_EMAIL).trim()) ||
    "";
  const phone =
    (invoice.phoneNumber && String(invoice.phoneNumber).trim()) ||
    (process.env.WHISH_DEFAULT_PHONE && String(process.env.WHISH_DEFAULT_PHONE).trim()) ||
    "";
  return { email, phone };
}

async function createStubIntent(invoice: ExternalInvoice, amount: number, currency: string) {
  const gatewayIntentId = `stub_${invoice.id}_${crypto.randomBytes(8).toString("hex")}`;
  const checkoutUrl = `${publicApiBase()}/webhooks/payments/stub/simulate?intent=${encodeURIComponent(gatewayIntentId)}`;
  const repo = AppDataSource.getRepository(PaymentIntent);
  return repo.save(
    repo.create({
      externalInvoiceId: invoice.id!,
      gatewayProvider: "stub",
      gatewayIntentId,
      status: "pending",
      amount,
      currency,
      checkoutUrl,
      metadata: { username: invoice.username },
    })
  );
}

async function createWhishIntent(invoice: ExternalInvoice, amountUsd: number, currency: WhishCurrency) {
  const { email, phone } = resolvePayerContact(invoice);
  if (!email || !phone) {
    throw new Error(
      "Whish requires payer email and phone. Set them on the invoice, or configure WHISH_DEFAULT_EMAIL and WHISH_DEFAULT_PHONE."
    );
  }

  const gatewayIntentId = `whish_${invoice.id}_${Date.now()}`;
  const amount = resolveWhishAmount(amountUsd, currency);
  const { firstName, lastName } = splitName(invoice.fullName);
  const invoiceLabel = `Invoice #${invoice.id} · ${invoice.username || ""}`.slice(0, 480);

  const { payUrl } = await createWhishPaymentInvoice({
    orderId: gatewayIntentId,
    invoice: invoiceLabel,
    amount,
    currency,
    email,
    phone,
    firstName,
    lastName,
    userLogin: invoice.username || undefined,
  });

  const repo = AppDataSource.getRepository(PaymentIntent);
  return repo.save(
    repo.create({
      externalInvoiceId: invoice.id!,
      gatewayProvider: "whish",
      gatewayIntentId,
      status: "pending",
      amount,
      currency,
      checkoutUrl: payUrl,
      metadata: {
        username: invoice.username,
        amountUsd,
        successRedirect: `${publicAppBase()}/subscriber?paid=1`,
        failureRedirect: `${publicAppBase()}/subscriber?paid=0`,
      },
    })
  );
}

export async function createPaymentIntent(externalInvoiceId: number) {
  const invoice = await AppDataSource.getRepository(ExternalInvoice).findOne({
    where: { id: Equal(externalInvoiceId) },
  });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status === "paid") throw new Error("Invoice already paid");

  const amountUsd = Number(invoice.totalAmount ?? invoice.amount ?? 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("Invoice has no payable amount");
  }

  const repo = AppDataSource.getRepository(PaymentIntent);
  const existing = await repo.findOne({
    where: { externalInvoiceId: Equal(externalInvoiceId), status: Equal("pending") as any },
  });
  if (existing) return existing;

  const provider = resolvePaymentProvider();
  const currencyRaw = (process.env.PAYMENT_CURRENCY || "USD").toUpperCase();
  const currency: WhishCurrency = currencyRaw === "LBP" ? "LBP" : "USD";

  if (provider === "whish") {
    return createWhishIntent(invoice, amountUsd, currency);
  }
  return createStubIntent(invoice, amountUsd, currency);
}

export function signWebhookPayload(body: string): string {
  return crypto.createHmac("sha256", webhookSecret()).update(body).digest("hex");
}

export function verifyWebhookSignature(body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = signWebhookPayload(body);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Accept HMAC signature, or Whish merchant secret in header/query (codnloc callbacks). */
export function verifyProviderWebhookAuth(opts: {
  provider: string;
  rawBody: string;
  signature?: string;
  secretParam?: string;
}): boolean {
  const relaxed = String(process.env.PAYMENT_WEBHOOK_RELAXED || "").toLowerCase() === "1";
  if (relaxed) return true;
  if (verifyWebhookSignature(opts.rawBody, opts.signature)) return true;

  if (opts.provider === "whish") {
    const expected = String(process.env.WHISH_SECRET || "").trim();
    const provided = String(opts.secretParam || opts.signature || "").trim();
    if (expected && provided && expected === provided) return true;
  }
  return false;
}

function normalizeWebhookStatus(status: string): "succeeded" | "failed" | "pending" {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  if (["succeeded", "success", "paid", "completed", "ok"].includes(s)) return "succeeded";
  if (["failed", "failure", "cancelled", "canceled", "error"].includes(s)) return "failed";
  return "pending";
}

export async function handlePaymentWebhook(
  provider: string,
  payload: { gatewayIntentId: string; status: string }
) {
  const normalizedProvider = String(provider || "").toLowerCase();
  if (normalizedProvider !== "stub" && normalizedProvider !== "whish") {
    throw new Error(`Unsupported payment provider: ${provider}`);
  }

  const gatewayIntentId = String(payload.gatewayIntentId || "").trim();
  if (!gatewayIntentId) throw new Error("Missing gatewayIntentId / order_id");

  const repo = AppDataSource.getRepository(PaymentIntent);
  const intent = await repo.findOne({
    where: { gatewayIntentId: Equal(gatewayIntentId) },
  });
  if (!intent) throw new Error("Payment intent not found");
  if (intent.gatewayProvider !== normalizedProvider && normalizedProvider !== "stub") {
    // Allow stub simulate only for stub intents; whish callbacks must match provider
    if (intent.gatewayProvider !== "whish" || normalizedProvider !== "whish") {
      throw new Error(`Provider mismatch for intent ${gatewayIntentId}`);
    }
  }
  if (intent.status === "succeeded") return intent;

  const status = normalizeWebhookStatus(payload.status);
  if (status === "succeeded") {
    await payExternalInvoice(intent.externalInvoiceId, "gateway", "gateway");
    intent.status = "succeeded";
    intent.updatedAt = new Date();
    await repo.save(intent);
  } else if (status === "failed") {
    intent.status = "failed";
    intent.updatedAt = new Date();
    await repo.save(intent);
  }
  return intent;
}

/** Extract order id + status from flexible Whish/codnloc callback bodies or query strings. */
export function parseWhishCallbackPayload(
  body: Record<string, unknown> | null | undefined,
  query: Record<string, unknown> | null | undefined
): { gatewayIntentId: string; status: string } {
  const src = { ...(query || {}), ...(body || {}) } as Record<string, unknown>;
  const gatewayIntentId = String(
    src.gatewayIntentId ||
      src.order_id ||
      src.orderId ||
      src.externalId ||
      src.intent ||
      ""
  ).trim();
  const status = String(src.status || src.payment_status || src.result || "succeeded").trim();
  return { gatewayIntentId, status };
}

export async function createCreditNote(parentInvoiceId: number, actorUsername: string) {
  const repo = AppDataSource.getRepository(ExternalInvoice);
  const parent = await repo.findOne({ where: { id: Equal(parentInvoiceId) } });
  if (!parent) throw new Error("Invoice not found");
  if (parent.documentType === "credit_note") throw new Error("Cannot credit a credit note");

  const amount = -Math.abs(Number(parent.totalAmount ?? parent.amount ?? 0));
  const note = repo.create({
    username: parent.username,
    email: parent.email,
    address: parent.address,
    amount,
    subtotalAmount: amount,
    taxAmount: 0,
    taxRate: parent.taxRate ?? 0,
    totalAmount: amount,
    status: "paid",
    fullName: parent.fullName,
    phoneNumber: parent.phoneNumber,
    billingMonth: parent.billingMonth,
    payDueDate: parent.payDueDate,
    paidAt: new Date(),
    paymentMethod: "other",
    documentType: "credit_note",
    parentInvoiceId: parent.id!,
    provider: parent.provider,
    debitLabel: `credit:${parent.id}`,
    collectedBy: actorUsername,
    collectedAt: new Date(),
    cashReconciled: false,
    lastAction: "CREDIT_NOTE",
    modifiedBy: actorUsername,
    modifiedAt: new Date(),
  });
  return repo.save(note);
}

export async function getOpenCheckoutUrl(externalInvoiceId: number): Promise<string | null> {
  const intent = await AppDataSource.getRepository(PaymentIntent).findOne({
    where: { externalInvoiceId: Equal(externalInvoiceId), status: Equal("pending") as any },
  });
  return intent?.checkoutUrl ?? null;
}
