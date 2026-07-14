import { Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { WhishPaymentClaim } from "../db/entities/WhishPaymentClaim";
import { creditWallet, getWalletBalance } from "./subscriberWalletService";

export type CreateWhishClaimInput = {
  externalInvoiceId: number;
  username: string;
  amount: number;
  currency?: string;
  whishReference: string;
  note?: string | null;
};

export async function createWhishPaymentClaim(input: CreateWhishClaimInput) {
  const ref = String(input.whishReference || "").trim();
  if (!ref || ref.length < 4) {
    throw Object.assign(new Error("Whish reference / transaction number is required (min 4 characters)"), {
      status: 400,
    });
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error("Amount must be a positive number"), { status: 400 });
  }

  const invoice = await AppDataSource.getRepository(ExternalInvoice).findOne({
    where: { id: Equal(input.externalInvoiceId), username: Equal(input.username) },
  });
  if (!invoice) {
    throw Object.assign(new Error("Invoice not found"), { status: 404 });
  }
  if (String(invoice.status).toLowerCase() === "paid") {
    throw Object.assign(new Error("Invoice is already paid"), { status: 400 });
  }

  const repo = AppDataSource.getRepository(WhishPaymentClaim);
  const existingPending = await repo.findOne({
    where: {
      externalInvoiceId: Equal(input.externalInvoiceId),
      status: Equal("pending") as any,
    },
  });
  if (existingPending) {
    existingPending.amount = amount;
    existingPending.currency = (input.currency || "USD").toUpperCase();
    existingPending.whishReference = ref;
    existingPending.note = input.note ? String(input.note).slice(0, 500) : existingPending.note;
    existingPending.updatedAt = new Date();
    return repo.save(existingPending);
  }

  // Soft-dedupe identical reference for same invoice
  const sameRef = await repo.findOne({
    where: {
      externalInvoiceId: Equal(input.externalInvoiceId),
      whishReference: Equal(ref),
    },
  });
  if (sameRef && sameRef.status === "confirmed") {
    throw Object.assign(new Error("This Whish reference was already confirmed for this invoice"), {
      status: 400,
    });
  }

  const claim = repo.create({
    externalInvoiceId: input.externalInvoiceId,
    username: input.username,
    amount,
    currency: (input.currency || "USD").toUpperCase(),
    whishReference: ref,
    status: "pending",
    note: input.note ? String(input.note).slice(0, 500) : null,
  });
  const saved = await repo.save(claim);

  invoice.lastAction = `whish_claim_pending ref=${ref} amount=${amount}`;
  invoice.modifiedAt = new Date();
  await AppDataSource.getRepository(ExternalInvoice).save(invoice);

  return saved;
}

export async function listWhishPaymentClaims(opts?: {
  status?: "pending" | "confirmed" | "rejected";
  limit?: number;
  reference?: string;
}) {
  const repo = AppDataSource.getRepository(WhishPaymentClaim);
  const ref = String(opts?.reference || "").trim();
  if (ref) {
    const qb = repo
      .createQueryBuilder("c")
      .orderBy("c.created_at", "DESC")
      .take(Math.min(50, Math.max(1, opts?.limit || 20)));
    if (opts?.status) {
      qb.andWhere("c.status = :status", { status: opts.status });
    }
    // Exact match first, then prefix/contains for paste typos
    qb.andWhere(
      "(c.whish_reference = :exact OR c.whish_reference LIKE :contains)",
      { exact: ref, contains: `%${ref}%` }
    );
    return qb.getMany();
  }
  const where = opts?.status ? { status: Equal(opts.status) as any } : {};
  return repo.find({
    where,
    order: { createdAt: "DESC" } as any,
    take: Math.min(200, Math.max(1, opts?.limit || 50)),
  });
}

/** Lookup claims by Whish reference (for staff paste auto-match). */
export async function findClaimsByReference(
  reference: string,
  opts?: { status?: "pending" | "confirmed" | "rejected"; limit?: number }
) {
  return listWhishPaymentClaims({
    reference,
    status: opts?.status,
    limit: opts?.limit ?? 20,
  });
}

export async function listClaimsForInvoice(externalInvoiceId: number) {
  return AppDataSource.getRepository(WhishPaymentClaim).find({
    where: { externalInvoiceId: Equal(externalInvoiceId) },
    order: { createdAt: "DESC" } as any,
  });
}

export async function confirmWhishPaymentClaim(
  claimId: number,
  actorUsername: string,
  opts?: { paymentReference?: string; amount?: number }
) {
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(WhishPaymentClaim);
    const claim = await repo.findOne({
      where: { id: Equal(claimId) },
      lock: { mode: "pessimistic_write" },
    });
    if (!claim) throw Object.assign(new Error("Payment claim not found"), { status: 404 });
    if (claim.status === "confirmed") {
      const balance = await getWalletBalance(claim.username, manager);
      return { claim, invoice: null as ExternalInvoice | null, balance, walletCredited: false };
    }
    if (claim.status === "rejected") {
      throw Object.assign(new Error("Claim was rejected; create a new claim if needed"), { status: 400 });
    }

    const reference = String(opts?.paymentReference || claim.whishReference).trim();
    if (opts?.amount && Number.isFinite(opts.amount)) {
      claim.amount = Number(opts.amount);
    }
    claim.whishReference = reference;
    claim.status = "confirmed";
    claim.confirmedBy = actorUsername;
    claim.confirmedAt = new Date();
    claim.updatedAt = new Date();
    await repo.save(claim);

    // Credit subscriber wallet — invoice stays unpaid until they pay from balance.
    await creditWallet({
      username: claim.username,
      amount: claim.amount,
      currency: claim.currency,
      referenceType: "whish_claim",
      referenceId: String(claim.id),
      note: `Whish ref ${reference}`,
      createdBy: actorUsername,
      manager,
    });

    const invoice = await manager.getRepository(ExternalInvoice).findOne({
      where: { id: Equal(claim.externalInvoiceId) },
    });
    if (invoice && String(invoice.status).toLowerCase() !== "paid") {
      invoice.lastAction = `whish_approved_wallet_credit ref=${reference} amount=${claim.amount}`;
      invoice.modifiedAt = new Date();
      await manager.getRepository(ExternalInvoice).save(invoice);
    }

    const balance = await getWalletBalance(claim.username, manager);
    return { claim, invoice, balance, walletCredited: true };
  });
}

export async function rejectWhishPaymentClaim(
  claimId: number,
  actorUsername: string,
  reason?: string
) {
  const repo = AppDataSource.getRepository(WhishPaymentClaim);
  const claim = await repo.findOne({ where: { id: Equal(claimId) } });
  if (!claim) throw Object.assign(new Error("Payment claim not found"), { status: 404 });
  if (claim.status !== "pending") {
    throw Object.assign(new Error(`Claim is already ${claim.status}`), { status: 400 });
  }
  claim.status = "rejected";
  claim.confirmedBy = actorUsername;
  claim.confirmedAt = new Date();
  claim.rejectionReason = reason ? String(reason).slice(0, 250) : "Rejected by staff";
  claim.updatedAt = new Date();
  await repo.save(claim);

  const invoice = await AppDataSource.getRepository(ExternalInvoice).findOne({
    where: { id: Equal(claim.externalInvoiceId) },
  });
  if (invoice && String(invoice.status).toLowerCase() !== "paid") {
    invoice.lastAction = `whish_claim_rejected by ${actorUsername}`;
    invoice.modifiedAt = new Date();
    await AppDataSource.getRepository(ExternalInvoice).save(invoice);
  }
  return claim;
}
