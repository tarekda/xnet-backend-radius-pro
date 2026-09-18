import { createWorker } from "tesseract.js";
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import {
  normalizeAmountDigits,
  collectorNameMatchesInvoiceName,
  splitNameTokens,
  expandArabicSqlToken,
} from "./whatsappPaymentGroupService";

export interface ExtractedReceiptData {
  provider: "whish" | "omt" | "bob" | "suyool" | "bank" | "generic";
  referenceId: string | null;
  amount: number | null;
  currency: "USD" | "LBP" | string;
  senderName: string | null;
  recipientName: string | null;
  candidateNames: string[];
  phoneNumber: string | null;
  timestamp: string | null;
  confidence: number;
  rawText: string;
}

/**
 * Run OCR using tesseract.js.
 * Defaults to 'eng' for high-speed offline character recognition with Arabic numeral fallback.
 */
export async function performOcrOnImage(imageInput: Buffer | string): Promise<string> {
  let worker;
  try {
    worker = await createWorker("eng");
    const ret = await worker.recognize(imageInput);
    await worker.terminate();
    return ret.data.text || "";
  } catch (err: any) {
    if (worker) {
      try {
        await worker.terminate();
      } catch {}
    }
    console.warn("[whatsapp-ocr] Tesseract recognition fallback warning:", err?.message || err);
    throw new Error(`OCR Processing failed: ${err?.message || String(err)}`);
  }
}

/**
 * Detect the financial provider from OCR raw text.
 */
export function detectReceiptProvider(text: string): ExtractedReceiptData["provider"] {
  const lower = text.toLowerCase();
  if (lower.includes("whish") || lower.includes("wish money")) return "whish";
  if (lower.includes("omt") || lower.includes("western union") || lower.includes("mtcn")) return "omt";
  if (lower.includes("bob finance") || lower.includes("bank of beirut")) return "bob";
  if (lower.includes("suyool")) return "suyool";
  if (
    lower.includes("bank") ||
    lower.includes("iban") ||
    lower.includes("swift") ||
    lower.includes("audi") ||
    lower.includes("blom") ||
    lower.includes("byblos") ||
    lower.includes("credit libanais")
  ) {
    return "bank";
  }
  return "generic";
}

/**
 * Extract Transaction or Reference ID from text.
 */
