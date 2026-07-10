/**
 * Whish Pay via codnloc gateway (application/x-www-form-urlencoded API).
 * Same integration as electronic-shop — @see https://pay.codnloc.com/api_documentation.html
 *
 * Env: WHISH_WEBSITE, WHISH_SECRET, optional WHISH_API_URL (default https://pay.codnloc.com/api.php)
 */

export type WhishCurrency = "USD" | "LBP";

export function whishGatewayUrl(): string {
  return (process.env.WHISH_API_URL || "https://pay.codnloc.com/api.php").trim();
}

export function isWhishConfigured(): boolean {
  const w = process.env.WHISH_WEBSITE && String(process.env.WHISH_WEBSITE).trim();
  const s = process.env.WHISH_SECRET && String(process.env.WHISH_SECRET).trim();
  return Boolean(w && s);
}

export type CreateWhishInvoiceOpts = {
  orderId: string | number;
  invoice: string;
  amount: number;
  currency: WhishCurrency;
  email: string;
  phone: string;
  firstName?: string;
  lastName?: string;
  userLogin?: string;
};

export async function createWhishPaymentInvoice(
  opts: CreateWhishInvoiceOpts
): Promise<{ payUrl: string }> {
  if (!isWhishConfigured()) {
    const err = new Error("Whish is not configured. Set WHISH_WEBSITE and WHISH_SECRET.");
    (err as any).status = 503;
    throw err;
  }

  const website = String(process.env.WHISH_WEBSITE).trim();
  const secret = String(process.env.WHISH_SECRET).trim();
  const currency: WhishCurrency = opts.currency === "LBP" ? "LBP" : "USD";
  const amountNum = Number(opts.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    const err = new Error("Amount must be a positive number");
    (err as any).status = 400;
    throw err;
  }
  const amountStr = currency === "LBP" ? String(Math.round(amountNum)) : amountNum.toFixed(2);

  const params = new URLSearchParams();
  params.set("website", website);
  params.set("secret", secret);
  params.set("order_id", String(opts.orderId));
  params.set("invoice", String(opts.invoice || "Payment").slice(0, 500));
  params.set("amount", amountStr);
  params.set("currency", currency);
  params.set("order_user_email", String(opts.email || "").trim());
  params.set("order_billing_phone", String(opts.phone || "").trim());
  if (opts.userLogin) params.set("order_user_login", String(opts.userLogin).slice(0, 120));
  if (opts.firstName) params.set("order_first_name", String(opts.firstName).slice(0, 120));
  if (opts.lastName) params.set("order_last_name", String(opts.lastName).slice(0, 120));

  const res = await fetch(whishGatewayUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await res.text();
  let data: { success?: boolean; message?: string };
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error("Whish gateway returned non-JSON response");
    (err as any).status = 502;
    throw err;
  }

  if (!data.success) {
    const err = new Error(data.message || "Whish payment request failed");
    (err as any).status = 502;
    throw err;
  }

  const payUrl = data.message;
  if (!payUrl || typeof payUrl !== "string" || !payUrl.startsWith("http")) {
    const err = new Error("Whish gateway did not return a payment URL");
    (err as any).status = 502;
    throw err;
  }

  return { payUrl };
}

/** Convert invoice USD amount to gateway amount for the configured currency. */
export function resolveWhishAmount(amountUsd: number, currency: WhishCurrency): number {
  if (currency !== "LBP") return amountUsd;
  const rate = Number(process.env.FX_SECONDARY_PER_PRIMARY || 89500);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Invalid FX_SECONDARY_PER_PRIMARY for LBP amount");
  }
  return Math.round(amountUsd * rate);
}
