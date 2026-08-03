// src/services/invoice.service.ts
import { AppDataSource } from '../db/config';
import { In, IsNull, SelectQueryBuilder } from 'typeorm';
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { Invoices } from "../db/entities/Invoices";
import { startOfMonth } from "date-fns";
import { UserDetails } from '../db/entities/UserDetails';
import { ExternalInvoice } from '../db/entities/ExternalInvoice';
import { ModificationLog } from '../db/entities/ModificationLog';
import { invoiceEvents } from '../events/invoiceEvents';
import { recordInvoicePayment } from '../metrics/metrics';

/** Default VAT/tax rate for new invoices (e.g. 0.11 = 11%). 0 = tax inclusive amount only. */
function defaultInvoiceTaxRate(): number {
    const raw = Number(process.env.INVOICE_TAX_RATE ?? process.env.DEFAULT_TAX_RATE ?? 0);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function roundMoney2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Apply tax breakdown. By default `amount` is treated as the total (tax-inclusive)
 * when INVOICE_TAX_INCLUSIVE=1 (default), or as subtotal when inclusive=0.
 */
export function applyInvoiceTaxFields(
    amount: number,
    opts?: { taxRate?: number | null; taxInclusive?: boolean }
): {
    amount: number;
    subtotalAmount: number;
    taxRate: number;
    taxAmount: number;
    totalAmount: number;
} {
    const taxRate = opts?.taxRate != null && Number.isFinite(Number(opts.taxRate))
        ? Number(opts.taxRate)
        : defaultInvoiceTaxRate();
    const inclusive =
        opts?.taxInclusive !== undefined
            ? opts.taxInclusive
            : String(process.env.INVOICE_TAX_INCLUSIVE ?? "1") !== "0";
    const base = roundMoney2(Number(amount) || 0);

    if (taxRate <= 0) {
        return {
            amount: base,
            subtotalAmount: base,
            taxRate: 0,
            taxAmount: 0,
            totalAmount: base,
        };
    }

    if (inclusive) {
        const totalAmount = base;
        const subtotalAmount = roundMoney2(totalAmount / (1 + taxRate));
        const taxAmount = roundMoney2(totalAmount - subtotalAmount);
        return { amount: totalAmount, subtotalAmount, taxRate, taxAmount, totalAmount };
    }

    const subtotalAmount = base;
    const taxAmount = roundMoney2(subtotalAmount * taxRate);
    const totalAmount = roundMoney2(subtotalAmount + taxAmount);
    return { amount: totalAmount, subtotalAmount, taxRate, taxAmount, totalAmount };
}

function isYmdOnly(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function ymdToLocalDayStart(ymd: string): Date {
    // Interpret YYYY-MM-DD as local/server day start
    return new Date(`${ymd}T00:00:00.000`);
}

function ymdToLocalNextDayStart(ymd: string): Date {
    const d = ymdToLocalDayStart(ymd);
    d.setDate(d.getDate() + 1);
    return d;
}

function parseRangeStart(value: string): Date {
    // If caller passes date-only, interpret as start-of-day in server/local time
    // (avoids UTC shifting which can make "same-day" filters look empty)
    if (isYmdOnly(value)) return ymdToLocalDayStart(value);
    return new Date(value);
}

function parseRangeEnd(value: string): Date {
    // If caller passes date-only, interpret as end-of-day in server/local time (inclusive)
    if (isYmdOnly(value)) return new Date(`${value}T23:59:59.999`);
    return new Date(value);
}

type AgingBucket = 'current' | '1_30' | '31_60' | '61_90' | '90_plus';

function normalizeAgeBucket(value?: string): AgingBucket | null {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw === 'current') return 'current';
    if (raw === '1_30' || raw === '1-30') return '1_30';
    if (raw === '31_60' || raw === '31-60') return '31_60';
    if (raw === '61_90' || raw === '61-90') return '61_90';
    if (raw === '90_plus' || raw === '90+') return '90_plus';
    return null;
}

export type MissingDataFilter = 'no_address' | 'no_pay_due';

function normalizeMissingDataFilter(value?: string): MissingDataFilter | null {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'no_address') return 'no_address';
    if (raw === 'no_pay_due') return 'no_pay_due';
    return null;
}

function applyMissingDataFilter(
    qb: SelectQueryBuilder<ExternalInvoice>,
    alias: string,
    missingData?: string
) {
    const filter = normalizeMissingDataFilter(missingData);
    if (filter === 'no_address') {
        qb.andWhere(`(${alias}.address IS NULL OR TRIM(${alias}.address) = '')`);
    } else if (filter === 'no_pay_due') {
        qb.andWhere(`${alias}.payDueDate IS NULL`);
    }
}

export type PayDueFilter = 'today' | 'overdue' | 'this_week' | 'this_month' | 'upcoming';

function normalizePayDueFilter(value?: string): PayDueFilter | null {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'today') return 'today';
    if (raw === 'overdue') return 'overdue';
    if (raw === 'this_week' || raw === 'this-week' || raw === 'next_7_days') return 'this_week';
    if (raw === 'this_month' || raw === 'this-month' || raw === 'month') return 'this_month';
    if (raw === 'upcoming') return 'upcoming';
    return null;
}

function applyPayDueFilter(
    qb: SelectQueryBuilder<ExternalInvoice>,
    alias: string,
    payDueFilter?: string
) {
    const filter = normalizePayDueFilter(payDueFilter);
    if (!filter) return;

    qb.andWhere(`${alias}.payDueDate IS NOT NULL`);

    if (filter === 'today') {
        qb.andWhere(`${alias}.payDueDate = CURDATE()`);
        return;
    }
    if (filter === 'overdue') {
        qb.andWhere(`${alias}.payDueDate < CURDATE()`);
        return;
    }
    if (filter === 'this_week') {
        qb.andWhere(`${alias}.payDueDate >= CURDATE()`);
        qb.andWhere(`${alias}.payDueDate <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)`);
        return;
    }
    if (filter === 'this_month') {
        qb.andWhere(`${alias}.payDueDate >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`);
        qb.andWhere(`${alias}.payDueDate <= LAST_DAY(CURDATE())`);
        return;
    }
    qb.andWhere(`${alias}.payDueDate > DATE_ADD(CURDATE(), INTERVAL 7 DAY)`);
}

function applyAgeBucketFilter(
    qb: SelectQueryBuilder<ExternalInvoice>,
    alias: string,
    ageBucket?: string,
    graceDays = 7
) {
    const bucket = normalizeAgeBucket(ageBucket);
    if (!bucket) return;

    // Aging is meaningful for open items only.
    qb.andWhere(`${alias}.status IN (:...openStatuses)`, { openStatuses: ['unpaid', 'pending'] });

    const overdueExpr = `DATEDIFF(CURDATE(), DATE_ADD(LAST_DAY(${alias}.billingMonth), INTERVAL :graceDaysAge DAY))`;
    qb.setParameter('graceDaysAge', Math.max(0, Number(graceDays) || 0));

    if (bucket === 'current') {
        qb.andWhere(`${overdueExpr} <= 0`);
        return;
    }
    if (bucket === '1_30') {
        qb.andWhere(`${overdueExpr} BETWEEN 1 AND 30`);
        return;
    }
    if (bucket === '31_60') {
        qb.andWhere(`${overdueExpr} BETWEEN 31 AND 60`);
        return;
    }
    if (bucket === '61_90') {
        qb.andWhere(`${overdueExpr} BETWEEN 61 AND 90`);
        return;
    }
    qb.andWhere(`${overdueExpr} >= 91`);
}

export const generateMonthlyInvoices = async () => {
    const userProfileRepo = AppDataSource.getRepository(Raduserprofile);
    const invoiceRepo = AppDataSource.getRepository(Invoices);
    const userDetailsRepo = AppDataSource.getRepository(UserDetails);

    const userProfiles = await userProfileRepo.find({
        relations: ["profile"],
        where: {
            accountStatus: "active",
        },
    });

    const billingMonth = startOfMonth(new Date()).toISOString();

    for (const user of userProfiles) {
        const exists = await invoiceRepo.findOne({
            where: {
                userProfile: { id: user.id },
                billingMonth,
            },
            relations: ["userProfile"],
        });

        if (!exists) {
            const username = user.username;
            const userDetails = await userDetailsRepo.findOne({ where: { username } }) || new UserDetails();
            const invoice = invoiceRepo.create({
                userDetails,
                userProfile: user,
                billingMonth,
                amount: (user.profile.price || 0),
                status: "unpaid",
            });
            await invoiceRepo.save(invoice);
        }
    }
};

