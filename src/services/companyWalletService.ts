import { EntityManager, Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { CompanyWalletEntry } from "../db/entities/CompanyWalletEntry";
import { roundMoney } from "../billing/paymentMath";

export async function getCompanyWalletBalance(manager?: EntityManager): Promise<number> {
  const repo = (manager ?? AppDataSource).getRepository(CompanyWalletEntry);
  const row = await repo
    .createQueryBuilder("e")
    .select(
      "COALESCE(SUM(CASE WHEN e.entry_type = 'credit' THEN e.amount ELSE -e.amount END), 0)",
      "balance"
    )
    .getRawOne<{ balance: string }>();
  return roundMoney(Number(row?.balance ?? 0));
}

async function findByReference(
  referenceType: string,
  referenceId: string,
  manager?: EntityManager
) {
  return (manager ?? AppDataSource).getRepository(CompanyWalletEntry).findOne({
    where: { referenceType: Equal(referenceType), referenceId: Equal(referenceId) } as any,
  });
}

export async function reverseCompanyInvoicePayment(
  paymentId: number | string,
  opts: { actor?: string | null; manager?: EntityManager }
) {
  const credit = await findByReference("invoice_payment", String(paymentId), opts.manager);
  if (!credit) return null;
  return debitCompanyWallet({
    amount: Number(credit.amount),
    currency: credit.currency,
    referenceType: "invoice_unpay",
    referenceId: String(paymentId),
    note: `Reverse invoice payment ${paymentId}`,
    createdBy: opts.actor || null,
    allowOverdraft: true,
    manager: opts.manager,
  });
}

export async function listCompanyWalletLedger(opts: {
  entryType?: "credit" | "debit";
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 50));
  const repo = AppDataSource.getRepository(CompanyWalletEntry);
  const qb = repo.createQueryBuilder("e").orderBy("e.created_at", "DESC");
  if (opts.entryType === "credit" || opts.entryType === "debit") {
    qb.andWhere("e.entry_type = :entryType", { entryType: opts.entryType });
  }
  const [entries, total] = await qb
    .skip((page - 1) * limit)
    .take(limit)
    .getManyAndCount();
  const balance = await getCompanyWalletBalance();
  return {
    data: entries,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    balance,
  };
}

export async function creditCompanyWallet(opts: {
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
    const existing = await findByReference(opts.referenceType, opts.referenceId, manager);
    if (existing) return existing;
    const repo = manager.getRepository(CompanyWalletEntry);
    return repo.save(
      repo.create({
        amount: amount.toFixed(2),
        currency: (opts.currency || "USD").toUpperCase(),
        entryType: "credit",
        referenceType: opts.referenceType,
        referenceId: opts.referenceId,
        note: opts.note ? String(opts.note).slice(0, 250) : null,
        createdBy: opts.createdBy || null,
      })
    );
  };
  if (opts.manager) return run(opts.manager);
  return AppDataSource.transaction(run);
}

export async function debitCompanyWallet(opts: {
  amount: number;
  currency?: string;
  referenceType: string;
  referenceId: string;
  note?: string | null;
  createdBy?: string | null;
  allowOverdraft?: boolean;
  manager?: EntityManager;
}) {
  const amount = roundMoney(Number(opts.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error("Debit amount must be positive"), { status: 400 });
  }
  const run = async (manager: EntityManager) => {
    const existing = await findByReference(opts.referenceType, opts.referenceId, manager);
    if (existing) return existing;
    const balance = await getCompanyWalletBalance(manager);
    if (!opts.allowOverdraft && balance + 1e-9 < amount) {
      throw Object.assign(
        new Error(
          `Insufficient company wallet (have ${balance.toFixed(2)}, need ${amount.toFixed(2)}). Credit the company wallet first.`
        ),
        { status: 400 }
      );
    }
    const repo = manager.getRepository(CompanyWalletEntry);
    return repo.save(
      repo.create({
        amount: amount.toFixed(2),
        currency: (opts.currency || "USD").toUpperCase(),
        entryType: "debit",
        referenceType: opts.referenceType,
        referenceId: opts.referenceId,
        note: opts.note ? String(opts.note).slice(0, 250) : null,
        createdBy: opts.createdBy || null,
      })
    );
  };
  if (opts.manager) return run(opts.manager);
  return AppDataSource.transaction(run);
}
