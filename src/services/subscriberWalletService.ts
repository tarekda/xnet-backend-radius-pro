import { EntityManager, Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { SubscriberWalletEntry } from "../db/entities/SubscriberWalletEntry";
import { renewIfExpired } from "./subscriptionRenewalService";
import { applyInvoicePayment } from "../billing/applyInvoicePayment";
import { invoiceDue, remainingDue, roundMoney, withPaymentProgress } from "../billing/paymentMath";

export async function getWalletBalance(username: string, manager?: EntityManager): Promise<number> {
  const repo = (manager ?? AppDataSource).getRepository(SubscriberWalletEntry);
  const rows = await repo
    .createQueryBuilder("e")
    .select(
      "COALESCE(SUM(CASE WHEN e.entry_type = 'credit' THEN e.amount ELSE -e.amount END), 0)",
      "balance"
    )
    .where("e.username = :username", { username })
    .getRawOne<{ balance: string }>();
  return roundMoney(Number(rows?.balance ?? 0));
}

/** Sum of wallet debits already applied toward an external invoice (full + partial). */
export async function getWalletPaidTowardInvoice(
  invoiceId: number,
  manager?: EntityManager
): Promise<number> {
  const repo = (manager ?? AppDataSource).getRepository(SubscriberWalletEntry);
  const id = String(invoiceId);
  const rows = await repo
    .createQueryBuilder("e")
    .select("COALESCE(SUM(e.amount), 0)", "paid")
    .where("e.entry_type = :type", { type: "debit" })
    .andWhere("e.reference_type = :rt", { rt: "external_invoice" })
    .andWhere("(e.reference_id = :id OR e.reference_id LIKE :prefix)", {
      id,
      prefix: `${id}:p%`,
    })
    .getRawOne<{ paid: string }>();
  return roundMoney(Number(rows?.paid ?? 0));
}

export async function listWalletLedger(opts: {
  username?: string;
  entryType?: "credit" | "debit";
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 50));
  const repo = AppDataSource.getRepository(SubscriberWalletEntry);
  const qb = repo.createQueryBuilder("e").orderBy("e.created_at", "DESC");

  if (opts.username?.trim()) {
    qb.andWhere("e.username = :username", { username: opts.username.trim() });
  }
  if (opts.entryType === "credit" || opts.entryType === "debit") {
    qb.andWhere("e.entry_type = :entryType", { entryType: opts.entryType });
  }

  const [entries, total] = await qb
    .skip((page - 1) * limit)
    .take(limit)
    .getManyAndCount();

  let balance: number | null = null;
  if (opts.username?.trim()) {
    balance = await getWalletBalance(opts.username.trim());
  }

  return {
    data: entries,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    balance,
  };
}

export async function findLedgerByReference(
  referenceType: string,
  referenceId: string,
  manager?: EntityManager
) {
  return (manager ?? AppDataSource).getRepository(SubscriberWalletEntry).findOne({
    where: {
      referenceType: Equal(referenceType),
      referenceId: Equal(referenceId),
    } as any,
  });
}

export async function creditWallet(opts: {
  username: string;
  amount: number;
  currency?: string;
  referenceType: string;
  referenceId: string;
  note?: string | null;
  createdBy?: string | null;
  manager?: EntityManager;
}) {
  const amount = roundMoney(Number(opts.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error("Credit amount must be positive"), { status: 400 });
  }

  const run = async (manager: EntityManager) => {
    const existing = await findLedgerByReference(opts.referenceType, opts.referenceId, manager);
    if (existing) return existing;

    const repo = manager.getRepository(SubscriberWalletEntry);
    const entry = repo.create({
      username: opts.username,
      amount: amount.toFixed(2),
      currency: (opts.currency || "USD").toUpperCase(),
      entryType: "credit",
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
      note: opts.note ? String(opts.note).slice(0, 250) : null,
      createdBy: opts.createdBy || null,
    });
    return repo.save(entry);
  };

  if (opts.manager) return run(opts.manager);
  return AppDataSource.transaction(run);
}