export function extractReferenceId(text: string): string | null {
  const lines = text.split(/[\r\n]+/);
  
  // Whish patterns: "Ref: 12345678", "Transaction ID: 987654321", "Receipt #: ..."
  const refRegexes = [
    /(?:ref(?:erence)?(?:\s*(?:no|id|#))?|txn(?:\s*(?:no|id|#))?|transaction(?:\s*(?:no|id|#))?|receipt(?:\s*(?:no|#))?|mtcn|رقم\s*العملية|المرجع|رقم\s*الإشعار)[\s:\-–—]+([a-zA-Z0-9\-_]{5,32})/i,
    /(?:id)[\s:\-–—]+([0-9]{6,16})/i,
    /#\s*([0-9]{5,16})/,
  ];

  for (const line of lines) {
    for (const regex of refRegexes) {
      const match = line.match(regex);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }

  // Fallback: search for long standalone numeric or alphanumeric token often found in slip headers
  for (const line of lines) {
    const standaloneMatch = line.trim().match(/^(?:MTCN\s*)?([0-9]{8,14})$/i);
    if (standaloneMatch && standaloneMatch[1]) {
      return standaloneMatch[1];
    }
  }

  return null;
}

/**
 * Extract Amount and Currency from OCR text.
 */
export function extractReceiptAmount(text: string): { amount: number | null; currency: "USD" | "LBP" | string } {
  const normText = normalizeAmountDigits(text);
  const lines = normText.split(/[\r\n]+/);

  let detectedCurrency: "USD" | "LBP" | string = "USD";
  if (
    /(\blbp\b|ل\.ل|ليرة|lebanese\s*pounds?)/i.test(text) &&
    !/(\busd\b|\$|dollars?)/i.test(text)
  ) {
    detectedCurrency = "LBP";
  }

  // Priority amount regex patterns (lines with "Amount:", "Total:", "المبلغ", "القيمة", "$", etc.)
  const amountRegexes = [
    /(?:amount|total|paid|sum|المبلغ|القيمة|المدفوع)[\s:\-–—]+(?:\$|usd)?\s*([0-9]+(?:[.,][0-9]{1,2})?)/i,
    /(?:\$|usd)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i,
    /([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:\$|usd)/i,
    /(?:lbp|ل\.ل)\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]+)/i,
    /([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]+)\s*(?:lbp|ل\.ل)/i,
  ];

  for (const line of lines) {
    for (const regex of amountRegexes) {
      const m = line.match(regex);
      if (m && m[1]) {
        let clean = m[1].replace(/,/g, ".");
        // Handle multiple dots or thousand separators
        if ((clean.match(/\./g) || []).length > 1) {
          const lastIdx = clean.lastIndexOf(".");
          clean = clean.slice(0, lastIdx).replace(/\./g, "") + clean.slice(lastIdx);
        }
        const val = parseFloat(clean);
        if (Number.isFinite(val) && val > 0) {
          return { amount: Math.round(val * 100) / 100, currency: detectedCurrency };
        }
      }
    }
  }

  // Fallback: look for lines that contain standalone currency figures
  for (const line of lines) {
    const numMatch = line.match(/\b([1-9][0-9]{0,4}(?:\.[0-9]{1,2})?)\b/);
    if (numMatch && numMatch[1]) {
      const val = parseFloat(numMatch[1]);
      if (val >= 5 && val <= 5000) {
        return { amount: Math.round(val * 100) / 100, currency: detectedCurrency };
      }
    }
  }

  return { amount: null, currency: detectedCurrency };
}

/**
 * Extract candidate names and phone numbers from OCR text.
 */
export function extractCandidateNames(text: string): { names: string[]; phoneNumber: string | null } {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const names: string[] = [];
  let phoneNumber: string | null = null;

  // Phone number extraction
  for (const line of lines) {
    const phoneMatch = line.match(/(?:\+?961|00961|03|70|71|76|78|79|81)[0-9]{6,8}/);
    if (phoneMatch && !phoneNumber) {
      phoneNumber = phoneMatch[0];
    }
  }

  // Name lines
  const namePrefixRegex = /^(?:to|recipient|customer|receiver|subscriber|sender|beneficiary|الزبون|المستلم|المرسل|المستفيد)[\s:\-–—]+(.+)$/i;
  for (const line of lines) {
    const prefixMatch = line.match(namePrefixRegex);
    if (prefixMatch && prefixMatch[1]) {
      const cleanName = prefixMatch[1].replace(/[^a-zA-Z\u0600-\u06FF\s]/g, " ").trim();
      if (cleanName.length >= 3) {
        names.push(cleanName);
      }
    }
  }

  // If no prefix match, scan lines that look like valid 2-4 word full names (Latin or Arabic)
  if (names.length === 0) {
    for (const line of lines) {
      const clean = line.replace(/[^a-zA-Z\u0600-\u06FF\s]/g, " ").trim();
      const words = clean.split(/\s+/).filter(Boolean);
      if (words.length >= 2 && words.length <= 4 && clean.length >= 5 && clean.length <= 40) {
        // Skip obvious common receipt keywords
        const lower = clean.toLowerCase();
        if (
          !lower.includes("whish") &&
          !lower.includes("payment") &&
          !lower.includes("receipt") &&
          !lower.includes("customer service") &&
          !lower.includes("call center") &&
          !lower.includes("cash") &&
          !lower.includes("touch") &&
          !lower.includes("alfa") &&
          !lower.includes("total amount")
        ) {
          names.push(clean);
        }
      }
    }
  }

  return { names, phoneNumber };
}

/**
 * Parse raw OCR text into a structured receipt payload.
 */
export function parseReceiptOcrText(rawText: string): ExtractedReceiptData {
  const provider = detectReceiptProvider(rawText);
  const referenceId = extractReferenceId(rawText);
  const { amount, currency } = extractReceiptAmount(rawText);
  const { names, phoneNumber } = extractCandidateNames(rawText);

  // Confidence calculation
  let confidence = 0.3;
  if (provider !== "generic") confidence += 0.2;
  if (referenceId) confidence += 0.25;
  if (amount !== null && amount > 0) confidence += 0.25;
  if (names.length > 0) confidence += 0.1;
  confidence = Math.min(1.0, Math.round(confidence * 100) / 100);

  return {
    provider,
    referenceId,
    amount,
    currency,
    senderName: names[0] || null,
    recipientName: names[1] || null,
    candidateNames: names,
    phoneNumber,
    timestamp: new Date().toISOString(),
    confidence,
    rawText,
  };
}

/**
 * Reconcile extracted receipt data against open External Invoices.
 */
export async function matchReceiptWithInvoices(extracted: ExtractedReceiptData): Promise<{
  matchedInvoice?: ExternalInvoice;
  candidateInvoices: ExternalInvoice[];
  status: "matched" | "ambiguous" | "no_match";
}> {
  const invoiceRepo = AppDataSource.getRepository(ExternalInvoice);
  
  // 1. If candidate names were found, search for matching invoices
  let matchedCandidates: ExternalInvoice[] = [];
  if (extracted.candidateNames.length > 0) {
    for (const name of extracted.candidateNames) {
      const tokens = splitNameTokens(name);
      if (!tokens.length) continue;

      let nameQb = invoiceRepo
        .createQueryBuilder("i")
        .where("LOWER(i.status) IN (:...statuses)", { statuses: ["unpaid", "pending"] })
        .andWhere("i.voidedAt IS NULL");

      tokens.forEach((tok, idx) => {
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
        nameQb = nameQb.andWhere(`(${parts.join(" OR ")})`, params);
      });

      const results = await nameQb.orderBy("i.billingMonth", "DESC").take(10).getMany();
      for (const res of results) {
        if (!matchedCandidates.some((c) => c.id === res.id)) {
          if (collectorNameMatchesInvoiceName(name, res.fullName, res.username)) {
            matchedCandidates.push(res);
          }
        }
      }
    }
  }

  // 2. If phone number was extracted, try finding invoice by subscriber phone
  if (extracted.phoneNumber && matchedCandidates.length === 0) {
    const cleanPhone = extracted.phoneNumber.replace(/[^0-9]/g, "");
    const phoneCandidates = await invoiceRepo
      .createQueryBuilder("i")
      .where("LOWER(i.status) IN (:...statuses)", { statuses: ["unpaid", "pending"] })
      .andWhere("i.voidedAt IS NULL")
      .andWhere("(i.phone LIKE :phone OR i.mobile LIKE :phone)", { phone: `%${cleanPhone.slice(-8)}%` })
      .take(5)
      .getMany();
    for (const p of phoneCandidates) {
      if (!matchedCandidates.some((c) => c.id === p.id)) {
        matchedCandidates.push(p);
      }
    }
  }

  // 3. If exact 1 candidate matches name (and optionally amount), it's a unique match
  if (matchedCandidates.length === 1) {
    return {
      matchedInvoice: matchedCandidates[0],
      candidateInvoices: matchedCandidates,
      status: "matched",
    };
  }

  // If multiple candidates, check if amount filters it down to exactly one
  if (matchedCandidates.length > 1 && extracted.amount !== null && extracted.amount > 0) {
    const amountMatches = matchedCandidates.filter(
      (c) => Math.abs(Number(c.totalAmount ?? c.amount ?? 0) - (extracted.amount || 0)) < 0.05
    );
    if (amountMatches.length === 1) {
      return {
        matchedInvoice: amountMatches[0],
        candidateInvoices: matchedCandidates,
        status: "matched",
      };
    }
  }

  if (matchedCandidates.length > 1) {
    return {
      candidateInvoices: matchedCandidates,
      status: "ambiguous",
    };
  }

  // If no candidates from names, pull recent open invoices matching the exact amount
  if (extracted.amount !== null && extracted.amount > 0) {
    const amountOnly = await invoiceRepo
      .createQueryBuilder("i")
      .where("LOWER(i.status) IN (:...statuses)", { statuses: ["unpaid", "pending"] })
      .andWhere("i.voidedAt IS NULL")
      .andWhere("(i.totalAmount = :amt OR i.amount = :amt)", { amt: extracted.amount })
      .orderBy("i.id", "DESC")
      .take(5)
      .getMany();

    if (amountOnly.length === 1) {
      return {
        matchedInvoice: amountOnly[0],
        candidateInvoices: amountOnly,
        status: "matched",
      };
    } else if (amountOnly.length > 1) {
      return {
        candidateInvoices: amountOnly,
        status: "ambiguous",
      };
    }
  }

  return {
    candidateInvoices: [],
    status: "no_match",
  };
}
