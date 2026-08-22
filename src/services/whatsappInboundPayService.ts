import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { invoiceEvents } from "../events/invoiceEvents";
import { broadcastToClients } from "../realtime/wsHub";
import { payExternalInvoice } from "./invoiceService";

export const WHATSAPP_INBOUND_ACTOR = "whatsapp-inbound";

export async function payExternalInvoicesFromWhatsAppInbound(
  targets: ExternalInvoice[],
  matchedName: string,
  meta?: { groupId?: string; from?: string; messageId?: string; paidAmount?: number | null }
): Promise<number[]> {
  const paymentMethod = (process.env.WHATSAPP_GROUP_PAYMENT_METHOD || "cash") as
    | "cash"
    | "pos"
    | "transfer"
    | "other";
  const paidIds: number[] = [];

  for (const target of targets) {
    if (!target.id) continue;
    const paid = await payExternalInvoice(target.id, WHATSAPP_INBOUND_ACTOR, paymentMethod, {
      paymentReference: meta?.messageId ? String(meta.messageId).slice(0, 128) : `wa-inbound:${Date.now()}`,
      paymentProvider: "whatsapp-inbound",
      paidAmount: meta?.paidAmount ?? null,
    });
    paidIds.push(paid.id!);

    const amountNote =
      meta?.paidAmount != null && Number.isFinite(meta.paidAmount)
        ? ` amount=${meta.paidAmount}`
        : "";

    await invoiceEvents.emitModification({
      invoiceId: paid.id!,
      username: WHATSAPP_INBOUND_ACTOR,
      action: "PAID",
      timestamp: new Date(),
      changes: {
        source: "whatsapp_inbound",
        matchedName,
        from: meta?.from ?? null,
        paidAmount: meta?.paidAmount ?? null,
      },
      data: {
        ...paid,
        persistLastAction: `auto-paid from WhatsApp (${matchedName})${amountNote} @ ${new Date().toISOString()}`,
      },
    });

    broadcastToClients({
      type: "EXTERNAL_INVOICE_PAID",
      invoiceId: paid.id,
      fullName: paid.fullName,
      username: paid.username,
      amount: paid.amountPaid ?? paid.totalAmount ?? paid.amount,
      paidAmount: meta?.paidAmount ?? null,
      matchedName,
      from: meta?.from ?? null,
      source: "whatsapp_inbound",
    });
  }

  return paidIds;
}