export const getAllInvoices = async (
    page = 1,
    limit = 10,
    search = '',
    dateFrom?: string,
    dateTo?: string
) => {
    const invoiceRepo = AppDataSource.getRepository(Invoices);

    const qb = invoiceRepo.createQueryBuilder("invoice")
        .leftJoinAndSelect("invoice.userProfile", "userProfile")
        .leftJoinAndSelect("userProfile.profile", "profile")
        .leftJoinAndSelect("invoice.userDetails", "userDetails")
        .orderBy("invoice.createdAt", "DESC")
        .skip((page - 1) * limit)
        .take(limit);

    // 🔍 Apply search (username or full name)
    if (search) {
        qb.andWhere(
            "(userProfile.username LIKE :search OR userDetails.fullName LIKE :search)",
            { search: `%${search}%` }
        );
    }

    // 📅 Apply date range
    if (dateFrom && dateTo) {
        qb.andWhere("invoice.billingMonth BETWEEN :from AND :to", {
            from: dateFrom,
            to: dateTo,
        });
    } else if (dateFrom) {
        qb.andWhere("invoice.billingMonth >= :from", { from: dateFrom });
    } else if (dateTo) {
        qb.andWhere("invoice.billingMonth <= :to", { to: dateTo });
    }

    const [data, total] = await qb.getManyAndCount();

    return {
        data,
        total,
        page,
        totalPages: Math.ceil(total / limit),
    };
};

export const payInvoice = async (invoiceId: number) => {
    return AppDataSource.transaction(async (manager) => {
        const invoiceRepo = manager.getRepository(Invoices);
        const invoice = await invoiceRepo.findOne({
            where: { id: invoiceId },
            lock: { mode: "pessimistic_write" },
        });
        if (!invoice) {
            throw new Error("Invoice not found");
        }
        // Idempotent: already paid → return as-is (safe to retry)
        if (String(invoice.status).toLowerCase() === "paid") {
            recordInvoicePayment("pay", "idempotent");
            return invoice;
        }

        invoice.status = "paid";
        invoice.paidAt = new Date();
        await invoiceRepo.save(invoice);
        recordInvoicePayment("pay", "ok");
        return invoice;
    });
};

export const collectInvoice = async (invoiceId: number, collectorUsername: string, paymentMethod: 'cash' | 'pos' | 'transfer' | 'other' | 'gateway' = 'cash') => {
    return AppDataSource.transaction(async (manager) => {
        const invoiceRepo = manager.getRepository(ExternalInvoice);
        const invoice = await invoiceRepo.findOne({
            where: { id: invoiceId },
            lock: { mode: "pessimistic_write" },
        });
        if (!invoice) {
            throw new Error("Invoice not found");
        }
        if (String(invoice.status).toLowerCase() === "paid") {
            recordInvoicePayment("collect", "idempotent");
            return invoice;
        }

        invoice.status = "paid";
        invoice.paidAt = new Date();
        (invoice as any).paymentMethod = paymentMethod;
        (invoice as any).collectedBy = collectorUsername;
        (invoice as any).collectedAt = new Date();

        await invoiceRepo.save(invoice);
        recordInvoicePayment("collect", "ok");
        return invoice;
    });
};

export const reconcileInvoiceCash = async (
    invoiceId: number,
    reconcilerUsername: string,
    actorRole?: 'admin' | 'manager' | 'support' | 'collector'
) => {
    const invoiceRepo = AppDataSource.getRepository(ExternalInvoice);

    const invoice = await invoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) {
        throw new Error('Invoice not found');
    }

    // RBAC: collectors can only reconcile invoices they collected
    // (managers/admins can reconcile any)
    if (actorRole === 'collector' && invoice.collectedBy !== reconcilerUsername) {
        throw new Error('Forbidden');
    }

    if (!invoice.collectedBy) {
        throw new Error('Invoice is not collected');
    }

    if ((invoice as any).paymentMethod !== 'cash') {
        throw new Error('Only cash invoices can be reconciled');
    }

    if ((invoice as any).cashReconciled) {
        return invoice;
    }

    (invoice as any).cashReconciled = true;
    (invoice as any).reconciledBy = reconcilerUsername;
    (invoice as any).reconciledAt = new Date();

    await invoiceRepo.save(invoice);
    return invoice;
};

export const reconcileBulkCash = async (params: {
    dateFrom: string;
    dateTo: string;
    collector?: string;
    actorUsername: string;
}) => {
    const { dateFrom, dateTo, collector, actorUsername } = params;

    const from = parseRangeStart(dateFrom);
    const to = parseRangeEnd(dateTo);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new Error('Invalid date range');
    }

    const repo = AppDataSource.getRepository(ExternalInvoice);

    const qb = repo.createQueryBuilder('ext')
        .select('ext.id', 'id')
        .where('ext.deletedAt IS NULL')
        .andWhere('ext.cashReconciled = :cashReconciled', { cashReconciled: false })
        .andWhere('ext.paymentMethod = :paymentMethod', { paymentMethod: 'cash' })
        .andWhere('ext.collectedBy IS NOT NULL')
        .andWhere('ext.collectedAt IS NOT NULL');

    // Robust whole-day filtering for YYYY-MM-DD inputs:
    // use [fromStart, nextDayStart) to avoid midnight/precision/timezone edge cases.
    if (isYmdOnly(dateFrom) && isYmdOnly(dateTo)) {
        const fromStart = ymdToLocalDayStart(dateFrom);
        const toExclusive = ymdToLocalNextDayStart(dateTo);
        qb.andWhere('ext.collectedAt >= :from AND ext.collectedAt < :to', { from: fromStart, to: toExclusive });
    } else {
        qb.andWhere('ext.collectedAt BETWEEN :from AND :to', { from, to });
    }

    if (collector) {
        qb.andWhere('ext.collectedBy = :collector', { collector });
    }

    const rows = await qb.getRawMany<{ id: string | number }>();
    const reconciledIds = rows
        .map(r => Number(r.id))
        .filter(n => Number.isFinite(n));

    if (reconciledIds.length === 0) {
        return { reconciledCount: 0, reconciledIds: [] as number[] };
    }

    await repo.createQueryBuilder()
        .update(ExternalInvoice)
        .set({
            cashReconciled: true,
            reconciledBy: actorUsername,
            reconciledAt: new Date(),
        } as any)
        .whereInIds(reconciledIds)
        .execute();

    return { reconciledCount: reconciledIds.length, reconciledIds };
};

export const payExternalInvoice = async (
    invoiceId: number,
    actorUsername: string,
    paymentMethod: 'cash' | 'pos' | 'transfer' | 'other' | 'gateway' | 'wallet' = 'cash',
    extras?: { paymentReference?: string | null; paymentProvider?: string | null; paidAmount?: number | null }
) => {
    return AppDataSource.transaction(async (manager) => {
        const invoiceRepo = manager.getRepository(ExternalInvoice);
        const invoice = await invoiceRepo.findOne({
            where: { id: invoiceId },
            lock: { mode: "pessimistic_write" },
        });
        if (!invoice) {
            throw new Error("Invoice not found");
        }
        // Idempotent: double-submit / retry must not re-fire side effects
        if (String(invoice.status).toLowerCase() === "paid") {
            recordInvoicePayment("external_pay", "idempotent");
            return invoice;
        }

        const paidAmount = extras?.paidAmount;
        if (paidAmount != null && Number.isFinite(paidAmount) && paidAmount > 0) {
            invoice.amount = paidAmount;
            if (invoice.totalAmount != null) {
                invoice.totalAmount = paidAmount;
            }
            if (invoice.subtotalAmount != null) {
                invoice.subtotalAmount = paidAmount;
            }
        }

        invoice.status = "paid";
        invoice.paidAt = new Date();
        (invoice as any).paymentMethod = paymentMethod;
        (invoice as any).collectedBy = actorUsername;
        (invoice as any).collectedAt = new Date();
        if (extras?.paymentReference) {
            invoice.paymentReference = String(extras.paymentReference).slice(0, 128);
        }
        if (extras?.paymentProvider) {
            invoice.paymentProvider = String(extras.paymentProvider).slice(0, 32);
        } else if (paymentMethod === "gateway") {
            invoice.paymentProvider = invoice.paymentProvider || "whish";
        }

        await invoiceRepo.save(invoice);
        recordInvoicePayment("external_pay", "ok");
        return invoice;
    });
};

