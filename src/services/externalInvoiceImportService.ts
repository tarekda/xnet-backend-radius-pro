import { IsNull } from 'typeorm';
import { AppDataSource } from '../db/config';
import { ExternalInvoice } from '../db/entities/ExternalInvoice';
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
};

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
  const currentRows = await repo.find({ where: { deletedAt: IsNull() } });

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

  const scopedBillingMonths = monthOverride
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
