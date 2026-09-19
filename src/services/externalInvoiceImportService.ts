import { IsNull, Raw } from 'typeorm';
import { AppDataSource } from '../db/config';
import { ExternalInvoice } from '../db/entities/ExternalInvoice';
import type { ImportPreviewResult } from './externalInvoiceImportParser';
import {
  applyDefaultPayDueDates,
  enrichExternalInvoicesFromUserDetails,
  inheritCarryoverLinesFromPriorMonth,
  inheritPayDueDatesFromPrior,
  mergeDuplicateIncomingInvoices,
  normalizeBillingMonthKey,
  upsertExternalInvoices,
} from './invoiceService';

export type ExternalInvoiceImportPipelineOptions = {
  invoices: Partial<ExternalInvoice>[];
  skippedCount: number;
  monthOverride?: string | null;
  scopedProviders?: string[];
  payDueDayOffset?: unknown;
  overrideIncomingPayDueDates?: boolean;
  actorUsername?: string;
  /** When false, do not soft-delete provider rows missing from this batch (use for partial username imports). */
  reconcileScope?: boolean;
};

/** Parse username filter from API body: array, comma, newline, or semicolon separated. */
export function parseImportUsernameFilter(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  const chunks: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      chunks.push(...String(item).split(/[\n\r,;]+/));
    }
  } else {
    chunks.push(...String(raw).split(/[\n\r,;]+/));
  }
  const list = chunks.map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function filterInvoicesByUsernames(
  invoices: Partial<ExternalInvoice>[],
  usernames?: string[]
): Partial<ExternalInvoice>[] {
  if (!usernames?.length) return invoices;
  const allow = new Set(usernames.map((u) => u.trim().toLowerCase()).filter(Boolean));
  return invoices.filter((inv) => allow.has(String(inv.username ?? '').trim().toLowerCase()));
}

export function adjustPreviewForUsernameFilter(
  preview: ImportPreviewResult,
  sourceInvoiceCount: number,
  filtered: Partial<ExternalInvoice>[]
): ImportPreviewResult {
  if (filtered.length === sourceInvoiceCount) return preview;
  const excluded = sourceInvoiceCount - filtered.length;
  return {
    ...preview,
    totalRows: filtered.length,
    validRowCount: filtered.length,
    skippedRowCount: preview.skippedRowCount + excluded,
    mappedPreview: filtered.slice(0, 10),
  };
}

/**
 * Shared post-parse pipeline for every external invoice import source.
 * Keep source-specific parsing and validation outside this service.
 */
export async function importExternalInvoices(
  options: ExternalInvoiceImportPipelineOptions
) {
  const {
    invoices: parsedInvoices,
    skippedCount,
    monthOverride = null,
    scopedProviders,
    payDueDayOffset: payDueDayOffsetRaw,
    overrideIncomingPayDueDates = true,
    actorUsername,
    reconcileScope = true,
  } = options;

  if (skippedCount > 0) {
    console.log(`Import skipped ${skippedCount} row(s) (missing username or filtered)`);
  }

  const { invoices: filteredInvoices, merged: mergedDuplicates } =
    mergeDuplicateIncomingInvoices(parsedInvoices);
  if (mergedDuplicates > 0) {
    console.log(`Import merged ${mergedDuplicates} duplicate row(s) into existing records`);
  }

  const enrichedFromUserDetails =
    await enrichExternalInvoicesFromUserDetails(filteredInvoices);

  const repo = AppDataSource.getRepository(ExternalInvoice);

  // Both inheritance helpers below only ever match rows belonging to the
  // accounts present in this batch (they compare the username + provider pair),
  // so the lookup can be bounded by username instead of loading the whole
  // invoice table into memory on every import.
  const incomingUsernames = Array.from(
    new Set(
      filteredInvoices
        .map((inv) => String(inv.username ?? '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
  const currentRows = incomingUsernames.length
    ? await repo.find({
        where: {
          deletedAt: IsNull(),
          // Case-insensitive: account matching lowercases both sides of the pair.
          username: Raw((alias) => `LOWER(${alias}) IN (:...usernames)`, {
            usernames: incomingUsernames,
          }),
        },
      })
    : [];

  const { invoices: withCarryover, added: inheritedCarryoverLines } =
    inheritCarryoverLinesFromPriorMonth(filteredInvoices, currentRows);

  const inheritedPayDueDates = inheritPayDueDatesFromPrior(
    withCarryover,
    currentRows,
    { overrideIncoming: overrideIncomingPayDueDates }
  );

  if (
    payDueDayOffsetRaw !== undefined &&
    payDueDayOffsetRaw !== null &&
    String(payDueDayOffsetRaw).trim() !== ''
  ) {
    const payDueDayOffset = parseInt(String(payDueDayOffsetRaw), 10);
    if (Number.isFinite(payDueDayOffset) && payDueDayOffset >= 0) {
      applyDefaultPayDueDates(withCarryover, payDueDayOffset);
    }
  }

  const scopedBillingMonths =
    reconcileScope === false
      ? []
      : monthOverride
        ? [monthOverride]
        : [
            ...new Set(
              withCarryover.map((invoice) =>
                normalizeBillingMonthKey(invoice.billingMonth as string)
              )
            ),
          ];

  const upsertResult = await upsertExternalInvoices(withCarryover, {
    scopedBillingMonths,
    scopedProviders,
    actorUsername,
  });
  upsertResult.enrichedFromUserDetails = enrichedFromUserDetails;
  upsertResult.inheritedPayDueDates = inheritedPayDueDates;
  upsertResult.inheritedCarryoverLines = inheritedCarryoverLines;
  upsertResult.mergedDuplicates = mergedDuplicates;

  return { ...upsertResult, skippedRows: skippedCount };
}