export const unpayExternalInvoice = async (invoiceId: number, actorUsername: string) => {
    return AppDataSource.transaction(async (manager) => {
        const invoiceRepo = manager.getRepository(ExternalInvoice);
        const invoice = await invoiceRepo.findOne({
            where: { id: invoiceId },
            lock: { mode: "pessimistic_write" },
        });
        if (!invoice) {
            throw new Error("Invoice not found");
        }
        if (String(invoice.status).toLowerCase() !== "paid") {
            return invoice;
        }

        invoice.status = "unpaid";
        invoice.paidAt = null;
        (invoice as any).paymentMethod = null;
        (invoice as any).collectedBy = null;
        invoice.paymentReference = null;
        invoice.paymentProvider = null;
        (invoice as any).collectedAt = null;
        (invoice as any).cashReconciled = false;
        (invoice as any).reconciledBy = null;
        (invoice as any).reconciledAt = null;
        (invoice as any).modifiedBy = actorUsername;
        (invoice as any).modifiedAt = new Date();
        (invoice as any).lastAction = "UNPAY";

        await invoiceRepo.save(invoice);
        recordInvoicePayment("unpay", "ok");
        return invoice;
    });
};


export const bulkPayInvoices = async (invoiceIds: number[]) => {
    const invoiceRepo = AppDataSource.getRepository(Invoices);

    const invoices = await invoiceRepo.findByIds(invoiceIds);
    if (invoices.length === 0) {
        throw new Error('No invoices found');
    }

    for (const invoice of invoices) {
        invoice.status = 'paid';
    }

    await invoiceRepo.save(invoices);

    return invoices;
};

export type UpsertExternalInvoicesResult = {
    inserted: number;
    updated: number;
    removedFromScope: number;
    enrichedFromUserDetails: number;
    inheritedPayDueDates?: number;
    inheritedCarryoverLines?: number;
    mergedDuplicates?: number;
};

export function normalizeDebitLabel(value: unknown): string {
    if (value === undefined || value === null) return '';
    return String(value).trim().toLowerCase().slice(0, 64);
}

export function normalizeBillingMonthKey(value: string | undefined | null): string {
    if (!value) {
        const today = new Date();
        return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    }
    const s = String(value).trim();
    const ym = /^(\d{4})-(\d{2})/.exec(s);
    if (ym) return `${ym[1]}-${ym[2]}-01`;
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    }
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
}

function externalInvoiceCompositeKey(item: Partial<ExternalInvoice>): string {
    const username = String(item.username ?? '').trim().toLowerCase();
    const billingMonth = normalizeBillingMonthKey(item.billingMonth as string);
    const provider = String(item.provider ?? '').trim().toLowerCase();
    const debitLabel = normalizeDebitLabel((item as ExternalInvoice).debitLabel);
    return `${username}|${billingMonth}|${provider}|${debitLabel}`;
}

function accountKey(username: string, provider: string): string {
    return `${String(username).trim().toLowerCase()}|${String(provider ?? '').trim().toLowerCase()}`;
}

