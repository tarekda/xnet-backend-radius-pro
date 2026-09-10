import { AppDataSource } from "../db/config";
import { WhatsappInboundMessage } from "../db/entities/WhatsappInboundMessage";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { payExternalInvoiceFromWhatsAppGroupMessage } from "./whatsappPaymentGroupService";
import { payExternalInvoicesFromWhatsAppInbound } from "./whatsappInboundPayService";

export async function logInboundWhatsAppMessage(opts: {
  fromNumber: string;
  rawText: string;
  messageSid?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  ocrRawText?: string | null;
  ocrExtractedData?: Record<string, any> | null;
  intent?: string | null;
  replyText?: string | null;
  matchedUsername?: string | null;
}): Promise<WhatsappInboundMessage | null> {
  try {
    const repo = AppDataSource.getRepository(WhatsappInboundMessage);
    const record = repo.create({
      fromNumber: opts.fromNumber,
      rawText: opts.rawText,
      messageSid: opts.messageSid ?? null,
      mediaUrl: opts.mediaUrl ?? null,
      mediaType: opts.mediaType ?? null,
      ocrRawText: opts.ocrRawText ?? null,
      ocrExtractedData: opts.ocrExtractedData ?? null,
      intent: opts.intent ?? null,
      replyText: opts.replyText ?? null,
      matchedUsername: opts.matchedUsername ?? null,
      status: "received",
      createdAt: new Date(),
    });
    return await repo.save(record);
  } catch (err: any) {
    console.warn("⚠️ Failed to log inbound WhatsApp message to DB queue:", err?.message || err);
    return null;
  }
}

export async function updateInboundWhatsAppMessageResult(
  id: number | null | undefined,
  result: {
    ok?: boolean;
    names?: string[];
    results?: Array<{
      name: string;
      status: string;
      detail?: string;
      amount?: number | null;
      paidInvoiceIds?: number[];
    }>;
    paidInvoiceIds?: number[];
    intent?: string | null;
    replyText?: string | null;
    matchedUsername?: string | null;
  }
): Promise<void> {
  if (!id) return;
  try {
    const repo = AppDataSource.getRepository(WhatsappInboundMessage);
    const msg = await repo.findOne({ where: { id } });
    if (!msg) return;

  const names = result.names || [];
  const resList = result.results || [];
  const paidIds = result.paidInvoiceIds || [];

  let status: WhatsappInboundMessage["status"] = "processed";
  let extractedAmount: number | null = null;
  let overpaymentAmount: number | null = null;
  let errorDetail: string | null = null;

  if (resList.length > 0) {
    const validAmounts = resList
      .map((r) => r.amount)
      .filter((a): a is number => a != null && Number.isFinite(a));
    if (validAmounts.length > 0) {
      extractedAmount = Number(validAmounts.reduce((sum, a) => sum + Number(a), 0).toFixed(2));
    }

    if (paidIds.length > 0) {
      status = "processed";
    } else {
      const first = resList[0];
      if (first.status === "no_match") status = "no_match";
      else if (first.status === "ambiguous") status = "ambiguous";
      else if (first.status === "error") {
        status = "error";
        errorDetail = first.detail || "Error processing payment line";
      }
    }
  }

  if (result.ok === false) {
    status = "error";
  }

  msg.parsedNames = names;
  msg.extractedAmount = extractedAmount;
  msg.paidInvoiceIds = paidIds;
  msg.status = status;
  msg.errorDetail = errorDetail;
  if (result.intent !== undefined) msg.intent = result.intent;
  if (result.replyText !== undefined) msg.replyText = result.replyText;
  if (result.matchedUsername !== undefined) msg.matchedUsername = result.matchedUsername;
  msg.updatedAt = new Date();

  await repo.save(msg);
  } catch (err: any) {
    console.warn("⚠️ Failed to update inbound WhatsApp message result in DB:", err?.message || err);
  }
}

export async function fetchInboundWhatsAppMessages(args: {
  page?: number;
  limit?: number;
  search?: string;
  fromNumber?: string;
  status?: string;
}) {
  const repo = AppDataSource.getRepository(WhatsappInboundMessage);
  const page = Math.max(1, Number(args.page || 1));
  const limit = Math.max(1, Math.min(100, Number(args.limit || 20)));
  const skip = (page - 1) * limit;

  const qb = repo.createQueryBuilder("msg").orderBy("msg.id", "DESC");

  if (args.fromNumber) {
    qb.andWhere("msg.fromNumber LIKE :from", { from: `%${args.fromNumber.trim()}%` });
  }

  if (args.search?.trim()) {
    const s = `%${args.search.trim()}%`;
    qb.andWhere("(msg.rawText LIKE :s OR msg.fromNumber LIKE :s OR msg.errorDetail LIKE :s)", { s });
  }

  if (args.status && args.status !== "all") {
    qb.andWhere("msg.status = :status", { status: args.status });
  }

  const [items, total] = await qb.skip(skip).take(limit).getManyAndCount();

  const totalProcessed = await repo.count({ where: { status: "processed" } });
  const totalNoMatch = await repo.count({ where: { status: "no_match" } });
  const totalErrors = await repo.count({ where: { status: "error" } });

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    metrics: {
      total,
      processed: totalProcessed,
      noMatch: totalNoMatch,
      errors: totalErrors,
    },
  };
}

export async function retryInboundWhatsAppMessage(id: number) {
  const repo = AppDataSource.getRepository(WhatsappInboundMessage);
  const msg = await repo.findOne({ where: { id } });
  if (!msg) throw new Error("Inbound message not found");

  const result = await payExternalInvoiceFromWhatsAppGroupMessage(msg.rawText, {
    from: msg.fromNumber,
    messageId: msg.messageSid ?? undefined,
  });

  await updateInboundWhatsAppMessageResult(msg.id, result);
  return result;
}

export async function resolveInboundWhatsAppMessage(
  id: number,
  invoiceId: number,
  actor: string
): Promise<{ ok: boolean; paidInvoiceIds: number[]; message: WhatsappInboundMessage }> {
  return AppDataSource.transaction(async (manager) => {
    const msgRepo = manager.getRepository(WhatsappInboundMessage);
    const invRepo = manager.getRepository(ExternalInvoice);

    const msg = await msgRepo.findOne({ where: { id } });
    if (!msg) throw new Error("Inbound message not found");

    const invoice = await invRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new Error("Invoice not found");

    if (String(invoice.status).toLowerCase() === "paid") {
      throw new Error("Invoice is already paid");
    }

    const payerName = (Array.isArray(msg.parsedNames) && msg.parsedNames[0]) || invoice.fullName || "WhatsApp Collector";
    const paidIds = await payExternalInvoicesFromWhatsAppInbound([invoice], payerName, {
      from: msg.fromNumber,
      messageId: msg.messageSid ?? undefined,
      paidAmount: msg.extractedAmount ?? undefined,
    });

    msg.status = "processed";
    msg.paidInvoiceIds = paidIds;
    msg.errorDetail = `Manually resolved to invoice #${invoice.id} (${invoice.fullName}) by ${actor}`;
    msg.updatedAt = new Date();
    await msgRepo.save(msg);

    return { ok: true, paidInvoiceIds: paidIds, message: msg };
  });
}
