import { AppDataSource } from "../db/config";
import { WhatsappInboundMessage } from "../db/entities/WhatsappInboundMessage";
import { payExternalInvoiceFromWhatsAppGroupMessage } from "./whatsappPaymentGroupService";

export async function logInboundWhatsAppMessage(opts: {
  fromNumber: string;
  rawText: string;
  messageSid?: string | null;
}): Promise<WhatsappInboundMessage | null> {
  try {
    const repo = AppDataSource.getRepository(WhatsappInboundMessage);
    const record = repo.create({
      fromNumber: opts.fromNumber,
      rawText: opts.rawText,
      messageSid: opts.messageSid ?? null,
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
    const first = resList[0];
    if (first.amount != null) extractedAmount = Number(first.amount);
    if (first.status === "no_match") status = "no_match";
    else if (first.status === "ambiguous") status = "ambiguous";
    else if (first.status === "error") {
      status = "error";
      errorDetail = first.detail || "Error processing payment line";
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