export function previousBillingMonthKey(billingMonth: string): string {
    const bm = normalizeBillingMonthKey(billingMonth);
    const match = /^(\d{4})-(\d{2})/.exec(bm);
    if (!match) return bm;
    let year = parseInt(match[1], 10);
    let month = parseInt(match[2], 10) - 1;
    if (month < 1) {
        month = 12;
        year -= 1;
    }
    return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function isCarryoverDebitLabel(value: unknown): boolean {
    return normalizeDebitLabel(value) === 'carryover';
}

function payDueDayInMonth(payDueDate: string | null | undefined): number | null {
    if (!payDueDate || String(payDueDate).trim() === '') return null;
    const day = parseInt(String(payDueDate).slice(8, 10), 10);
    return Number.isFinite(day) && day >= 1 && day <= 31 ? day : null;
}

function payDueDateForBillingMonth(billingMonth: string, dayOfMonth: number): string | null {
    const bm = normalizeBillingMonthKey(billingMonth);
    const match = /^(\d{4})-(\d{2})/.exec(bm);
    if (!match) return null;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const lastDay = new Date(year, month, 0).getDate();
    const day = Math.min(dayOfMonth, lastDay);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function priorRowsForAccount(
    existing: ExternalInvoice[],
    username: string,
    provider: string,
    beforeBillingMonth: string
): ExternalInvoice[] {
    const acct = accountKey(username, provider);
    const cutoff = new Date(`${normalizeBillingMonthKey(beforeBillingMonth)}T12:00:00`).getTime();
    return existing
        .filter((row) => {
            if (row.deletedAt) return false;
            if (accountKey(row.username, row.provider) !== acct) return false;
            const rowTime = new Date(String(row.billingMonth)).getTime();
            return rowTime < cutoff;
        })
        .sort((a, b) => new Date(String(b.billingMonth)).getTime() - new Date(String(a.billingMonth)).getTime());
}

/** Carry forward due day-of-month from the customer's latest prior invoice line into the import billing month. */
export function inheritPayDueDatesFromPrior(
    incoming: Partial<ExternalInvoice>[],
    existing: ExternalInvoice[],
    options?: { overrideIncoming?: boolean }
): number {
    const overrideIncoming = options?.overrideIncoming ?? false;
    let inherited = 0;

    for (const inv of incoming) {
        const hasIncoming =
            inv.payDueDate !== undefined && inv.payDueDate !== null && String(inv.payDueDate).trim() !== '';
        if (hasIncoming && !overrideIncoming) continue;

        const list = priorRowsForAccount(
            existing,
            String(inv.username ?? ''),
            String(inv.provider ?? ''),
            inv.billingMonth as string
        );
        if (!list.length) continue;

        const debitNorm = normalizeDebitLabel((inv as ExternalInvoice).debitLabel);
        const prior =
            list.find((r) => normalizeDebitLabel(r.debitLabel) === debitNorm && payDueDayInMonth(r.payDueDate)) ??
            list.find((r) => payDueDayInMonth(r.payDueDate));
        const priorDay = payDueDayInMonth(prior?.payDueDate);
        if (!priorDay) continue;

        const nextDue = payDueDateForBillingMonth(String(inv.billingMonth ?? ''), priorDay);
        if (!nextDue) continue;

        inv.payDueDate = nextDue;
        inherited++;
    }
    return inherited;
}

/** @deprecated Use inheritPayDueDatesFromPrior */
export const inheritPayDueDatesFromPriorUnpaid = inheritPayDueDatesFromPrior;

function latestDateString(a: string | null | undefined, b: string | null | undefined): string | null {
    const av = a && String(a).trim() ? String(a).slice(0, 10) : null;
    const bv = b && String(b).trim() ? String(b).slice(0, 10) : null;
    if (!av) return bv;
    if (!bv) return av;
    return av >= bv ? av : bv;
}

/**
 * Merge import rows that describe the same invoice — same username, same full name,
 * same billing month, provider, and payment line — into a single record.
 * Amounts are summed; the pay due date keeps the most recent of the merged rows.
 */
export function mergeDuplicateIncomingInvoices(
    incoming: Partial<ExternalInvoice>[]
): { invoices: Partial<ExternalInvoice>[]; merged: number } {
    const byKey = new Map<string, Partial<ExternalInvoice>>();
    const order: string[] = [];
    let merged = 0;

    for (const inv of incoming) {
        const fullNameKey = String(inv.fullName ?? '').trim().toLowerCase();
        const key = `${externalInvoiceCompositeKey(inv)}|${fullNameKey}`;
        const existing = byKey.get(key);

        if (!existing) {
            byKey.set(key, { ...inv });
            order.push(key);
            continue;
        }

        merged++;
        existing.amount = Number(existing.amount ?? 0) + Number(inv.amount ?? 0);
        existing.payDueDate = latestDateString(existing.payDueDate, inv.payDueDate);
        if (!String(existing.email ?? '').trim() && String(inv.email ?? '').trim()) existing.email = inv.email;
        if (!String(existing.phoneNumber ?? '').trim() && String(inv.phoneNumber ?? '').trim()) {
            existing.phoneNumber = inv.phoneNumber;
        }
        if (!String(existing.address ?? '').trim() && String(inv.address ?? '').trim()) existing.address = inv.address;
        // A merged record is only "paid" when every source row was paid.
        if (existing.status === 'paid' && inv.status !== 'paid') existing.status = inv.status;
    }

    return { invoices: order.map((k) => byKey.get(k) as Partial<ExternalInvoice>), merged };
}

/** Add carryover payment lines when the prior month had an unpaid carryover debit for the same customer. */
export function inheritCarryoverLinesFromPriorMonth(
    incoming: Partial<ExternalInvoice>[],
    existing: ExternalInvoice[]
): { invoices: Partial<ExternalInvoice>[]; added: number } {
    const incomingKeys = new Set(incoming.map((row) => externalInvoiceCompositeKey(row)));
    const seedByAccount = new Map<string, Partial<ExternalInvoice>>();

    for (const inv of incoming) {
        const acct = accountKey(String(inv.username ?? ''), String(inv.provider ?? ''));
        const current = seedByAccount.get(acct);
        if (!current || !normalizeDebitLabel((inv as ExternalInvoice).debitLabel)) {
            seedByAccount.set(acct, inv);
        }
    }

    const added: Partial<ExternalInvoice>[] = [];

    for (const seed of seedByAccount.values()) {
        const username = String(seed.username ?? '').trim();
        const provider = String(seed.provider ?? '').trim();
        if (!username || !provider) continue;

        const billingMonth = normalizeBillingMonthKey(seed.billingMonth as string);
        const carryoverKey = externalInvoiceCompositeKey({
            username,
            provider,
            billingMonth,
            debitLabel: 'carryover',
        } as ExternalInvoice);
        if (incomingKeys.has(carryoverKey)) continue;

        const priorMonth = previousBillingMonthKey(billingMonth);
        const priorCarryover = existing.find(
            (row) =>
                !row.deletedAt &&
                accountKey(row.username, row.provider) === accountKey(username, provider) &&
                normalizeBillingMonthKey(row.billingMonth) === priorMonth &&
                isCarryoverDebitLabel(row.debitLabel) &&
                row.status !== 'paid' &&
                Number(row.amount) > 0
        );
        if (!priorCarryover) continue;

        added.push({
            username,
            fullName: String(seed.fullName ?? priorCarryover.fullName ?? '').trim() || priorCarryover.fullName,
            email: String(seed.email ?? priorCarryover.email ?? '').trim() || priorCarryover.email || '',
            phoneNumber:
                String(seed.phoneNumber ?? priorCarryover.phoneNumber ?? '').trim() ||
                priorCarryover.phoneNumber ||
                '',
            address: seed.address ?? priorCarryover.address ?? null,
            provider,
            billingMonth,
            debitLabel: 'carryover',
            amount: priorCarryover.amount,
            status: 'pending',
            lastAction: 'IMPORT_CARRYOVER',
            modifiedBy: seed.modifiedBy,
        });
        incomingKeys.add(carryoverKey);
    }

    return { invoices: added.length > 0 ? [...incoming, ...added] : incoming, added: added.length };
}

function mergeOptionalAddress(
    existing: string | null | undefined,
    incoming: unknown
): string | null {
    const trimmedIncoming =
        incoming !== undefined && incoming !== null ? String(incoming).trim() : '';
    if (trimmedIncoming.length > 0) return trimmedIncoming;
    const existingTrim = existing !== undefined && existing !== null ? String(existing).trim() : '';
    return existingTrim.length > 0 ? existingTrim : null;
}

function mergeOptionalPayDueDate(
    existing: string | null | undefined,
    incoming: unknown
): string | null {
    if (incoming !== undefined && incoming !== null && String(incoming).trim() !== '') {
        const rawDue = incoming as string | Date;
        const asDate = rawDue instanceof Date ? rawDue : new Date(String(rawDue));
        if (!isNaN(asDate.getTime())) return asDate.toISOString().slice(0, 10);
        return String(incoming).trim().slice(0, 10);
    }
    if (existing !== undefined && existing !== null && String(existing).trim() !== '') {
        return String(existing).slice(0, 10);
    }
    return null;
}

function mergeIncomingExternalInvoice(
    existing: ExternalInvoice,
    incoming: Partial<ExternalInvoice>
): ExternalInvoice {
    const merged = Object.assign({}, existing, incoming, {
        id: existing.id,
        username: existing.username,
        fullName: String(incoming.fullName ?? existing.fullName ?? '').trim() || existing.fullName,
        email: String(incoming.email ?? existing.email ?? '').trim() || existing.email || '',
        phoneNumber: String(incoming.phoneNumber ?? existing.phoneNumber ?? '').trim() || existing.phoneNumber || '',
        address: mergeOptionalAddress(existing.address, incoming.address),
        payDueDate: mergeOptionalPayDueDate(existing.payDueDate, incoming.payDueDate),
        billingMonth: normalizeBillingMonthKey((incoming.billingMonth as string) ?? existing.billingMonth),
        provider: String(incoming.provider ?? existing.provider ?? '').trim() || existing.provider,
        debitLabel: normalizeDebitLabel(incoming.debitLabel ?? existing.debitLabel) || '',
        modifiedAt: new Date(),
        lastAction: incoming.lastAction || 'IMPORT_UPSERT',
    });

    if (existing.status === 'paid' && incoming.status !== 'paid') {
        merged.status = existing.status;
        merged.paidAt = existing.paidAt;
        merged.paymentMethod = existing.paymentMethod;
        merged.collectedBy = existing.collectedBy;
        merged.collectedAt = existing.collectedAt;
    }

    if (incoming.amount != null && Number.isFinite(Number(incoming.amount))) {
        const tax = applyInvoiceTaxFields(Number(incoming.amount), {
            taxRate: (incoming as any).taxRate ?? existing.taxRate,
        });
        merged.amount = tax.amount;
        merged.subtotalAmount = tax.subtotalAmount;
        merged.taxRate = tax.taxRate;
        merged.taxAmount = tax.taxAmount;
        merged.totalAmount = tax.totalAmount;
    }

    return merged;
}

export async function enrichExternalInvoicesFromUserDetails(
    invoices: Partial<ExternalInvoice>[]
): Promise<number> {
    const usernames = [
        ...new Set(invoices.map((i) => String(i.username || '').trim()).filter(Boolean)),
    ];
    if (usernames.length === 0) return 0;

    const repo = AppDataSource.getRepository(UserDetails);
    const rows = await repo.find({ where: { username: In(usernames) } });
    const map = new Map(rows.map((r) => [r.username, r]));
    let enriched = 0;

    for (const inv of invoices) {
        const ud = map.get(String(inv.username || '').trim());
        if (!ud) continue;
        let touched = false;

        if (!String(inv.address ?? '').trim() && ud.address?.trim()) {
            inv.address = ud.address.trim();
            touched = true;
        }
        if (!String(inv.fullName ?? '').trim() && ud.fullName?.trim()) {
            inv.fullName = ud.fullName.trim();
            touched = true;
        }
        if (!String(inv.email ?? '').trim() && ud.email?.trim()) {
            inv.email = ud.email.trim();
            touched = true;
        }
        if (!String(inv.phoneNumber ?? '').trim() && ud.phoneNumber?.trim()) {
            inv.phoneNumber = ud.phoneNumber.trim();
            touched = true;
        }
        if (touched) enriched++;
    }

    return enriched;
}

export function applyDefaultPayDueDates(
    invoices: Partial<ExternalInvoice>[],
    dayOffset: number | null | undefined
): void {
    if (dayOffset === null || dayOffset === undefined || !Number.isFinite(dayOffset) || dayOffset < 0) {
        return;
    }
    const offset = Math.round(dayOffset);
    for (const inv of invoices) {
        if (inv.payDueDate !== undefined && inv.payDueDate !== null && String(inv.payDueDate).trim() !== '') {
            continue;
        }
        const bm = normalizeBillingMonthKey(inv.billingMonth as string);
        const base = new Date(`${bm}T12:00:00`);
        base.setDate(base.getDate() + offset);
        inv.payDueDate = base.toISOString().slice(0, 10);
    }
}

/** Upsert by username + billingMonth + provider; optionally soft-delete stale rows for imported billing months. */
export const upsertExternalInvoices = async (
    incoming: Partial<ExternalInvoice>[],
    options?: { scopedBillingMonths?: string[]; scopedProviders?: string[]; actorUsername?: string }
): Promise<UpsertExternalInvoicesResult> => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const current = await repo.find({ where: { deletedAt: IsNull() } });

    const existingByKey = new Map<string, ExternalInvoice>();
    for (const row of current) {
        existingByKey.set(externalInvoiceCompositeKey(row), row);
    }

    const incomingKeys = new Set<string>();
    let inserted = 0;
    let updated = 0;
    const toSave: ExternalInvoice[] = [];
    const queuedByKey = new Map<string, ExternalInvoice>();

    for (const item of incoming) {
        if (!String(item.username ?? '').trim()) continue;

        const key = externalInvoiceCompositeKey(item);

        // Same composite key appearing twice in one batch would violate uniqueness —
        // fold the later row into the queued record instead of inserting a duplicate.
        const queued = queuedByKey.get(key);
        if (queued) {
            const summed = Number(queued.amount ?? 0) + Number(item.amount ?? 0);
            const tax = applyInvoiceTaxFields(summed, { taxRate: (queued as any).taxRate });
            queued.amount = tax.amount;
            queued.subtotalAmount = tax.subtotalAmount;
            queued.taxRate = tax.taxRate;
            queued.taxAmount = tax.taxAmount;
            queued.totalAmount = tax.totalAmount;
            queued.payDueDate = latestDateString(queued.payDueDate, item.payDueDate as string | null);
            continue;
        }

        incomingKeys.add(key);
        const existing = existingByKey.get(key);

        let record: ExternalInvoice;
        if (existing) {
            record = mergeIncomingExternalInvoice(existing, item);
            updated++;
        } else {
            const tax = applyInvoiceTaxFields(Number(item.amount ?? 0), {
                taxRate: (item as any).taxRate,
            });
            record = {
                ...(item as ExternalInvoice),
                billingMonth: normalizeBillingMonthKey(item.billingMonth as string),
                email: item.email || '',
                phoneNumber: item.phoneNumber || '',
                debitLabel: normalizeDebitLabel((item as ExternalInvoice).debitLabel) || '',
                lastAction: item.lastAction || 'IMPORT_INSERT',
                amount: tax.amount,
                subtotalAmount: tax.subtotalAmount,
                taxRate: tax.taxRate,
                taxAmount: tax.taxAmount,
                totalAmount: tax.totalAmount,
                documentType: (item as any).documentType || 'invoice',
            };
            inserted++;
        }
        toSave.push(record);
        queuedByKey.set(key, record);
    }

    if (toSave.length > 0) {
        await repo.save(toSave);
    }

    let removedFromScope = 0;
    const scopedMonths = (options?.scopedBillingMonths ?? []).map((m) => normalizeBillingMonthKey(m));
    const scopedProviders = (options?.scopedProviders ?? [])
        .map((provider) => String(provider).trim().toLowerCase())
        .filter(Boolean);
    if (scopedMonths.length > 0) {
        const actor = options?.actorUsername || 'system';
        const stale = current.filter((row) => {
            const bm = normalizeBillingMonthKey(row.billingMonth);
            if (!scopedMonths.includes(bm)) return false;
            if (scopedProviders.length > 0 && !scopedProviders.includes(String(row.provider ?? '').trim().toLowerCase())) {
                return false;
            }
            return !incomingKeys.has(externalInvoiceCompositeKey(row));
        });

        if (stale.length > 0) {
            for (const inv of stale) {
                inv.deletedBy = actor;
            }
            await repo.softRemove(stale);
            for (const inv of stale) {
                invoiceEvents.emitModification({
                    invoiceId: inv.id || -1,
                    username: actor,
                    action: 'DELETED',
                    timestamp: new Date(),
                });
            }
            removedFromScope = stale.length;
        }
    }

    return { inserted, updated, removedFromScope, enrichedFromUserDetails: 0 };
};

/** @deprecated Use upsertExternalInvoices — kept for backward compatibility. */
export const replaceExternalInvoices = async (incoming: Partial<ExternalInvoice>[]) => {
    const scopedBillingMonths = [
        ...new Set(incoming.map((i) => normalizeBillingMonthKey(i.billingMonth as string))),
    ];
    const result = await upsertExternalInvoices(incoming, { scopedBillingMonths });
    return result;
};

export const bulkUpdateExternalInvoices = async (
    invoiceIds: number[],
    updateData: Partial<Pick<ExternalInvoice, 'payDueDate' | 'address'>>,
    actorUsername: string
) => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const uniqueIds = Array.from(new Set(invoiceIds))
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0);

    if (uniqueIds.length === 0) {
        return { updatedIds: [] as number[], failed: [] as Array<{ id: number; reason: string }> };
    }

    const invoices = await repo.find({ where: { id: In(uniqueIds) as any, deletedAt: IsNull() } });
    const foundIds = new Set(invoices.map((i) => i.id).filter(Boolean) as number[]);
    const failed: Array<{ id: number; reason: string }> = [];

    for (const id of uniqueIds) {
        if (!foundIds.has(id)) {
            failed.push({ id, reason: 'Invoice not found' });
        }
    }

    for (const inv of invoices) {
        if (updateData.address !== undefined) {
            const trimmed = updateData.address === null ? '' : String(updateData.address).trim();
            inv.address = trimmed.length > 0 ? trimmed : null;
        }
        if (updateData.payDueDate !== undefined) {
            inv.payDueDate =
                updateData.payDueDate === null || String(updateData.payDueDate).trim() === ''
                    ? null
                    : String(updateData.payDueDate).slice(0, 10);
        }
        inv.modifiedBy = actorUsername;
        inv.modifiedAt = new Date();
        inv.lastAction = 'BULK_UPDATE';
    }

    if (invoices.length > 0) {
        await repo.save(invoices);
    }

    return {
        updatedIds: invoices.map((i) => i.id).filter(Boolean) as number[],
        failed,
    };
};

