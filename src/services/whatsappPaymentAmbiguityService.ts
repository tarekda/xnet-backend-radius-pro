import { Equal, In } from "typeorm";
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { WhatsappPaymentAmbiguity } from "../db/entities/WhatsappPaymentAmbiguity";
import { broadcastToClients } from "../realtime/wsHub";
import { payExternalInvoicesFromWhatsAppInbound } from "./whatsappInboundPayService";

export type WhatsappAmbiguityListItem = {
  id: number;
  submittedName: string;
  billingMonth: string;
  status: WhatsappPaymentAmbiguity["status"];
  sourceFrom: string | null;
  messageId: string | null;
  createdAt: string | null;
  resolvedInvoiceId: number | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  dismissReason: string | null;
  candidates: ExternalInvoice[];
};

export async function createWhatsappPaymentAmbiguity(input: {
  submittedName: string;
  billingMonth: string;
  candidateInvoiceIds: number[];
  sourceFrom?: string | null;
  messageId?: string | null;
}): Promise<WhatsappPaymentAmbiguity> {
  const ids = [...new Set(input.candidateInvoiceIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length < 2) {
    throw Object.assign(new Error("Ambiguity requires at least two candidate invoices"), { status: 400 });
  }

  const repo = AppDataSource.getRepository(WhatsappPaymentAmbiguity);
  const row = repo.create({
    submittedName: input.submittedName.slice(0, 128),
    billingMonth: input.billingMonth,
    candidateInvoiceIds: ids,
    status: "pending",
    sourceFrom: input.sourceFrom ? String(input.sourceFrom).slice(0, 64) : null,
    messageId: input.messageId ? String(input.messageId).slice(0, 128) : null,
  });
  const saved = await repo.save(row);

  broadcastToClients({
    type: "WHATSAPP_PAYMENT_AMBIGUITY",
    ambiguityId: saved.id,
    submittedName: saved.submittedName,
  });

  return saved;
}

async function loadCandidates(ids: number[]): Promise<ExternalInvoice[]> {
  if (!ids.length) return [];
  return AppDataSource.getRepository(ExternalInvoice).find({
    where: { id: In(ids) },
    order: { fullName: "ASC", id: "ASC" },
  });
}

function toListItem(row: WhatsappPaymentAmbiguity, candidates: ExternalInvoice[]): WhatsappAmbiguityListItem {
  return {
    id: row.id,
    submittedName: row.submittedName,
    billingMonth: String(row.billingMonth).slice(0, 10),
    status: row.status,
    sourceFrom: row.sourceFrom,
    messageId: row.messageId,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    resolvedInvoiceId: row.resolvedInvoiceId,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    dismissReason: row.dismissReason,
    candidates,
  };
}

export async function listWhatsappPaymentAmbiguities(opts?: {
  status?: WhatsappPaymentAmbiguity["status"];
  limit?: number;
}): Promise<WhatsappAmbiguityListItem[]> {
  const repo = AppDataSource.getRepository(WhatsappPaymentAmbiguity);
  const status = opts?.status || "pending";
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 100));

  const rows = await repo.find({
    where: { status: Equal(status) as any },
    order: { createdAt: "DESC", id: "DESC" },
    take: limit,
  });

  const out: WhatsappAmbiguityListItem[] = [];
  for (const row of rows) {
    const ids = Array.isArray(row.candidateInvoiceIds) ? row.candidateInvoiceIds : [];
    out.push(toListItem(row, await loadCandidates(ids)));
  }
  return out;
}

export async function resolveWhatsappPaymentAmbiguity(
  ambiguityId: number,
  invoiceId: number,
  actor: string
): Promise<{ ambiguity: WhatsappPaymentAmbiguity; paidInvoiceIds: number[] }> {
  return AppDataSource.transaction(async (manager) => {
    const ambRepo = manager.getRepository(WhatsappPaymentAmbiguity);
    const invRepo = manager.getRepository(ExternalInvoice);

    const row = await ambRepo.findOne({ where: { id: Equal(ambiguityId) } });
    if (!row) {
      throw Object.assign(new Error("Ambiguity not found"), { status: 404 });
    }
    if (row.status !== "pending") {
      throw Object.assign(new Error("This item was already handled"), { status: 400 });
    }

    const allowed = Array.isArray(row.candidateInvoiceIds) ? row.candidateInvoiceIds : [];
    if (!allowed.includes(invoiceId)) {
      throw Object.assign(new Error("Invoice is not a candidate for this payment"), { status: 400 });
    }

    const invoice = await invRepo.findOne({ where: { id: Equal(invoiceId) } });
    if (!invoice) {
      throw Object.assign(new Error("Invoice not found"), { status: 404 });
    }
    if (String(invoice.status).toLowerCase() === "paid") {
      throw Object.assign(new Error("Invoice is already paid"), { status: 400 });
    }

    const paidInvoiceIds = await payExternalInvoicesFromWhatsAppInbound([invoice], row.submittedName, {
      messageId: row.messageId ?? undefined,
      from: row.sourceFrom ?? undefined,
    });

    row.status = "resolved";
    row.resolvedInvoiceId = invoiceId;
    row.resolvedBy = actor.slice(0, 64);
    row.resolvedAt = new Date();
    await ambRepo.save(row);

    return { ambiguity: row, paidInvoiceIds };
  });
}

export async function dismissWhatsappPaymentAmbiguity(
  ambiguityId: number,
  actor: string,
  reason?: string
): Promise<WhatsappPaymentAmbiguity> {
  const repo = AppDataSource.getRepository(WhatsappPaymentAmbiguity);
  const row = await repo.findOne({ where: { id: Equal(ambiguityId) } });
  if (!row) {
    throw Object.assign(new Error("Ambiguity not found"), { status: 404 });
  }
  if (row.status !== "pending") {
    throw Object.assign(new Error("This item was already handled"), { status: 400 });
  }
  row.status = "dismissed";
  row.resolvedBy = actor.slice(0, 64);
  row.resolvedAt = new Date();
  row.dismissReason = reason ? String(reason).slice(0, 255) : "Dismissed by staff";
  return repo.save(row);
}