export async function debitWallet(opts: {
  username: string;
  amount: number;
  currency?: string;
  referenceType: string;
  referenceId: string;
  note?: string | null;
  createdBy?: string | null;
  manager?: EntityManager;
}) {
  const amount = roundMoney(Number(opts.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error("Debit amount must be positive"), { status: 400 });
  }

  const run = async (manager: EntityManager) => {
    const existing = await findLedgerByReference(opts.referenceType, opts.referenceId, manager);
    if (existing) return existing;

    const balance = await getWalletBalance(opts.username, manager);
    if (balance + 1e-9 < amount) {
      throw Object.assign(
        new Error(`Insufficient wallet balance (have ${balance.toFixed(2)}, need ${amount.toFixed(2)})`),
        { status: 400 }
      );
    }

    const repo = manager.getRepository(SubscriberWalletEntry);
    const entry = repo.create({
      username: opts.username,
      amount: amount.toFixed(2),
      currency: (opts.currency || "USD").toUpperCase(),
      entryType: "debit",
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
      note: opts.note ? String(opts.note).slice(0, 250) : null,
      createdBy: opts.createdBy || null,
    });
    return repo.save(entry);
  };

  if (opts.manager) return run(opts.manager);
  return AppDataSource.transaction(run);
}

/**
 * Pay an external invoice from subscriber wallet balance.
 * Supports partial pay when balance < remaining due (or when opts.amount is set).
 * Marks invoice paid only when cumulative wallet payments cover the full amount.
 */