export const getExternalInvoicePaymentLines = async (
    username: string,
    billingMonth: string,
    provider?: string
) => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const bm = normalizeBillingMonthKey(billingMonth);
    const qb = repo
        .createQueryBuilder('e')
        .where('e.deletedAt IS NULL')
        .andWhere('e.username = :username', { username: String(username).trim() })
        .andWhere('e.billingMonth = :billingMonth', { billingMonth: bm })
        .orderBy('e.debitLabel', 'ASC')
        .addOrderBy('e.id', 'ASC');

    if (provider && String(provider).trim()) {
        qb.andWhere('e.provider = :provider', { provider: String(provider).trim() });
    }

    return qb.getMany();
};

export const createExternalInvoiceDebit = async (input: {
    sourceInvoiceId?: number;
    username?: string;
    billingMonth?: string;
    provider?: string;
    debitLabel: string;
    amount: number;
    payDueDate?: string | null;
    status?: string;
    actorUsername: string;
}) => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const label = normalizeDebitLabel(input.debitLabel);
    if (!label) {
        throw new Error('debitLabel is required (e.g. carryover, second-payment)');
    }
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw new Error('amount must be greater than 0');
    }

    let seed: Partial<ExternalInvoice> = {};
    if (input.sourceInvoiceId) {
        const source = await repo.findOne({ where: { id: input.sourceInvoiceId, deletedAt: IsNull() } });
        if (!source) throw new Error('Source invoice not found');
        seed = source;
    }

    const username = String(input.username ?? seed.username ?? '').trim();
    const provider = String(input.provider ?? seed.provider ?? '').trim();
    const billingMonth = normalizeBillingMonthKey(
        (input.billingMonth as string) ?? (seed.billingMonth as string)
    );
    if (!username || !provider) {
        throw new Error('username and provider are required');
    }

    const composite = externalInvoiceCompositeKey({
        username,
        billingMonth,
        provider,
        debitLabel: label,
    } as ExternalInvoice);
    const existing = await repo.find({ where: { deletedAt: IsNull() } });
    const duplicate = existing.find((row) => externalInvoiceCompositeKey(row) === composite);
    if (duplicate) {
        throw new Error(`A payment line "${label}" already exists for this customer and billing month`);
    }

    let payDueDate: string | null =
        input.payDueDate !== undefined && input.payDueDate !== null && String(input.payDueDate).trim() !== ''
            ? String(input.payDueDate).slice(0, 10)
            : null;

    if (!payDueDate) {
        const stub: Partial<ExternalInvoice> = {
            username,
            provider,
            billingMonth,
            debitLabel: label,
        };
        inheritPayDueDatesFromPrior([stub], existing);
        payDueDate = stub.payDueDate ?? seed.payDueDate ?? null;
    }

    const tax = applyInvoiceTaxFields(input.amount, {
        taxRate: (seed as any).taxRate,
    });

    const invoice = repo.create({
        username,
        fullName: seed.fullName ?? '',
        email: seed.email ?? '',
        phoneNumber: seed.phoneNumber ?? '',
        address: seed.address ?? null,
        provider,
        billingMonth,
        debitLabel: label,
        amount: tax.amount,
        subtotalAmount: tax.subtotalAmount,
        taxRate: tax.taxRate,
        taxAmount: tax.taxAmount,
        totalAmount: tax.totalAmount,
        documentType: 'invoice',
        status: input.status || 'pending',
        payDueDate,
        modifiedBy: input.actorUsername,
        modifiedAt: new Date(),
        lastAction: 'DEBIT_ADDED',
    });

    const saved = await repo.save(invoice);
    invoiceEvents.emitModification({
        invoiceId: saved.id || -1,
        username: input.actorUsername,
        action: 'UPDATED',
        timestamp: new Date(),
        changes: { debitLabel: label, amount: input.amount, kind: 'DEBIT_ADDED' },
    });
    return saved;
};

