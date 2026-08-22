import { EntityManager } from "typeorm";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { InvoicePayment } from "../db/entities/InvoicePayment";
import { creditCompanyWallet } from "../services/companyWalletService";
import {
  COMPANY_COLLECTION_METHODS,
  invoiceDue,
  remainingDue,
  resolvePaymentApply,
  roundMoney,
} from "./paymentMath";

export async function applyInvoicePayment(
  manager: EntityManager,
  opts: {
    invoice: ExternalInvoice;
    amount?: number | null;
    method: string;
    actor: string;
    paymentReference?: string | null;
    paymentProvider?: string | null;
    creditCompany: boolean;
    note?: string | null;
  }
): Promise<{
  invoice: ExternalInvoice;
  payment: InvoicePayment;
  apply: number;
  remainingDue: number;
  partial: boolean;
}> {
  const invoice = opts.invoice;
  const due = invoiceDue(invoice);
  const paidSoFar = roundMoney(Number(invoice.amountPaid ?? 0));
  const left = remainingDue(due, paidSoFar);
  const { apply, partial, overpay } = resolvePaymentApply(left, opts.amount, { allowOverpay: true });
  if (apply < 0.01 && overpay < 0.01) {
    throw Object.assign(new Error("Nothing remaining to collect on this invoice"), { status: 400 });
  }

  const paymentRepo = manager.getRepository(InvoicePayment);
  const payment = await paymentRepo.save(
    paymentRepo.create({
      externalInvoiceId: invoice.id!,
      amount: apply.toFixed(2),
      method: String(opts.method).slice(0, 20),
      paymentReference: opts.paymentReference ? String(opts.paymentReference).slice(0, 128) : null,
      paymentProvider: opts.paymentProvider ? String(opts.paymentProvider).slice(0, 32) : null,
      createdBy: opts.actor || null,
    })
  );

  const newPaid = roundMoney(paidSoFar + apply);
  const leftAfter = remainingDue(due, newPaid);
  const fullyPaid = leftAfter < 0.01;
  const now = new Date();

  invoice.amountPaid = newPaid;
  invoice.paymentMethod = opts.method as ExternalInvoice["paymentMethod"];
  if (opts.paymentReference) {
    invoice.paymentReference = String(opts.paymentReference).slice(0, 128);
  }
  if (opts.paymentProvider) {
    invoice.paymentProvider = String(opts.paymentProvider).slice(0, 32);
  } else if (opts.method === "gateway") {
    invoice.paymentProvider = invoice.paymentProvider || "whish";
  }
  invoice.collectedBy = opts.actor;
  invoice.collectedAt = now;
  invoice.modifiedAt = now;
  invoice.lastAction = opts.note
    ? String(opts.note).slice(0, 255)
    : `${partial ? "PARTIAL_PAY" : "PAID"} method=${opts.method} applied=${apply.toFixed(2)} paid=${newPaid.toFixed(2)}/${due.toFixed(2)}`;

  if (fullyPaid) {
    invoice.status = "paid";
    invoice.paidAt = now;
  } else {
    invoice.status = "pending";
    invoice.paidAt = null;
  }

  await manager.getRepository(ExternalInvoice).save(invoice);

  if (opts.creditCompany && COMPANY_COLLECTION_METHODS.has(opts.method)) {
    await creditCompanyWallet({
      amount: apply,
      currency: "USD",
      referenceType: "invoice_payment",
      referenceId: String(payment.id),
      note: `Invoice #${invoice.id} ${opts.method} ${apply.toFixed(2)}`,
      createdBy: opts.actor,
      manager,
    });
  }

  return { invoice, payment, apply, remainingDue: leftAfter, partial };
}