export async function payInvoiceFromWallet(opts: {
  externalInvoiceId: number;
  username: string;
  actorUsername?: string;
  renewMonths?: number;
  /** Optional cap; defaults to min(balance, remaining due). */
  amount?: number;
}) {
  return AppDataSource.transaction(async (manager) => {
    const invoiceRepo = manager.getRepository(ExternalInvoice);
    const invoice = await invoiceRepo.findOne({
      where: { id: Equal(opts.externalInvoiceId), username: Equal(opts.username) },
      lock: { mode: "pessimistic_write" },
    });
    if (!invoice) {
      throw Object.assign(new Error("Invoice not found"), { status: 404 });
    }
    if (String(invoice.status).toLowerCase() === "paid") {
      const balance = await getWalletBalance(opts.username, manager);
      return {
        invoice: withPaymentProgress(invoice),
        balance,
        renewed: false,
        alreadyPaid: true,
        partial: false,
        amountPaid: invoiceDue(invoice),
        remainingDue: 0,
      };
    }

    const due = invoiceDue(invoice);
    if (!Number.isFinite(due) || due <= 0) {
      throw Object.assign(new Error("Invoice has no payable amount"), { status: 400 });
    }

    const previouslyPaid = roundMoney(Number(invoice.amountPaid ?? 0));
    const remaining = remainingDue(due, previouslyPaid);
    if (remaining <= 0) {
      const paidAt = new Date();
      invoice.status = "paid";
      invoice.paidAt = paidAt;
      invoice.amountPaid = due;
      invoice.paymentMethod = "wallet";
      invoice.paymentProvider = "wallet";
      invoice.collectedBy = opts.actorUsername || opts.username;
      invoice.collectedAt = paidAt;
      invoice.lastAction = `paid_from_wallet (settled prior partials) by ${opts.actorUsername || opts.username}`;
      invoice.modifiedAt = paidAt;
      await invoiceRepo.save(invoice);
      const renew = await renewIfExpired(opts.username, opts.renewMonths ?? 1, manager);
      const balance = await getWalletBalance(opts.username, manager);
      return {
        invoice: withPaymentProgress(invoice),
        balance,
        renewed: renew.renewed,
        renew,
        alreadyPaid: false,
        partial: false,
        amountPaid: due,
        remainingDue: 0,
      };
    }

    const balance = await getWalletBalance(opts.username, manager);
    if (balance + 1e-9 < 0.01) {
      throw Object.assign(new Error("Wallet balance is empty — top up via Whish first"), {
        status: 400,
      });
    }

    let payAmount = Math.min(remaining, balance);
    if (opts.amount != null && Number.isFinite(Number(opts.amount))) {
      const requested = roundMoney(Number(opts.amount));
      if (requested <= 0) {
        throw Object.assign(new Error("Payment amount must be positive"), { status: 400 });
      }
      payAmount = Math.min(payAmount, requested);
    }
    payAmount = roundMoney(payAmount);
    if (payAmount < 0.01) {
      throw Object.assign(new Error("Payment amount too small"), { status: 400 });
    }

    const isPartial = payAmount + 1e-9 < remaining;
    const referenceId = isPartial || previouslyPaid > 0
      ? `${invoice.id}:p${Date.now()}`
      : String(invoice.id);

    const debit = await debitWallet({
      username: opts.username,
      amount: payAmount,
      currency: "USD",
      referenceType: "external_invoice",
      referenceId,
      note: isPartial
        ? `Partial pay invoice #${invoice.id} (${payAmount.toFixed(2)} of ${remaining.toFixed(2)} remaining)`
        : `Pay invoice #${invoice.id} from wallet`,
      createdBy: opts.actorUsername || opts.username,
      manager,
    });

    const walletTxnId = `WALLET-${debit.id}`;
    const applied = await applyInvoicePayment(manager, {
      invoice,
      amount: payAmount,
      method: "wallet",
      actor: opts.actorUsername || opts.username,
      paymentReference: walletTxnId,
      paymentProvider: "wallet",
      creditCompany: false,
      note: isPartial
        ? `partial_wallet_pay txn=${walletTxnId} applied=${payAmount.toFixed(2)}`
        : `paid_from_wallet txn=${walletTxnId}`,
    });

    const paidAt = invoice.paidAt || invoice.collectedAt || new Date();
    if (!applied.partial) {
      const renew = await renewIfExpired(opts.username, opts.renewMonths ?? 1, manager);
      const newBalance = await getWalletBalance(opts.username, manager);
      return {
        invoice: withPaymentProgress(invoice),
        balance: newBalance,
        renewed: renew.renewed,
        renew,
        alreadyPaid: false,
        partial: false,
        amountApplied: payAmount,
        amountPaid: due,
        remainingDue: 0,
        walletTransactionId: walletTxnId,
        paidAt,
      };
    }

    const newBalance = await getWalletBalance(opts.username, manager);
    return {
      invoice: withPaymentProgress(invoice),
      balance: newBalance,
      renewed: false,
      alreadyPaid: false,
      partial: true,
      amountApplied: payAmount,
      amountPaid: applied.invoice.amountPaid,
      remainingDue: applied.remainingDue,
      walletTransactionId: walletTxnId,
      paidAt,
    };
  });
}

/** Staff/manual credit helper (optional top-ups). */
export async function adminCreditWallet(opts: {
  username: string;
  amount: number;
  note?: string;
  createdBy: string;
  referenceId?: string;
}) {
  return creditWallet({
    username: opts.username,
    amount: opts.amount,
    referenceType: "admin_credit",
    referenceId: opts.referenceId || `admin_${Date.now()}`,
    note: opts.note || "Manual wallet credit",
    createdBy: opts.createdBy,
  });
}

/** Staff/manual debit helper (clawbacks / adjustments). */
export async function adminDebitWallet(opts: {
  username: string;
  amount: number;
  note?: string;
  createdBy: string;
  referenceId?: string;
}) {
  return debitWallet({
    username: opts.username,
    amount: opts.amount,
    referenceType: "admin_debit",
    referenceId: opts.referenceId || `admin_debit_${Date.now()}`,
    note: opts.note || "Manual wallet debit",
    createdBy: opts.createdBy,
  });
}