export const getAllExternalInvoices = async (
    page = 1,
    limit = 10,
    search = "",
    from?: string,
    to?: string,
    status?: string,
    sortBy: 'createdAt' | 'billingMonth' | 'amount' = 'createdAt',
    sortDir: 'ASC' | 'DESC' = 'DESC',
    includeDeleted = false,
    ageBucket?: string,
    graceDays = 7,
    missingData?: string,
    payDueFilter?: string
) => {
    const externalInvoiceRepo = AppDataSource.getRepository(ExternalInvoice);

    const qb = externalInvoiceRepo.createQueryBuilder("externalInvoice")
        .orderBy(`externalInvoice.${sortBy}`, sortDir)
        .skip((page - 1) * limit)
        .take(limit);

    // Only include non-deleted records by default
    if (!includeDeleted) {
        qb.andWhere("externalInvoice.deletedAt IS NULL");
    }

    // Search conditions
    if (search) {
        qb.andWhere(
            "(externalInvoice.username LIKE :search OR externalInvoice.fullName LIKE :search OR externalInvoice.address LIKE :search OR externalInvoice.id = :id)",
            {
                search: `%${search}%`,
                id: isNaN(Number(search)) ? 0 : Number(search),
            }
        );
    }

    // Date range filter on billingMonth
    if (from && to) {
        qb.andWhere("externalInvoice.billingMonth BETWEEN :from AND :to", {
            from: from,
            to: to,
        });
    } else if (from) {
        qb.andWhere("externalInvoice.billingMonth >= :from", { from });
    } else if (to) {
        qb.andWhere("externalInvoice.billingMonth <= :to", { to });
    }

    // Status filter
    if (status && status !== 'all') {
        qb.andWhere("externalInvoice.status = :status", { status });
    }
    applyAgeBucketFilter(qb, 'externalInvoice', ageBucket, graceDays);
    applyMissingDataFilter(qb, 'externalInvoice', missingData);
    applyPayDueFilter(qb, 'externalInvoice', payDueFilter);

    // Fetch paginated results
    const [data, total] = await qb.getManyAndCount();

    // 🔢 Get Metrics (non-paginated query for totals)
    const baseQb = externalInvoiceRepo.createQueryBuilder("externalInvoice");

    if (!includeDeleted) {
        baseQb.andWhere("externalInvoice.deletedAt IS NULL");
    }

    if (search) {
        baseQb.andWhere(
            "(externalInvoice.username LIKE :search OR externalInvoice.fullName LIKE :search OR externalInvoice.address LIKE :search OR externalInvoice.id = :id)",
            {
                search: `%${search}%`,
                id: isNaN(Number(search)) ? 0 : Number(search),
            }
        );
    }

    if (from && to) {
        baseQb.andWhere("externalInvoice.billingMonth BETWEEN :from AND :to", {
            from: from,
            to: to,
        });
    } else if (from) {
        baseQb.andWhere("externalInvoice.billingMonth >= :from", { from });
    } else if (to) {
        baseQb.andWhere("externalInvoice.billingMonth <= :to", { to });
    }

    if (status && status !== 'all') {
        baseQb.andWhere("externalInvoice.status = :status", { status });
    }
    applyAgeBucketFilter(baseQb, 'externalInvoice', ageBucket, graceDays);
    applyMissingDataFilter(baseQb, 'externalInvoice', missingData);
    applyPayDueFilter(baseQb, 'externalInvoice', payDueFilter);

    // Keep voided credit notes visible in the list, but exclude them from all
    // financial metrics and document counts.
    const financialBaseQb = baseQb
        .clone()
        .andWhere("externalInvoice.voidedAt IS NULL");

    const totalFinancialInvoices = await financialBaseQb.clone().getCount();

    const totalPaid = await financialBaseQb
        .clone()
        .andWhere("externalInvoice.status = 'paid'")
        .getCount();

    const totalUnpaid = await financialBaseQb
        .clone()
        .andWhere("externalInvoice.status = 'unpaid'")
        .getCount();

    const totalPending = await financialBaseQb
        .clone()
        .andWhere("externalInvoice.status = 'pending'")
        .getCount();

    const totalAmount = await financialBaseQb
        .clone()
        .select("SUM(externalInvoice.amount)", "sum")
        .getRawOne<{ sum: string }>();

    return {
        data,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        metrics: {
            totalInvoices: totalFinancialInvoices,
            totalPaid,
            totalUnpaid,
            totalPending,
            totalAmount: parseFloat(totalAmount?.sum || "0"),
        },
    };
};

const computeOverdueDays = (billingMonth: string, graceDays: number, asOf = new Date()): number => {
    const date = new Date(billingMonth);
    if (Number.isNaN(date.getTime())) return 0;
    const dueDate = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    dueDate.setDate(dueDate.getDate() + Math.max(0, graceDays));
    dueDate.setHours(23, 59, 59, 999);
    const diff = Math.floor((asOf.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000));
    return diff;
};

const getBucketKey = (overdueDays: number): AgingBucket => {
    if (overdueDays <= 0) return 'current';
    if (overdueDays <= 30) return '1_30';
    if (overdueDays <= 60) return '31_60';
    if (overdueDays <= 90) return '61_90';
    return '90_plus';
};

