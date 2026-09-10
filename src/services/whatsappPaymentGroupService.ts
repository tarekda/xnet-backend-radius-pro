import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { Repository } from "typeorm";
import { createWhatsappPaymentAmbiguity } from "./whatsappPaymentAmbiguityService";
import { payExternalInvoicesFromWhatsAppInbound } from "./whatsappInboundPayService";
import { normalizeBillingMonthKey } from "./invoiceService";

export { payExternalInvoicesFromWhatsAppInbound } from "./whatsappInboundPayService";

export function isWhatsAppGroupAutoPayEnabled(): boolean {
  const val = String(process.env.WHATSAPP_GROUP_AUTO_PAY_ENABLED || "").trim().toLowerCase();
  if (val === "false" || val === "0" || val === "off") return false;
  return true;
}

/** Strip Unicode invisible format, control, and bidirectional markers (e.g. LRM \u200E, RLM \u200F, BOM \uFEFF). */
export function stripBidiAndControlChars(s: string): string {
  return String(s || "").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g, "");
}

/** Strip stray currency signs and leading/trailing punctuation from extracted names. */
export function cleanExtractedName(raw: string): string {
  return stripBidiAndControlChars(raw)
    .replace(/[$€£]/g, "") // strip any stray currency signs
    .replace(/^[\s\-\*\•\–—#\.\,\:\;\(\)\[\]\'\"]+|[\s\-\*\•\–—#\.\,\:\;\(\)\[\]\'\"]+$/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g, "")
    .trim();
}

export function normalizePaymentLookupKey(raw: string): string {
  let s = cleanExtractedName(raw).toLowerCase().replace(/\s+/g, " ");
  // Arabic: strip diacritics and unify common letter variants for name matching
  s = s.replace(/[\u064B-\u065F\u0670]/g, "");
  s = s.replace(/[إأآٱ]/g, "ا");
  s = s.replace(/ى/g, "ي");
  s = s.replace(/ة/g, "ه");
  return s.trim();
}

export function splitNameTokens(raw: string): string[] {
  return normalizePaymentLookupKey(raw).split(/\s+/).filter(Boolean);
}

export function subscriberIdentityKey(inv: Pick<ExternalInvoice, "username" | "fullName">): string {
  return `${normalizePaymentLookupKey(inv.username)}::${normalizePaymentLookupKey(inv.fullName)}`;
}

/** Strips Arabic definite article 'ال' for root comparison. */
export function stripArabicDefiniteArticle(token: string): string {
  const t = token.trim();
  if (t.startsWith("ال") && t.length >= 4) {
    return t.slice(2);
  }
  return t;
}

/** Matches two name tokens allowing for diacritics, letter variants, and 'ال' definite article. */
export function arabicTokenMatches(a: string, b: string): boolean {
  const normA = normalizePaymentLookupKey(a);
  const normB = normalizePaymentLookupKey(b);
  if (normA === normB) return true;
  if (!normA || !normB) return false;

  const bareA = stripArabicDefiniteArticle(normA);
  const bareB = stripArabicDefiniteArticle(normB);
  if (bareA === bareB) return true;

  return false;
}

/**
 * Match collector text to invoice full name / username.
 * When the collector omits middle name(s), first + last token must still match.
 */
export function collectorNameMatchesInvoiceName(
  collectorName: string,
  fullName: string,
  username?: string | null
): boolean {
  const lookup = normalizePaymentLookupKey(collectorName);
  if (!lookup) return false;

  const fullNorm = normalizePaymentLookupKey(fullName);
  if (fullNorm === lookup) return true;

  if (username && normalizePaymentLookupKey(username) === lookup) return true;

  const collectorTokens = splitNameTokens(collectorName);
  const fullTokens = splitNameTokens(fullName);

  // When collector sends 2 or more tokens without middle name(s):
  // Check if first token and last token match the invoice's first and last token
  if (collectorTokens.length >= 2 && fullTokens.length >= 2) {
    const cFirst = collectorTokens[0];
    const cLast = collectorTokens[collectorTokens.length - 1];
    const fFirst = fullTokens[0];
    const fLast = fullTokens[fullTokens.length - 1];
    if (arabicTokenMatches(cFirst, fFirst) && arabicTokenMatches(cLast, fLast)) return true;
    if (arabicTokenMatches(cFirst, fLast) && arabicTokenMatches(cLast, fFirst)) return true;
  }

  // When collector sends 2 tokens (e.g. first + middle, or first + last with different order)
  if (collectorTokens.length === 2 && fullTokens.length >= 2) {
    const hasFirst = fullTokens.some((ft) => arabicTokenMatches(collectorTokens[0], ft));
    const hasLast = fullTokens.some((ft) => arabicTokenMatches(collectorTokens[1], ft));
    if (hasFirst && hasLast) return true;
  }

  // If collector sends 3+ tokens, ensure all collector tokens exist in the full name
  if (collectorTokens.length >= 2 && fullTokens.length >= collectorTokens.length) {
    const allMatch = collectorTokens.every((ct) =>
      fullTokens.some((ft) => arabicTokenMatches(ct, ft))
    );
    if (allMatch) return true;
  }

  if (username) {
    const uClean = username.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, " ").replace(/\s+/g, " ").trim();
    if (uClean === lookup) return true;
    const uTokens = splitNameTokens(uClean);
    if (collectorTokens.length >= 2 && uTokens.length >= 2) {
      if (
        arabicTokenMatches(collectorTokens[0], uTokens[0]) &&
        arabicTokenMatches(collectorTokens[collectorTokens.length - 1], uTokens[uTokens.length - 1])
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Strip staff prefixes, list numbering/bullets, and leading currency symbols. */
export function stripPaymentMessagePrefix(raw: string): string {
  let s = stripBidiAndControlChars(raw).trim();
  // Strip markdown/list bullets and numbering (e.g. "1.", "1-", "•", "-", "*")
  s = s.replace(/^(\d+[\.\)\-:\s]+|[\-\*\•\–—#\s]+)/, "").trim();
  // Strip currency prefixes at line start (e.g. "$", "€", "£", "$ ")
  s = s.replace(/^[\$€£\s]+/, "").trim();
  s = stripBidiAndControlChars(s).trim();
  // Strip staff keywords (e.g. "paid:", "تم الدفع:", "payment:")
  s = s.replace(/^(paid|pay|payment|done|received|تم الدفع|دفع)[\s:\-–—]+/i, "").trim();
  // Strip currency symbol again in case format was "paid: $name"
  s = s.replace(/^[\$€£\s]+/, "").trim();
  return stripBidiAndControlChars(s).trim();
}

/** Convert Arabic-Indic / Persian digits and decimal separators to ASCII for amount parsing. */
export function normalizeAmountDigits(raw: string): string {
  let t = String(raw || "").trim();
  t = t.replace(/\u066C/g, ""); // Arabic thousands separator
  t = t.replace(/[\u066B\u066C]/g, "."); // Arabic decimal separator ٫
  t = t.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  t = t.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return t;
}

/** Parse trailing numeric token as paid amount (e.g. 25, 25.5, ٢٥, ٢٥٫٥, 0, 0$, $0). */
export function parseTrailingPaidAmount(token: string): number | null {
  let t = stripBidiAndControlChars(token).trim();
  if (!t) return null;
  t = t.replace(/[$€£\s]/g, "");
  t = normalizeAmountDigits(t);
  t = stripBidiAndControlChars(t).trim();
  if (t.includes(",") && !t.includes(".")) {
    t = t.replace(",", ".");
  } else if (t.includes(",") && t.includes(".")) {
    const lastComma = t.lastIndexOf(",");
    const lastDot = t.lastIndexOf(".");
    if (lastComma > lastDot) {
      t = t.replace(/\./g, "").replace(",", ".");
    } else {
      t = t.replace(/,/g, "");
    }
  }
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

export type WhatsAppPaymentLine = { name: string; amount: number | null };

/**
 * One line: subscriber name, optional amount as the last (or first) token.
 * Example: `طارق دعبول 25` → name `طارق دعبول`, amount 25
 * Example: `$علي الشعار ٣٥` → name `علي الشعار`, amount 35
 * Example: `$35 علي الشعار` → name `علي الشعار`, amount 35
 * Example: `سامر دندش 0$` → name `سامر دندش`, amount null (pay invoice in full)
 */
export function parsePaymentLineFromPart(raw: string): WhatsAppPaymentLine | null {
  let text = stripPaymentMessagePrefix(raw);
  if (!text || text.length > 128) return null;
  if (/^https?:\/\//i.test(text)) return null;
  if (/^\[.+\]$/.test(text)) return null;

  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    // Case 1: Trailing amount (e.g. "علي الشعار 35", "$علي الشعار ٣٥", "علي الشعار $35")
    const last = parts[parts.length - 1];
    const trailingAmount = parseTrailingPaidAmount(last);
    if (trailingAmount !== null) {
      const name = cleanExtractedName(parts.slice(0, -1).join(" "));
      if (name) {
        return { name, amount: trailingAmount > 0 ? trailingAmount : null };
      }
    }

    // Case 2: Leading amount (e.g. "$35 علي الشعار", "35$ علي الشعار", "٣٥ علي الشعار")
    const first = parts[0];
    const leadingAmount = parseTrailingPaidAmount(first);
    if (leadingAmount !== null) {
      const name = cleanExtractedName(parts.slice(1).join(" "));
      if (name) {
        return { name, amount: leadingAmount > 0 ? leadingAmount : null };
      }
    }
  }

  const name = cleanExtractedName(text);
  if (!name) return null;
  return { name, amount: null };
}

/** Strip staff prefixes; message body is usually just the subscriber name. */
export function extractPaymentNameFromMessage(raw: string): string | null {
  const line = parsePaymentLineFromPart(raw);
  return line?.name ?? null;
}

/**
 * Parse message into payment lines (comma / newline / semicolon separated).
 * Format per line: `name` or `name amount`
 */
export function extractPaymentLinesFromMessage(raw: string): WhatsAppPaymentLine[] {
  const text = String(raw || "").trim();
  if (!text) return [];

  const parts = text.split(/[\n\r,;]+/);
  const seen = new Set<string>();
  const lines: WhatsAppPaymentLine[] = [];

  for (const part of parts) {
    const line = parsePaymentLineFromPart(part);
    if (!line?.name) continue;
    const key = `${normalizePaymentLookupKey(line.name)}::${line.amount ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }

  return lines;
}

/**
 * Parse one WhatsApp message into multiple subscriber names.
 * Supports comma-separated and one-name-per-line (also semicolon).
 */
export function extractPaymentNamesFromMessage(raw: string): string[] {
  return extractPaymentLinesFromMessage(raw).map((l) => l.name);
}

function parseAllowedSenders(): string[] {
  const raw =
    String(process.env.WHATSAPP_PAYMENT_ALLOWED_SENDERS || "").trim() ||
    String(process.env.WHATSAPP_PAYMENT_GROUP_ID || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Optional allow-list (staff WhatsApp numbers). Empty = accept any inbound DM to the business number. */
export function isAllowedWhatsAppSender(sourceGroupId?: string | null, sourceFrom?: string | null): boolean {
  const allowed = parseAllowedSenders();
  if (allowed.length === 0) return true;

  const hay = `${sourceGroupId || ""} ${sourceFrom || ""}`.toLowerCase();
  return allowed.some((needle) => hay.includes(needle));
}

/** @deprecated use isAllowedWhatsAppSender */
export function isAllowedWhatsAppGroup(sourceGroupId?: string | null, sourceFrom?: string | null): boolean {
  return isAllowedWhatsAppSender(sourceGroupId, sourceFrom);
}

export type CollectorNameMatchResult =
  | { kind: "none" }
  | { kind: "unique"; invoices: ExternalInvoice[]; billingMonth: string }
  | { kind: "ambiguous"; invoices: ExternalInvoice[]; billingMonth: string };

const OPEN_EXTERNAL_INVOICE_STATUSES = ["unpaid", "pending"];

function unpaidExternalInvoiceQb(repo: Repository<ExternalInvoice>) {
  return repo
    .createQueryBuilder("i")
    .where("LOWER(i.status) IN (:...statuses)", { statuses: OPEN_EXTERNAL_INVOICE_STATUSES })
    .andWhere("i.voidedAt IS NULL")
    .andWhere("(i.documentType IS NULL OR i.documentType = :docType)", { docType: "invoice" });
}

/**
 * SQL LIKE variants for Arabic tokens.
 * Matching normalizes ة→ه, but MySQL stores the original letter — search both forms.
 */
export function expandArabicSqlToken(token: string): string[] {
  const base = stripBidiAndControlChars(token)
    .trim()
    .replace(/[%_]/g, "")
    .toLowerCase();
  if (!base) return [];

  const out = new Set<string>([base, normalizePaymentLookupKey(base)]);

  // Expand with and without Arabic definite article "ال" (e.g. الشعار <-> شعار)
  for (const t of [...out]) {
    if (!t) continue;
    if (t.startsWith("ال") && t.length >= 4) {
      out.add(t.slice(2));
    } else if (!t.startsWith("ال") && /^[\u0600-\u06FF]/.test(t)) {
      out.add(`ال${t}`);
    }
  }

  // Expand ة/ه and ي/ى variants
  for (const t of [...out]) {
    if (!t) continue;
    if (t.endsWith("ه")) out.add(`${t.slice(0, -1)}ة`);
    if (t.endsWith("ة")) out.add(`${t.slice(0, -1)}ه`);
    if (t.endsWith("ي")) out.add(`${t.slice(0, -1)}ى`);
    if (t.endsWith("ى")) out.add(`${t.slice(0, -1)}ي`);
  }

  return [...out].filter(Boolean);
}

async function fetchUnpaidCandidatesForCollectorName(name: string): Promise<ExternalInvoice[]> {
  const cleanName = cleanExtractedName(name);
  // Prefer raw whitespace tokens so SQL sees original ة/ي before JS normalization.
  const rawTokens = String(cleanName || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(/\s+/)
    .map((t) => cleanExtractedName(t))
    .filter(Boolean);
  const tokens = rawTokens.length ? rawTokens : splitNameTokens(cleanName);
  if (!tokens.length) return [];

  const repo = AppDataSource.getRepository(ExternalInvoice);
  let qb = unpaidExternalInvoiceQb(repo);

  // When collector sends name without middle name (e.g. "علي الشعار"),
  // search by first name AND last name in SQL so candidates with middle names in DB match.
  const searchTokens =
    tokens.length >= 2 ? [tokens[0], tokens[tokens.length - 1]] : tokens;

  searchTokens.forEach((tok, idx) => {
    const variants = expandArabicSqlToken(tok);
    if (!variants.length) return;
    const parts = variants.flatMap((_, vIdx) => [
      `LOWER(i.fullName) LIKE :tok${idx}v${vIdx}`,
      `LOWER(i.username) LIKE :tok${idx}v${vIdx}`,
    ]);
    const params: Record<string, string> = {};
    variants.forEach((v, vIdx) => {
      params[`tok${idx}v${vIdx}`] = `%${v}%`;
    });
    qb = qb.andWhere(`(${parts.join(" OR ")})`, params);
  });

  return qb.orderBy("i.billingMonth", "DESC").addOrderBy("i.id", "DESC").getMany();
}

export async function resolveUnpaidExternalInvoicesForCollectorName(
  name: string
): Promise<CollectorNameMatchResult> {
  const lookup = normalizePaymentLookupKey(name);
  if (!lookup) return { kind: "none" };

  const candidates = await fetchUnpaidCandidatesForCollectorName(name);
  const matches = candidates.filter((inv) =>
    collectorNameMatchesInvoiceName(name, inv.fullName, inv.username)
  );
  if (!matches.length) return { kind: "none" };

  const byMonth = new Map<string, ExternalInvoice[]>();
  for (const inv of matches) {
    const bm = normalizeBillingMonthKey(String(inv.billingMonth ?? ""));
    if (!byMonth.has(bm)) byMonth.set(bm, []);
    byMonth.get(bm)!.push(inv);
  }

  const billingMonth = [...byMonth.keys()].sort().reverse()[0];
  const monthMatches = byMonth.get(billingMonth) ?? [];

  const identities = new Set(monthMatches.map(subscriberIdentityKey));
  if (identities.size > 1) {
    return { kind: "ambiguous", invoices: monthMatches, billingMonth };
  }
  return { kind: "unique", invoices: monthMatches, billingMonth };
}

/** @deprecated use resolveUnpaidExternalInvoicesForCollectorName */
export async function findUnpaidExternalInvoicesForName(name: string): Promise<ExternalInvoice[]> {
  const resolved = await resolveUnpaidExternalInvoicesForCollectorName(name);
  if (resolved.kind === "none") return [];
  return resolved.invoices;
}

export type WhatsAppNamePayResult =
  | { name: string; status: "paid"; paidInvoiceIds: number[]; billingMonth: string; amount?: number | null }
  | { name: string; status: "no_match"; amount?: number | null }
  | {
      name: string;
      status: "ambiguous";
      ambiguityId: number;
      candidateCount: number;
      billingMonth: string;
      amount?: number | null;
    }
  | { name: string; status: "error"; detail: string; amount?: number | null };

export type WhatsAppGroupPayResult =
  | {
      ok: true;
      names: string[];
      results: WhatsAppNamePayResult[];
      paidInvoiceIds: number[];
    }
  | { ok: false; reason: "disabled" | "empty_message" | "wrong_group" | "error"; detail?: string };

const AMOUNT_MATCH_TOLERANCE = 0.02;

/** When amount is sent, prefer invoice line(s) with that amount; else single line gets amount updated on pay. */
export function pickInvoicesToMarkPaid(
  invoices: ExternalInvoice[],
  paidAmount: number | null | undefined
): ExternalInvoice[] {
  if (!invoices.length) return [];
  if (paidAmount == null || !Number.isFinite(paidAmount)) return invoices;

  const byAmount = invoices.filter(
    (i) => Math.abs(Number(i.amount) - paidAmount) <= AMOUNT_MATCH_TOLERANCE
  );
  if (byAmount.length === 1) return byAmount;
  if (byAmount.length > 1) {
    const oneSubscriber = new Set(byAmount.map(subscriberIdentityKey));
    if (oneSubscriber.size === 1) return byAmount;
  }
  if (invoices.length === 1) return invoices;
  if (byAmount.length > 0) return byAmount;
  return [invoices[0]];
}

function tryNarrowAmbiguityByAmount(
  invoices: ExternalInvoice[],
  paidAmount: number | null | undefined
): ExternalInvoice[] | null {
  if (paidAmount == null || !Number.isFinite(paidAmount)) return null;
  const tol = AMOUNT_MATCH_TOLERANCE;
  const narrowed = invoices.filter((i) => Math.abs(Number(i.amount) - paidAmount) <= tol);
  if (!narrowed.length) return null;
  const identities = new Set(narrowed.map(subscriberIdentityKey));
  if (identities.size === 1) return narrowed;
  return null;
}

async function payOneNameFromWhatsApp(
  line: WhatsAppPaymentLine,
  meta?: { groupId?: string; from?: string; messageId?: string }
): Promise<WhatsAppNamePayResult> {
  const { name, amount: paidAmount } = line;
  try {
    let match = await resolveUnpaidExternalInvoicesForCollectorName(name);
    if (match.kind === "none") {
      const rough = await fetchUnpaidCandidatesForCollectorName(name);
      console.info("[whatsapp-inbound] no_match", {
        name,
        paidAmount,
        roughCandidateCount: rough.length,
        sample: rough.slice(0, 3).map((i) => ({ id: i.id, fullName: i.fullName, status: i.status })),
      });
      return { name, status: "no_match", amount: paidAmount };
    }

    if (match.kind === "ambiguous") {
      const narrowed = tryNarrowAmbiguityByAmount(match.invoices, paidAmount);
      if (narrowed) {
        match = { kind: "unique", invoices: narrowed, billingMonth: match.billingMonth };
      }
    }

    if (match.kind === "ambiguous") {
      const distinctByIdentity = new Map<string, ExternalInvoice>();
      for (const inv of match.invoices) {
        distinctByIdentity.set(subscriberIdentityKey(inv), inv);
      }
      const candidateIds = [...distinctByIdentity.values()].map((i) => i.id!).filter(Boolean);
      const submittedLabel =
        paidAmount != null ? `${name} (${paidAmount})` : name;
      const ambiguity = await createWhatsappPaymentAmbiguity({
        submittedName: submittedLabel.slice(0, 128),
        billingMonth: match.billingMonth,
        candidateInvoiceIds: candidateIds,
        sourceFrom: meta?.from ?? null,
        messageId: meta?.messageId ?? null,
      });
      return {
        name,
        status: "ambiguous",
        ambiguityId: ambiguity.id,
        candidateCount: candidateIds.length,
        billingMonth: match.billingMonth,
        amount: paidAmount,
      };
    }

    const targets = pickInvoicesToMarkPaid(match.invoices, paidAmount);
    const paidIds = await payExternalInvoicesFromWhatsAppInbound(targets, name, {
      ...meta,
      paidAmount,
    });
    return {
      name,
      status: "paid",
      paidInvoiceIds: paidIds,
      billingMonth: match.billingMonth,
      amount: paidAmount,
    };
  } catch (err: any) {
    return { name, status: "error", detail: String(err?.message || err), amount: paidAmount };
  }
}

/** Inbound WhatsApp text (DM to business number): comma or newline separated names → mark paid. */
export async function payExternalInvoiceFromWhatsAppGroupMessage(
  rawMessage: string,
  meta?: { groupId?: string; from?: string; messageId?: string }
): Promise<WhatsAppGroupPayResult> {
  if (!isWhatsAppGroupAutoPayEnabled()) {
    return { ok: false, reason: "disabled" };
  }

  if (!isAllowedWhatsAppSender(meta?.groupId, meta?.from)) {
    return { ok: false, reason: "wrong_group" };
  }

  const lines = extractPaymentLinesFromMessage(rawMessage);
  if (lines.length === 0) {
    return { ok: false, reason: "empty_message" };
  }

  const results: WhatsAppNamePayResult[] = [];
  const paidInvoiceIds: number[] = [];

  for (const line of lines) {
    const result = await payOneNameFromWhatsApp(line, meta);
    results.push(result);
    if (result.status === "paid") {
      paidInvoiceIds.push(...result.paidInvoiceIds);
    }
  }

  return { ok: true, names: lines.map((l) => l.name), results, paidInvoiceIds };
}
