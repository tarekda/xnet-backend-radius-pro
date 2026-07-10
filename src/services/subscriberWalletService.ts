import { EntityManager, Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { SubscriberWalletEntry } from "../db/entities/SubscriberWalletEntry";
import { renewIfExpired } from "./subscriptionRenewalService";

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

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
 * Marks invoice paid with paymentMethod/provider=wallet and paymentReference=WALLET-{ledgerId}.
 */
export async function payInvoiceFromWallet(opts: {
  externalInvoiceId: number;
  username: string;
  actorUsername?: string;
  renewMonths?: number;
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
        invoice,
        balance,
        renewed: false,
        alreadyPaid: true,
      };
    }

    const amount = roundMoney(Number(invoice.totalAmount ?? invoice.amount ?? 0));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw Object.assign(new Error("Invoice has no payable amount"), { status: 400 });
    }

    const debit = await debitWallet({
      username: opts.username,
      amount,
      currency: "USD",
      referenceType: "external_invoice",
      referenceId: String(invoice.id),
      note: `Pay invoice #${invoice.id} from wallet`,
      createdBy: opts.actorUsername || opts.username,
      manager,
    });

    const paidAt = new Date();
    const walletTxnId = `WALLET-${debit.id}`;

    invoice.status = "paid";
    invoice.paidAt = paidAt;
    invoice.paymentMethod = "wallet";
    invoice.paymentProvider = "wallet";
    invoice.paymentReference = walletTxnId;
    invoice.collectedBy = opts.actorUsername || opts.username;
    invoice.collectedAt = paidAt;
    invoice.lastAction = `paid_from_wallet txn=${walletTxnId} at ${paidAt.toISOString()} by ${opts.actorUsername || opts.username}`;
    invoice.modifiedAt = paidAt;
    await invoiceRepo.save(invoice);

    const renew = await renewIfExpired(opts.username, opts.renewMonths ?? 1, manager);
    const balance = await getWalletBalance(opts.username, manager);

    return {
      invoice,
      balance,
      renewed: renew.renewed,
      renew,
      alreadyPaid: false,
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