export const getExternalInvoicesAgingSummary = async (params: {
    search?: string;
    from?: string;
    to?: string;
    status?: string;
    graceDays?: number;
}) => {
    const { search = '', from, to, status, graceDays = 7 } = params;
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const qb = repo.createQueryBuilder('externalInvoice')
        .where('externalInvoice.deletedAt IS NULL')
        .andWhere('externalInvoice.voidedAt IS NULL');

    if (search) {
        qb.andWhere(
            "(externalInvoice.username LIKE :search OR externalInvoice.fullName LIKE :search OR externalInvoice.address LIKE :search OR externalInvoice.id = :id)",
            {
                search: `%${search}%`,
                id: isNaN(Number(search)) ? 0 : Number(search),
            }
        );
    }

    if (from && to) {
        qb.andWhere('externalInvoice.billingMonth BETWEEN :from AND :to', { from, to });
    } else if (from) {
        qb.andWhere('externalInvoice.billingMonth >= :from', { from });
    } else if (to) {
        qb.andWhere('externalInvoice.billingMonth <= :to', { to });
    }

    if (status && status !== 'all') {
        qb.andWhere('externalInvoice.status = :status', { status });
    }

    const rows = await qb
        .select([
            'externalInvoice.id',
            'externalInvoice.username',
            'externalInvoice.fullName',
            'externalInvoice.amount',
            'externalInvoice.status',
            'externalInvoice.billingMonth',
        ])
        .getMany();

    const openRows = rows.filter((row) => ['unpaid', 'pending'].includes(String(row.status || '').toLowerCase()));
    const now = new Date();
    const bucketTotals: Record<AgingBucket, { count: number; amount: number }> = {
        current: { count: 0, amount: 0 },
        '1_30': { count: 0, amount: 0 },
        '31_60': { count: 0, amount: 0 },
        '61_90': { count: 0, amount: 0 },
        '90_plus': { count: 0, amount: 0 },
    };

    const overdueRows = openRows.map((row) => {
        const overdueDays = computeOverdueDays(String(row.billingMonth), graceDays, now);
        const amount = Number(row.amount || 0);
        const bucket = getBucketKey(overdueDays);
        bucketTotals[bucket].count += 1;
        bucketTotals[bucket].amount += amount;
        return {
            id: Number(row.id),
            username: String(row.username || ''),
            fullName: String(row.fullName || ''),
            overdueDays,
            amount,
        };
    });

    const overdueOnly = overdueRows.filter((row) => row.overdueDays > 0);
    const openAmount = overdueRows.reduce((acc, row) => acc + row.amount, 0);
    const overdueAmount = overdueOnly.reduce((acc, row) => acc + row.amount, 0);
    const avgDaysOverdue = overdueOnly.length
        ? overdueOnly.reduce((acc, row) => acc + row.overdueDays, 0) / overdueOnly.length
        : 0;

    const debtorMap = new Map<string, { username: string; fullName: string; amount: number; invoices: number; maxOverdueDays: number }>();
    for (const row of overdueOnly) {
        const key = `${row.username}::${row.fullName}`;
        const prev = debtorMap.get(key) || {
            username: row.username,
            fullName: row.fullName,
            amount: 0,
            invoices: 0,
            maxOverdueDays: 0,
        };
        prev.amount += row.amount;
        prev.invoices += 1;
        prev.maxOverdueDays = Math.max(prev.maxOverdueDays, row.overdueDays);
        debtorMap.set(key, prev);
    }

    const topDebtors = Array.from(debtorMap.values())
        .sort((a, b) => (b.amount - a.amount) || (b.maxOverdueDays - a.maxOverdueDays))
        .slice(0, 10);

    return {
        asOf: now.toISOString(),
        graceDays: Math.max(0, Number(graceDays) || 0),
        openInvoices: openRows.length,
        openAmount,
        overdueInvoices: overdueOnly.length,
        overdueAmount,
        overdueRatePercent: openAmount > 0 ? (overdueAmount / openAmount) * 100 : 0,
        avgDaysOverdue,
        buckets: [
            { key: 'current', label: 'Current', ...bucketTotals.current },
            { key: '1_30', label: '1-30', ...bucketTotals['1_30'] },
            { key: '31_60', label: '31-60', ...bucketTotals['31_60'] },
            { key: '61_90', label: '61-90', ...bucketTotals['61_90'] },
            { key: '90_plus', label: '90+', ...bucketTotals['90_plus'] },
        ],
        topDebtors,
    };
};

/** Monthly billing trend for the external invoices dashboard (last N billing months). */
export const getExternalInvoicesMonthlyTrend = async (months = 6) => {
    const safeMonths = Math.min(24, Math.max(1, Number(months) || 6));
    const repo = AppDataSource.getRepository(ExternalInvoice);

    const rows = (await repo
        .createQueryBuilder('e')
        .select("DATE_FORMAT(e.billingMonth, '%Y-%m')", 'month')
        .addSelect('COUNT(*)', 'totalCount')
        .addSelect("SUM(CASE WHEN e.status = 'paid' THEN 1 ELSE 0 END)", 'paidCount')
        .addSelect('COALESCE(SUM(e.amount), 0)', 'totalAmount')
        .addSelect("COALESCE(SUM(CASE WHEN e.status = 'paid' THEN e.amount ELSE 0 END), 0)", 'paidAmount')
        .where('e.deletedAt IS NULL')
        .andWhere('e.voidedAt IS NULL')
        .andWhere('e.billingMonth >= DATE_SUB(CURDATE(), INTERVAL :months MONTH)', { months: safeMonths })
        .groupBy("DATE_FORMAT(e.billingMonth, '%Y-%m')")
        .orderBy('month', 'ASC')
        .getRawMany()) as Array<{
            month: string;
            totalCount: string;
            paidCount: string;
            totalAmount: string;
            paidAmount: string;
        }>;

    return rows.map((row) => ({
        month: row.month,
        totalCount: Number(row.totalCount || 0),
        paidCount: Number(row.paidCount || 0),
        totalAmount: Number(row.totalAmount || 0),
        paidAmount: Number(row.paidAmount || 0),
    }));
};

/** Open external invoices that have a payment target date set (for tracker + reminders). */
export const getExternalInvoicesPaymentDueTracker = async (): Promise<ExternalInvoice[]> => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    return repo
        .createQueryBuilder('e')
        .where('e.deletedAt IS NULL')
        .andWhere('e.voidedAt IS NULL')
        .andWhere('e.payDueDate IS NOT NULL')
        .andWhere("e.status IN (:...st)", { st: ['unpaid', 'pending'] })
        .orderBy('e.payDueDate', 'ASC')
        .addOrderBy('e.id', 'ASC')
        .getMany();
};

export const getExternalInvoiceById = async (invoiceId: number): Promise<ExternalInvoice> => {
    const invoice = await AppDataSource.getRepository(ExternalInvoice).findOne({
        where: { id: invoiceId },
    });
    if (!invoice) {
        throw new Error('External invoice not found');
    }
    return invoice;
};

export const getExternalInvoiceHistory = async (invoiceId: number, limit = 100) => {
    const invoiceRepo = AppDataSource.getRepository(ExternalInvoice);
    const logRepo = AppDataSource.getRepository(ModificationLog);

    const invoice = await invoiceRepo.findOne({ where: { id: invoiceId }, withDeleted: true });
    if (!invoice) {
        throw new Error('External invoice not found');
    }

    const logs = await logRepo
        .createQueryBuilder('log')
        .leftJoin('log.invoice', 'invoice')
        .where('invoice.id = :invoiceId', { invoiceId })
        .orderBy('log.timestamp', 'DESC')
        .take(Math.min(500, Math.max(1, Number(limit) || 100)))
        .getMany();

    return logs.map((log) => ({
        id: log.id,
        action: log.action,
        username: log.username,
        timestamp: log.timestamp,
        changes: log.changes,
    }));
};

type WorkflowStage = 'new' | 'reminded' | 'promise_to_pay' | 'escalated' | 'resolved';

export const setExternalInvoiceWorkflow = async (params: {
    invoiceId: number;
    actor: string;
    stage: WorkflowStage;
    promiseDate?: string | null;
}) => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const invoice = await repo.findOne({ where: { id: params.invoiceId } });
    if (!invoice) {
        throw new Error('External invoice not found');
    }

    const allowedStages: WorkflowStage[] = ['new', 'reminded', 'promise_to_pay', 'escalated', 'resolved'];
    if (!allowedStages.includes(params.stage)) {
        throw new Error('Invalid workflow stage');
    }

    const promiseDate = params.promiseDate ? String(params.promiseDate).slice(0, 10) : null;
    const now = new Date();
    const marker =
        params.stage === 'promise_to_pay' && promiseDate
            ? `workflow:${params.stage}:promise:${promiseDate} by ${params.actor} @ ${now.toISOString()}`
            : `workflow:${params.stage} by ${params.actor} @ ${now.toISOString()}`;

    const previousLastAction = invoice.lastAction;
    invoice.lastAction = marker;
    invoice.modifiedBy = params.actor;
    invoice.modifiedAt = now;

    await repo.save(invoice);
    await invoiceEvents.emitModification({
        invoiceId: invoice.id || -1,
        username: params.actor,
        action: 'UPDATED',
        timestamp: now,
        changes: {
            workflowStage: { from: previousLastAction, to: marker },
            promiseDate: promiseDate ?? null,
        },
        data: { persistLastAction: marker },
    });

    return invoice;
};

export const updateExternalInvoice = async (invoiceId: number, updateData: Partial<ExternalInvoice>) => {
    const externalInvoiceRepo = AppDataSource.getRepository(ExternalInvoice);

    const invoice = await externalInvoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) {
        throw new Error('External invoice not found');
    }

    // Track changes
    const changes: Record<string, { from: any; to: any }> = {};
    for (const [key, value] of Object.entries(updateData)) {
        if (key in invoice && invoice[key as keyof ExternalInvoice] !== value) {
            changes[key] = {
                from: invoice[key as keyof ExternalInvoice],
                to: value
            };
        }
    }


    Object.assign(invoice, updateData);
    const updatedInvoice = await externalInvoiceRepo.save(invoice);

    // Emit modification event
    invoiceEvents.emitModification({
        invoiceId: invoice.id || -1,
        username: updateData.modifiedBy || 'system',
        action: 'UPDATED',
        timestamp: new Date(),
        changes
    });

    return updatedInvoice;
};

export const deleteExternalInvoice = async (invoiceId: number, username?: string) => {
    const externalInvoiceRepo = AppDataSource.getRepository(ExternalInvoice);

    const invoice = await externalInvoiceRepo.findOne({ where: { id: invoiceId } });
    if (!invoice) {
        throw new Error('External invoice not found');
    }

    // Set deletion info
    invoice.deletedBy = username || 'system';

    // Use TypeORM's soft delete
    await externalInvoiceRepo.softRemove(invoice);

    // Emit deletion event
    invoiceEvents.emitModification({
        invoiceId: invoice.id || -1,
        username: username || 'system',
        action: 'DELETED',
        timestamp: new Date()
    });

    return invoice;
};

export const bulkDeleteExternalInvoices = async (invoiceIds: number[], username?: string) => {
    const externalInvoiceRepo = AppDataSource.getRepository(ExternalInvoice);

    const uniqueIds = Array.from(new Set(invoiceIds))
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0);

    if (uniqueIds.length === 0) {
        return { deletedIds: [], failed: [] as Array<{ id: number; reason: string }> };
    }

    // Only non-deleted records will be returned by default; already-deleted IDs will be treated as "not found"
    const invoices = await externalInvoiceRepo.find({
        where: { id: In(uniqueIds) as any },
    });

    const foundIds = new Set(invoices.map((i) => i.id).filter(Boolean) as number[]);
    const failed: Array<{ id: number; reason: string }> = [];
    for (const id of uniqueIds) {
        if (!foundIds.has(id)) {
            failed.push({ id, reason: 'Invoice not found (or already deleted)' });
        }
    }

    // Soft-delete everything found and stamp deletedBy
    for (const inv of invoices) {
        inv.deletedBy = username || 'system';
    }

    if (invoices.length > 0) {
        await externalInvoiceRepo.softRemove(invoices);

        for (const inv of invoices) {
            invoiceEvents.emitModification({
                invoiceId: inv.id || -1,
                username: username || 'system',
                action: 'DELETED',
                timestamp: new Date(),
            });
        }
    }

    const deletedIds = invoices.map((i) => i.id).filter(Boolean) as number[];
    return { deletedIds, failed };
};


export const recoverExternalInvoice = async (invoiceId: number, username?: string) => {
    const externalInvoiceRepo = AppDataSource.getRepository(ExternalInvoice);

    const invoice = await externalInvoiceRepo.findOne({
        where: { id: invoiceId },
        withDeleted: true // Include soft-deleted records in search
    });

    if (!invoice) {
        throw new Error('External invoice not found');
    }

    if (!invoice.deletedAt) {
        throw new Error('Invoice is not deleted');
    }

    // Clear deletion info
    invoice.deletedAt = null;
    invoice.deletedBy = null;
    await externalInvoiceRepo.save(invoice);

    // Emit recovery event
    invoiceEvents.emitModification({
        invoiceId: invoice.id || -1,
        username: username || 'system',
        action: 'RECOVERED',
        timestamp: new Date()
    });

    return invoice;
};

// Collected metrics and drilldowns
export const getCollectedMetrics = async (dateFrom?: string, dateTo?: string) => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const qb = repo.createQueryBuilder('ext')
        .where('ext.collectedBy IS NOT NULL')
        .andWhere('ext.deletedAt IS NULL')
        .andWhere('ext.voidedAt IS NULL');

    if (dateFrom && dateTo) {
        if (isYmdOnly(dateFrom) && isYmdOnly(dateTo)) {
            qb.andWhere('ext.collectedAt >= :from AND ext.collectedAt < :to', {
                from: ymdToLocalDayStart(dateFrom),
                to: ymdToLocalNextDayStart(dateTo),
            });
        } else {
            qb.andWhere('ext.collectedAt BETWEEN :from AND :to', {
                from: parseRangeStart(dateFrom),
                to: parseRangeEnd(dateTo)
            });
        }
    } else if (dateFrom) {
        qb.andWhere('ext.collectedAt >= :from', { from: parseRangeStart(dateFrom) });
    } else if (dateTo) {
        if (isYmdOnly(dateTo)) {
            qb.andWhere('ext.collectedAt < :to', { to: ymdToLocalNextDayStart(dateTo) });
        } else {
            qb.andWhere('ext.collectedAt <= :to', { to: parseRangeEnd(dateTo) });
        }
    }

    const totalCollectedInvoices = await qb.clone().getCount();
    const { sum } = await qb.clone()
        .select('SUM(ext.amount)', 'sum')
        .getRawOne<{ sum: string }>() || { sum: '0' };

    return { totalCollectedInvoices, totalCashCollected: parseFloat(sum || '0') };
};

export const getCollectorBreakdown = async (dateFrom?: string, dateTo?: string) => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const qb = repo.createQueryBuilder('ext')
        .select('ext.collectedBy', 'collector')
        .addSelect('COUNT(*)', 'count')
        .addSelect('SUM(ext.amount)', 'totalAmount')
        .where('ext.collectedBy IS NOT NULL')
        .andWhere('ext.deletedAt IS NULL')
        .andWhere('ext.voidedAt IS NULL')
        .groupBy('ext.collectedBy')
        .orderBy('totalAmount', 'DESC');

    if (dateFrom && dateTo) {
        if (isYmdOnly(dateFrom) && isYmdOnly(dateTo)) {
            qb.andWhere('ext.collectedAt >= :from AND ext.collectedAt < :to', {
                from: ymdToLocalDayStart(dateFrom),
                to: ymdToLocalNextDayStart(dateTo),
            });
        } else {
            qb.andWhere('ext.collectedAt BETWEEN :from AND :to', {
                from: parseRangeStart(dateFrom),
                to: parseRangeEnd(dateTo)
            });
        }
    } else if (dateFrom) {
        qb.andWhere('ext.collectedAt >= :from', { from: parseRangeStart(dateFrom) });
    } else if (dateTo) {
        if (isYmdOnly(dateTo)) {
            qb.andWhere('ext.collectedAt < :to', { to: ymdToLocalNextDayStart(dateTo) });
        } else {
            qb.andWhere('ext.collectedAt <= :to', { to: parseRangeEnd(dateTo) });
        }
    }

    const rows = await qb.getRawMany<{ collector: string; count: string; totalAmount: string }>();
    return rows.map(r => ({
        collector: r.collector,
        count: parseInt(r.count, 10) || 0,
        totalAmount: parseFloat(r.totalAmount || '0')
    }));
};

export const getCollectedInvoicesList = async (
    page = 1,
    limit = 10,
    dateFrom?: string,
    dateTo?: string
) => {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const qb = repo.createQueryBuilder('ext')
        .where('ext.collectedBy IS NOT NULL')
        .andWhere('ext.deletedAt IS NULL')
        .andWhere('ext.voidedAt IS NULL')
        .orderBy('ext.collectedAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);

    if (dateFrom && dateTo) {
        if (isYmdOnly(dateFrom) && isYmdOnly(dateTo)) {
            qb.andWhere('ext.collectedAt >= :from AND ext.collectedAt < :to', {
                from: ymdToLocalDayStart(dateFrom),
                to: ymdToLocalNextDayStart(dateTo),
            });
        } else {
            qb.andWhere('ext.collectedAt BETWEEN :from AND :to', {
                from: parseRangeStart(dateFrom),
                to: parseRangeEnd(dateTo)
            });
        }
    } else if (dateFrom) {
        qb.andWhere('ext.collectedAt >= :from', { from: parseRangeStart(dateFrom) });
    } else if (dateTo) {
        if (isYmdOnly(dateTo)) {
            qb.andWhere('ext.collectedAt < :to', { to: ymdToLocalNextDayStart(dateTo) });
        } else {
            qb.andWhere('ext.collectedAt <= :to', { to: parseRangeEnd(dateTo) });
        }
    }

    const [data, total] = await qb.getManyAndCount();
    const totalAmount = data.reduce((acc, inv) => acc + (inv.amount || 0), 0);

    return {
        data,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        pageTotalAmount: totalAmount
    };
};
