// src/controllers/invoice.controller.ts
import { Request, Response } from "express";
import {
  bulkPayInvoices, generateMonthlyInvoices,
  getAllExternalInvoices, getAllInvoices,
  payInvoice, payExternalInvoice,
  upsertExternalInvoices,
  enrichExternalInvoicesFromUserDetails,
  applyDefaultPayDueDates,
  inheritPayDueDatesFromPrior,
  inheritCarryoverLinesFromPriorMonth,
  mergeDuplicateIncomingInvoices,
  normalizeBillingMonthKey,
  createExternalInvoiceDebit,
  getExternalInvoicePaymentLines,
  updateExternalInvoice,
  deleteExternalInvoice,
  bulkDeleteExternalInvoices,
  bulkUpdateExternalInvoices,
  collectInvoice,
  reconcileInvoiceCash,
  reconcileBulkCash,
  getCollectedMetrics,
  getCollectorBreakdown,
  getCollectedInvoicesList,
  unpayExternalInvoice,
  getExternalInvoicesAgingSummary,
  getExternalInvoiceHistory,
  setExternalInvoiceWorkflow,
  getExternalInvoicesPaymentDueTracker,
  getExternalInvoicesMonthlyTrend,
} from "../services/invoiceService";
import {
  buildImportPreview,
  cleanupImportFile,
  normalizeToMonthStart,
  parseColumnMappingInput,
  parseImportFileToInvoices,
  parseImportWorkbook,
  suggestColumnMapping,
} from "../services/externalInvoiceImportParser";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { invoiceEvents } from "../events/invoiceEvents";
import eventBus from "../bus/eventBusSingleton";
import { AppDataSource } from "../db/config";
import { IsNull } from "typeorm";
import { Invoices } from "../db/entities/Invoices";
import { UserDetails } from "../db/entities/UserDetails";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { composePaidMessage, sendWhatsAppMessage, sendWhatsAppMessageStrict, getWhatsAppConfigStatus, getTwilioCredentialDiagnostics, testTwilioCredentials, composeReminderMessage, buildReminderTemplateVariables, buildPaymentTemplateVariables } from "../services/whatsappService";

const sendResponse = (res: Response, success: boolean, status: number, message: string, data: any = null) => {
  res.status(status).json({ success, message, data });
};

type DunningCandidate = {
  id: number;
  username: string;
  fullName: string;
  phoneNumber: string;
  status: string;
  billingMonth: string;
  amount: number;
  overdueDays: number;
  dueDate: string;
};

type DunningAction = "remind" | "throttle" | "suspend";
type DunningStage = {
  day: number;
  action: DunningAction;
  name?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const parseIntOrDefault = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseStatuses = (value: unknown): string[] => {
  const raw = String(value ?? "").trim();
  if (!raw) return ["unpaid", "pending"];
  const allowed = new Set(["unpaid", "pending"]);
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => allowed.has(s));
};

const parseAsOfDate = (value: unknown): Date | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
};

const computeDunningDates = (billingMonth: Date, graceDays: number, asOfDate?: Date | null) => {
  const endOfMonth = new Date(billingMonth.getFullYear(), billingMonth.getMonth() + 1, 0);
  endOfMonth.setHours(0, 0, 0, 0);
  const dueDate = new Date(endOfMonth.getTime() + graceDays * DAY_MS);
  dueDate.setHours(23, 59, 59, 999);
  const now = asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate : new Date();
  const overdueDays = Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS);
  return { dueDate, overdueDays };
};

const buildReminderMessage = (invoice: DunningCandidate) =>
  composeReminderMessage({
    fullName: invoice.fullName,
    username: invoice.username,
    invoiceId: invoice.id,
    amount: invoice.amount,
    billingMonth: invoice.billingMonth,
    status: invoice.status,
  });

const defaultDunningStages = (): DunningStage[] => {
  const secondReminderDay = Math.max(0, parseIntOrDefault(process.env.DUNNING_SECOND_REMINDER_DAY, 3));
  const throttleDay = Math.max(0, parseIntOrDefault(process.env.DUNNING_THROTTLE_DAY, 7));
  const suspendDay = Math.max(0, parseIntOrDefault(process.env.DUNNING_SUSPEND_DAY, 14));
  return [
    { day: 0, action: "remind", name: "First Reminder" },
    { day: secondReminderDay, action: "remind", name: "Second Reminder" },
    { day: throttleDay, action: "throttle", name: "Throttle Service" },
    { day: suspendDay, action: "suspend", name: "Suspend Service" },
  ];
};

const parseDunningStages = (value: unknown): DunningStage[] => {
  const fallback = defaultDunningStages();
  let input = value;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      input = JSON.parse(value);
    } catch {
      input = null;
    }
  }
  if (!Array.isArray(input)) return fallback;
  const normalized = input
    .map((raw) => {
      const day = Math.max(0, parseIntOrDefault((raw as any)?.day, 0));
      const action = String((raw as any)?.action || "").toLowerCase();
      const name = String((raw as any)?.name || "").trim();
      if (!["remind", "throttle", "suspend"].includes(action)) return null;
      return { day, action: action as DunningAction, ...(name ? { name } : {}) };
    })
    .filter((x): x is DunningStage => Boolean(x));
  if (normalized.length === 0) return fallback;
  return normalized.sort((a, b) => a.day - b.day);
};

const parseSelectedActions = (value: unknown): DunningAction[] => {
  const all: DunningAction[] = ["remind", "throttle", "suspend"];
  if (value === undefined || value === null || String(value).trim() === "") return all;
  const rawParts = Array.isArray(value) ? value.map(String) : String(value).split(",");
  const allowed = new Set<DunningAction>(all);
  const parsed = rawParts
    .map((v) => String(v).trim().toLowerCase())
    .filter((v): v is DunningAction => allowed.has(v as DunningAction));
  return Array.from(new Set(parsed));
};

const detectInvoiceStage = (invoice: DunningCandidate, stages: DunningStage[]): DunningStage | null => {
  const eligible = stages.filter((s) => invoice.overdueDays >= s.day);
  if (eligible.length === 0) return null;
  return eligible[eligible.length - 1];
};

const stageKey = (stage: DunningStage) => `dunning_stage:${stage.day}:${stage.action}`;

const hasStageAlreadyApplied = (lastAction: string | null | undefined, stage: DunningStage): boolean => {
  const marker = stageKey(stage);
  return String(lastAction || "").includes(marker);
};

const applyDunningAction = async (params: {
  invoice: DunningCandidate;
  stage: DunningStage;
  actor: string;
  throttleProfileId?: number;
}): Promise<{ ok: boolean; reason?: string; status: "sent" | "skipped" | "failed" }> => {
  const repo = AppDataSource.getRepository(ExternalInvoice);
  const userRepo = AppDataSource.getRepository(Raduserprofile);

  const inv = await repo.findOne({ where: { id: params.invoice.id } });
  if (!inv) return { ok: false, status: "failed", reason: "Invoice not found" };
  if (hasStageAlreadyApplied(inv.lastAction, params.stage)) {
    return { ok: true, status: "skipped", reason: "Stage already applied" };
  }

  try {
    if (params.stage.action === "remind") {
      if (!params.invoice.phoneNumber) return { ok: true, status: "skipped", reason: "Missing phone number" };
      await sendWhatsAppMessageStrict({
        to: params.invoice.phoneNumber,
        message: buildReminderMessage(params.invoice),
        templateKind: "reminder",
        templateVariables: buildReminderTemplateVariables({
          fullName: params.invoice.fullName,
          username: params.invoice.username,
          invoiceId: params.invoice.id,
          amount: params.invoice.amount,
          billingMonth: params.invoice.billingMonth,
          status: params.invoice.status,
        }),
      });
    } else if (params.stage.action === "throttle") {
      const profileId = Number(params.throttleProfileId || 0);
      if (!Number.isFinite(profileId) || profileId <= 0) {
        return { ok: true, status: "skipped", reason: "Throttle profile not configured" };
      }
      await userRepo
        .createQueryBuilder()
        .update(Raduserprofile)
        .set({ profileId } as any)
        .where("username = :username", { username: params.invoice.username })
        .execute();
    } else if (params.stage.action === "suspend") {
      await userRepo
        .createQueryBuilder()
        .update(Raduserprofile)
        .set({ accountStatus: "suspended" } as any)
        .where("username = :username", { username: params.invoice.username })
        .execute();
    }

    await repo.update(
      { id: params.invoice.id },
      {
        lastAction: `${stageKey(params.stage)} by ${params.actor} @ ${new Date().toISOString()}`,
        ...(params.stage.action === "remind" ? { lastRemindedAt: new Date() } : {}),
      }
    );
    return { ok: true, status: "sent" };
  } catch (err: any) {
    return { ok: false, status: "failed", reason: String(err?.message || "Action failed") };
  }
};

const getDunningCandidates = async (params: {
  statuses: string[];
  graceDays: number;
  limit: number;
  minAmount: number;
  asOfDate?: Date | null;
}): Promise<DunningCandidate[]> => {
  const repo = AppDataSource.getRepository(ExternalInvoice);
  const statuses = params.statuses.length > 0 ? params.statuses : ["unpaid", "pending"];
  const rows = await repo
    .createQueryBuilder("ext")
    .where("ext.deletedAt IS NULL")
    .andWhere("ext.status IN (:...statuses)", { statuses })
    .orderBy("ext.billingMonth", "ASC")
    .take(Math.max(params.limit * 5, params.limit))
    .getMany();

  const filtered = rows
    .filter((inv) => !inv.deletedAt)
    .filter((inv) => Number(inv.amount || 0) >= params.minAmount)
    .map((inv) => {
      const billingMonth = new Date(inv.billingMonth as any);
      if (Number.isNaN(billingMonth.getTime())) return null;
      const { dueDate, overdueDays } = computeDunningDates(billingMonth, params.graceDays, params.asOfDate);
      // Immediate mode: when graceDays is 0, include unpaid/pending invoices right away.
      if (params.graceDays > 0 && overdueDays < 0) return null;
      return {
        id: Number(inv.id),
        username: String(inv.username || ""),
        fullName: String(inv.fullName || ""),
        phoneNumber: String(inv.phoneNumber || "").trim(),
        status: String(inv.status || "unpaid"),
        billingMonth: String(inv.billingMonth || ""),
        amount: Number(inv.amount || 0),
        overdueDays: Math.max(0, overdueDays),
        dueDate: dueDate.toISOString(),
      } as DunningCandidate;
    })
    .filter((x): x is DunningCandidate => Boolean(x))
    .sort((a, b) => (b.overdueDays - a.overdueDays) || (b.amount - a.amount));

  return filtered.slice(0, params.limit);
};

const executeExternalDunning = async (params: {
  actor: string;
  graceDays: number;
  maxCount: number;
  minAmount: number;
  dryRun: boolean;
  statuses: string[];
  asOfDate?: Date | null;
  stages: DunningStage[];
  selectedActions: DunningAction[];
  throttleProfileId?: number;
}) => {
  const candidates = await getDunningCandidates({
    statuses: params.statuses,
    graceDays: params.graceDays,
    limit: params.maxCount,
    minAmount: params.minAmount,
    asOfDate: params.asOfDate,
  });

  const result = {
    dryRun: params.dryRun,
    attempted: candidates.length,
    sent: 0,
    skippedNoPhone: 0,
    skippedAlreadyApplied: 0,
    failed: 0,
    actionSummary: {
      remind: 0,
      throttle: 0,
      suspend: 0,
      none: 0,
    },
    details: [] as Array<{
      id: number;
      status: "sent" | "skipped" | "failed";
      action?: DunningAction;
      stageDay?: number;
      reason?: string;
    }>,
  };

  if (params.dryRun) {
    const preview = candidates.map((invoice) => {
      const stage = detectInvoiceStage(invoice, params.stages);
      const effectiveStage = stage && params.selectedActions.includes(stage.action) ? stage : null;
      return {
        ...invoice,
        stage: effectiveStage,
      };
    });
    for (const row of preview) {
      if (!row.stage) {
        result.actionSummary.none += 1;
        continue;
      }
      result.actionSummary[row.stage.action] += 1;
      if (row.stage.action === "remind" && !row.phoneNumber) result.skippedNoPhone += 1;
    }
    return { ...result, preview };
  }

  const repo = AppDataSource.getRepository(ExternalInvoice);
  for (const invoice of candidates) {
    const stage = detectInvoiceStage(invoice, params.stages);
    if (!stage) {
      result.actionSummary.none += 1;
      result.details.push({ id: invoice.id, status: "skipped", reason: "No eligible stage" });
      continue;
    }
    if (!params.selectedActions.includes(stage.action)) {
      result.actionSummary.none += 1;
      result.details.push({ id: invoice.id, status: "skipped", action: stage.action, stageDay: stage.day, reason: "Action filtered out" });
      continue;
    }
    result.actionSummary[stage.action] += 1;

    const latest = await repo.findOne({ where: { id: invoice.id } });
    if (hasStageAlreadyApplied(latest?.lastAction, stage)) {
      result.skippedAlreadyApplied += 1;
      result.details.push({ id: invoice.id, status: "skipped", action: stage.action, stageDay: stage.day, reason: "Stage already applied" });
      continue;
    }

    const action = await applyDunningAction({
      invoice,
      stage,
      actor: params.actor,
      throttleProfileId: params.throttleProfileId,
    });
    if (action.status === "sent") result.sent += 1;
    else if (action.status === "failed") result.failed += 1;
    else if (action.reason === "Missing phone number") result.skippedNoPhone += 1;
    result.details.push({
      id: invoice.id,
      status: action.status,
      action: stage.action,
      stageDay: stage.day,
      reason: action.reason,
    });
  }

  return result;
};


export const generateInvoicesHandler = async (_: Request, res: Response) => {
  try {
    await generateMonthlyInvoices();
    sendResponse(res, true, 200, "Invoices generated successfully");
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Invoice generation failed" });
  }
};

export const getInvoicesHandler = async (_req: Request, res: Response) => {
  try {
    const page = parseInt(_req.query.page as string) || 1;
    const limit = parseInt(_req.query.limit as string) || 10;
    const search = (_req.query.search as string) || '';
    const dateFrom = _req.query.dateFrom as string;
    const dateTo = _req.query.dateTo as string;

    const result = await getAllInvoices(page, limit, search, dateFrom, dateTo);
    sendResponse(res, true, 200, "Invoices fetched successfully", result);
  } catch (err) {
    console.error("Error fetching invoices:", err);
    res.status(500).json({ message: "Failed to fetch invoices" });
  }
};

export const payInvoiceHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }

    const invoice = await payInvoice(invoiceId);
    
    // Emit modification event
    await invoiceEvents.emitModification({
      invoiceId: invoice.id || -1,
      username: req.user?.username || 'system',
      action: 'PAID',
      timestamp: new Date(),
    });

    sendResponse(res, true, 200, "Invoice paid successfully", invoice);

    // Fire-and-forget WhatsApp notification (does not block response)
    ;(async () => {
      try {
        const repo = AppDataSource.getRepository(Invoices);
        const inv = await repo.findOne({
          where: { id: invoiceId },
          relations: ["userDetails", "userProfile"],
        });
        const user = inv?.userDetails as UserDetails | undefined;
        const phone = user?.phoneNumber || undefined;
        if (!phone) return;
        const message = composePaidMessage({
          fullName: user?.fullName,
          username: user?.username,
          amount: inv?.amount,
          invoiceId,
        });
        await sendWhatsAppMessage({
          to: phone,
          message,
          templateKind: "payment",
          templateVariables: buildPaymentTemplateVariables({
            fullName: user?.fullName,
            username: user?.username,
            invoiceId,
            amount: inv?.amount,
          }),
        });
      } catch (err) {
        console.warn("Failed to send WhatsApp for internal invoice", err);
      }
    })();
  } catch (error) {
    console.error("Error paying invoice:", error);
    res.status(500).json({ message: "Failed to pay invoice" });
  }
};

export const bulkPayInvoicesHandler = async (req: Request, res: Response) => {
  try {
    const invoiceIds = req.body.invoiceIds;
    if (!Array.isArray(invoiceIds) || invoiceIds.some(isNaN)) {
      return sendResponse(res, false, 400, "Invalid invoice IDs");
    }

    const invoices = await bulkPayInvoices(invoiceIds);
    sendResponse(res, true, 200, "Invoices paid successfully", invoices);
  } catch (error) {
    console.error("Error paying invoices:", error);
    res.status(500).json({ message: "Failed to pay invoices" });
  }
};

export const collectInvoiceHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }
    const paymentMethod = (req.body?.paymentMethod || 'cash') as 'cash' | 'pos' | 'transfer' | 'other' | 'gateway';
    const username = req.user?.username || 'system';

    const invoice = await collectInvoice(invoiceId, username, paymentMethod);

    await invoiceEvents.emitModification({
      invoiceId: invoice.id || -1,
      username,
      action: 'COLLECTED',
      timestamp: new Date(),
      data: { paymentMethod }
    });

    sendResponse(res, true, 200, "Invoice collected and marked as paid", invoice);
  } catch (error) {
    console.error("Error collecting invoice:", error);
    res.status(500).json({ message: "Failed to collect invoice" });
  }
};

export const reconcileInvoiceCashHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }
    const username = req.user?.username || 'system';
    const role = req.user?.role as any;

    const invoice = await reconcileInvoiceCash(invoiceId, username, role);

    await invoiceEvents.emitModification({
      invoiceId: invoice.id || -1,
      username,
      action: 'RECONCILED',
      timestamp: new Date(),
    });

    sendResponse(res, true, 200, "Invoice cash reconciled", invoice);
  } catch (error) {
    console.error("Error reconciling invoice:", error);
    const message = (error as any)?.message || "Failed to reconcile invoice";
    if (message === 'Forbidden') return sendResponse(res, false, 403, "Forbidden");
    if (message.startsWith('Invalid') || message.startsWith('Only') || message.startsWith('Invoice is')) {
      return sendResponse(res, false, 400, message);
    }
    res.status(500).json({ message: "Failed to reconcile invoice" });
  }
};

export const reconcileBulkCashHandler = async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, collector } = (req.body || {}) as {
      dateFrom?: string;
      dateTo?: string;
      collector?: string;
    };

    if (!dateFrom || !dateTo) {
      return sendResponse(res, false, 400, "dateFrom and dateTo are required");
    }

    const actorUsername = req.user?.username || 'system';
    const role = req.user?.role as any;

    const effectiveCollector =
      role === 'collector' ? actorUsername : (collector || undefined);

    const result = await reconcileBulkCash({
      dateFrom,
      dateTo,
      collector: effectiveCollector,
      actorUsername,
    });

    for (const id of result.reconciledIds) {
      invoiceEvents.emitModification({
        invoiceId: id,
        username: actorUsername,
        action: 'RECONCILED',
        timestamp: new Date(),
        data: { bulk: true },
      });
    }

    sendResponse(res, true, 200, "Bulk cash reconciliation completed", result);
  } catch (error) {
    console.error("Error bulk reconciling cash:", error);
    const message = (error as any)?.message || "Failed to bulk reconcile cash";
    if (message.startsWith('Invalid') || message.startsWith('dateFrom')) {
      return sendResponse(res, false, 400, message);
    }
    res.status(500).json({ message: "Failed to bulk reconcile cash" });
  }
};

export const getCollectedMetricsHandler = async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };
    const metrics = await getCollectedMetrics(dateFrom, dateTo);
    sendResponse(res, true, 200, "Collected metrics fetched", metrics);
  } catch (error) {
    console.error("Error fetching collected metrics:", error);
    res.status(500).json({ message: "Failed to fetch collected metrics" });
  }
};

export const getCollectorBreakdownHandler = async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };
    const breakdown = await getCollectorBreakdown(dateFrom, dateTo);
    sendResponse(res, true, 200, "Collector breakdown fetched", breakdown);
  } catch (error) {
    console.error("Error fetching collector breakdown:", error);
    res.status(500).json({ message: "Failed to fetch collector breakdown" });
  }
};

export const getCollectedInvoicesListHandler = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };
    const list = await getCollectedInvoicesList(page, limit, dateFrom, dateTo);
    sendResponse(res, true, 200, "Collected invoices fetched", list);
  } catch (error) {
    console.error("Error fetching collected invoices list:", error);
    res.status(500).json({ message: "Failed to fetch collected invoices list" });
  }
};

export const previewExternalInvoiceFile = async (req: Request, res: Response) => {
  const filePath = req.file?.path || '';
  try {
    if (!filePath) {
      res.status(400).json({ success: false, message: 'File not found' });
      return;
    }

    const requestedMonth = (req.body?.billingMonth as string) || (req.query?.billingMonth as string) || '';
    const monthOverride = normalizeToMonthStart(requestedMonth) || null;
    const mapping = parseColumnMappingInput(req.body?.columnMapping);

    const parsed = parseImportWorkbook(filePath);
    const preview = buildImportPreview(parsed, {
      mapping: mapping ?? suggestColumnMapping(parsed.headers),
      monthOverride,
      previewLimit: 10,
    });

    cleanupImportFile(filePath);
    res.status(200).json({ success: true, data: preview });
  } catch (err) {
    console.error('Import preview error:', err);
    cleanupImportFile(filePath);
    res.status(500).json({ success: false, message: 'Failed to preview invoice file' });
  }
};

export const uploadExternalInvoiceFile = async (req: Request, res: Response) => {
  const filePath = req.file?.path || '';
  try {
    if (!filePath) {
      res.status(400).json({ success: false, message: 'File not found' });
      return;
    }

    const requestedMonth = (req.body?.billingMonth as string) || (req.query?.billingMonth as string) || '';
    const monthOverride = normalizeToMonthStart(requestedMonth) || null;
    const columnMapping = parseColumnMappingInput(req.body?.columnMapping);

    const { invoices: parsedInvoices, skippedCount } = parseImportFileToInvoices(filePath, {
      mapping: columnMapping,
      monthOverride,
      actorUsername: req.user?.username,
    });

    if (skippedCount > 0) {
      console.log(`Import skipped ${skippedCount} row(s) (missing username or filtered)`);
    }

    // Merge rows describing the same invoice (same username + full name + month + provider + line)
    const { invoices: filteredInvoices, merged: mergedDuplicates } = mergeDuplicateIncomingInvoices(parsedInvoices);
    if (mergedDuplicates > 0) {
      console.log(`Import merged ${mergedDuplicates} duplicate row(s) into existing records`);
    }

    const enrichedFromUserDetails = await enrichExternalInvoicesFromUserDetails(filteredInvoices);

    const repo = AppDataSource.getRepository(ExternalInvoice);
    const currentRows = await repo.find({ where: { deletedAt: IsNull() } });

    const { invoices: withCarryover, added: inheritedCarryoverLines } = inheritCarryoverLinesFromPriorMonth(
      filteredInvoices,
      currentRows
    );

    const inheritedPayDueDates = inheritPayDueDatesFromPrior(withCarryover, currentRows, {
      overrideIncoming: true,
    });

    const payDueDayOffsetRaw = req.body?.payDueDayOffset;
    if (payDueDayOffsetRaw !== undefined && payDueDayOffsetRaw !== null && String(payDueDayOffsetRaw).trim() !== '') {
      const payDueDayOffset = parseInt(String(payDueDayOffsetRaw), 10);
      if (Number.isFinite(payDueDayOffset) && payDueDayOffset >= 0) {
        applyDefaultPayDueDates(withCarryover, payDueDayOffset);
      }
    }

    const scopedBillingMonths = monthOverride
      ? [monthOverride]
      : [...new Set(withCarryover.map((i) => normalizeBillingMonthKey(i.billingMonth as string)))];

    const upsertResult = await upsertExternalInvoices(withCarryover, {
      scopedBillingMonths,
      actorUsername: req.user?.username,
    });
    upsertResult.enrichedFromUserDetails = enrichedFromUserDetails;
    upsertResult.inheritedPayDueDates = inheritedPayDueDates;
    upsertResult.inheritedCarryoverLines = inheritedCarryoverLines;
    upsertResult.mergedDuplicates = mergedDuplicates;
    cleanupImportFile(filePath);
    res.status(200).json({
      success: true,
      message: 'Invoices uploaded successfully',
      data: { ...upsertResult, skippedRows: skippedCount },
    });
  } catch (err) {
    console.error('Upload error:', err);
    cleanupImportFile(filePath);
    res.status(500).json({ success: false, message: 'Failed to upload invoice file' });
  }
};

// ... existing code ...

export const deleteExternalInvoiceHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }

    const invoice = await deleteExternalInvoice(invoiceId, req.user?.username);
    sendResponse(res, true, 200, "External invoice deleted successfully", invoice);
  } catch (error) {
    console.error("Error deleting external invoice:", error);
    res.status(500).json({ message: "Failed to delete external invoice" });
  }
};

export const bulkDeleteExternalInvoicesHandler = async (req: Request, res: Response) => {
  try {
    const invoiceIds = req.body?.invoiceIds;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return sendResponse(res, false, 400, "invoiceIds must be a non-empty array");
    }

    const result = await bulkDeleteExternalInvoices(invoiceIds, req.user?.username);
    sendResponse(res, true, 200, "External invoices deleted successfully", result);
  } catch (error) {
    console.error("Error bulk deleting external invoices:", error);
    res.status(500).json({ message: "Failed to delete external invoices" });
  }
};

export const bulkUpdateExternalInvoicesHandler = async (req: Request, res: Response) => {
  try {
    const invoiceIds = req.body?.invoiceIds;
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return sendResponse(res, false, 400, "invoiceIds must be a non-empty array");
    }

    const { payDueDate, address } = req.body ?? {};
    if (payDueDate === undefined && address === undefined) {
      return sendResponse(res, false, 400, "Provide payDueDate and/or address to update");
    }

    const updateData: Partial<Pick<ExternalInvoice, 'payDueDate' | 'address'>> = {};
    if (payDueDate !== undefined) {
      updateData.payDueDate =
        payDueDate === null || String(payDueDate).trim() === '' ? null : String(payDueDate).slice(0, 10);
    }
    if (address !== undefined) {
      updateData.address = address === null ? null : String(address);
    }

    const result = await bulkUpdateExternalInvoices(invoiceIds, updateData, req.user?.username || 'system');
    sendResponse(res, true, 200, "External invoices updated successfully", result);
  } catch (error) {
    console.error("Error bulk updating external invoices:", error);
    res.status(500).json({ message: "Failed to bulk update external invoices" });
  }
};

export const getExternalInvoicePaymentLinesHandler = async (req: Request, res: Response) => {
  try {
    const username = String(req.query.username || '').trim();
    const billingMonth = String(req.query.billingMonth || '').trim();
    const provider = String(req.query.provider || '').trim() || undefined;
    if (!username || !billingMonth) {
      return sendResponse(res, false, 400, "username and billingMonth are required");
    }
    const lines = await getExternalInvoicePaymentLines(username, billingMonth, provider);
    sendResponse(res, true, 200, "Payment lines fetched", lines);
  } catch (error) {
    console.error("Error fetching payment lines:", error);
    res.status(500).json({ message: "Failed to fetch payment lines" });
  }
};

export const createExternalInvoiceDebitHandler = async (req: Request, res: Response) => {
  try {
    const { sourceInvoiceId, username, billingMonth, provider, debitLabel, amount, payDueDate, status } = req.body ?? {};
    const invoice = await createExternalInvoiceDebit({
      sourceInvoiceId: sourceInvoiceId ? parseInt(String(sourceInvoiceId), 10) : undefined,
      username,
      billingMonth,
      provider,
      debitLabel,
      amount: parseFloat(String(amount)),
      payDueDate,
      status,
      actorUsername: req.user?.username || 'system',
    });
    sendResponse(res, true, 201, "Payment line created", invoice);
  } catch (error: any) {
    console.error("Error creating payment line:", error);
    sendResponse(res, false, 400, error?.message || "Failed to create payment line");
  }
};

export const getExternalInvoicesHandler = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const search = req.query.search as string || '';
    const from = (req.query.from as string) || undefined;
    const to = (req.query.to as string) || undefined;
    const status = (req.query.status as string) || undefined;
    const ageBucket = (req.query.ageBucket as string) || undefined;
    const graceDays = Math.max(0, parseIntOrDefault(req.query.graceDays, 7));
    const sortBy = (req.query.sortBy as 'createdAt' | 'billingMonth' | 'amount') || 'createdAt';
    const sortDir = ((req.query.sortDir as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC') as 'ASC' | 'DESC';
    const missingData = (req.query.missing as string) || undefined;
    const payDueFilter = (req.query.payDue as string) || undefined;

    const result = await getAllExternalInvoices(page, limit, search, from, to, status, sortBy, sortDir, false, ageBucket, graceDays, missingData, payDueFilter);
    sendResponse(res, true, 200, "External invoices fetched successfully", result);
  } catch (err) {
    console.error("Error fetching external invoices:", err);
    res.status(500).json({ message: "Failed to fetch external invoices" });
  }
};

export const getExternalInvoicesAgingSummaryHandler = async (req: Request, res: Response) => {
  try {
    const search = (req.query.search as string) || '';
    const from = (req.query.from as string) || undefined;
    const to = (req.query.to as string) || undefined;
    const status = (req.query.status as string) || undefined;
    const graceDays = Math.max(0, parseIntOrDefault(req.query.graceDays, 7));

    const result = await getExternalInvoicesAgingSummary({
      search,
      from,
      to,
      status,
      graceDays,
    });
    sendResponse(res, true, 200, "External invoice aging summary fetched", result);
  } catch (err) {
    console.error("Error fetching external invoice aging summary:", err);
    res.status(500).json({ message: "Failed to fetch aging summary" });
  }
};

export const getExternalInvoicesTrendHandler = async (req: Request, res: Response) => {
  try {
    const months = Math.min(24, Math.max(1, parseIntOrDefault(req.query.months, 6)));
    const result = await getExternalInvoicesMonthlyTrend(months);
    sendResponse(res, true, 200, "External invoice trend fetched", result);
  } catch (err) {
    console.error("Error fetching external invoice trend:", err);
    res.status(500).json({ message: "Failed to fetch invoice trend" });
  }
};

export const getExternalInvoicesPaymentDueHandler = async (req: Request, res: Response) => {
  try {
    const rows = await getExternalInvoicesPaymentDueTracker();
    sendResponse(res, true, 200, "Payment due tracker rows fetched", rows);
  } catch (err) {
    console.error("Error fetching payment due external invoices:", err);
    res.status(500).json({ message: "Failed to fetch payment due invoices" });
  }
};

export const getExternalInvoiceHistoryHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }
    const limit = Math.min(500, Math.max(1, parseIntOrDefault(req.query.limit, 100)));
    const history = await getExternalInvoiceHistory(invoiceId, limit);
    sendResponse(res, true, 200, "External invoice history fetched", history);
  } catch (error) {
    console.error("Error fetching external invoice history:", error);
    const message = (error as any)?.message || "Failed to fetch invoice history";
    if (message === 'External invoice not found') return sendResponse(res, false, 404, message);
    res.status(500).json({ message: "Failed to fetch invoice history" });
  }
};

export const setExternalInvoiceWorkflowHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId, 10);
    if (!Number.isFinite(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }

    const stage = String(req.body?.stage || "").trim().toLowerCase();
    const promiseDate = req.body?.promiseDate ? String(req.body.promiseDate).slice(0, 10) : null;
    const actor = req.user?.username || "system";

    const invoice = await setExternalInvoiceWorkflow({
      invoiceId,
      actor,
      stage: stage as any,
      promiseDate,
    });

    return sendResponse(res, true, 200, "External invoice workflow updated", invoice);
  } catch (error: any) {
    console.error("Error updating external invoice workflow:", error);
    const message = String(error?.message || "Failed to update workflow");
    if (message === 'External invoice not found') return sendResponse(res, false, 404, message);
    if (message === 'Invalid workflow stage') return sendResponse(res, false, 400, message);
    return sendResponse(res, false, 500, "Failed to update workflow");
  }
};

export const payExternalInvoiceHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }

    const paymentMethod = (req.body?.paymentMethod || 'cash') as 'cash' | 'pos' | 'transfer' | 'other' | 'gateway';
    const actor = req.user?.username || 'system';

    const invoice = await payExternalInvoice(invoiceId, actor, paymentMethod);

    // Emit modification event
    invoiceEvents.emitModification({
      invoiceId: invoice.id || -1,
      username: req.user?.username || 'system',
      action: 'PAID',
      timestamp: new Date(),
      data: invoice
    });

    sendResponse(res, true, 200, "Invoice paid successfully", invoice);

    // Fire-and-forget WhatsApp notification
    ;(async () => {
      try {
        //invoice.phoneNumber
        const phone = '+9613974338';
        if (!phone) {
          console.warn('External invoice has no phone number; skipping WhatsApp', { invoiceId: invoice.id, username: invoice.username });
          return;
        }
        console.log('sending whatsapp message to', phone);
        const message = composePaidMessage({
          fullName: invoice.fullName,
          username: invoice.username,
          amount: invoice.amount,
          invoiceId: invoice.id,
        });
        await sendWhatsAppMessage({
          to: phone,
          message,
          templateKind: "payment",
          templateVariables: buildPaymentTemplateVariables({
            fullName: invoice.fullName,
            username: invoice.username,
            invoiceId: invoice.id,
            amount: invoice.amount,
          }),
        });
      } catch (err) {
        console.warn("Failed to send WhatsApp for external invoice", err);
      }
    })();
  } catch (error) {
    console.error("Error paying invoice:", error);
    res.status(500).json({ message: "Failed to pay invoice" });
  }
};

export const unpayExternalInvoiceHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }

    const actor = req.user?.username || 'system';
    const invoice = await unpayExternalInvoice(invoiceId, actor);

    invoiceEvents.emitModification({
      invoiceId: invoice.id || -1,
      username: actor,
      action: 'UNPAID',
      timestamp: new Date(),
      data: invoice,
    });

    sendResponse(res, true, 200, "Invoice marked as unpaid", invoice);
  } catch (error) {
    console.error("Error unpaying external invoice:", error);
    const message = (error as any)?.message || "Failed to unpay invoice";
    if (message === 'Invoice not found') return sendResponse(res, false, 404, message);
    res.status(500).json({ message: "Failed to unpay invoice" });
  }
};

export const remindExternalInvoiceHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId, 10);
    if (!Number.isFinite(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }

    const repo = AppDataSource.getRepository(ExternalInvoice);
    const invoice = await repo.findOne({ where: { id: invoiceId } });
    if (!invoice) {
      return sendResponse(res, false, 404, "External invoice not found");
    }

    const phone = String(invoice.phoneNumber || "").trim();
    if (!phone) {
      return sendResponse(res, false, 400, "External invoice has no phone number");
    }
    // Guard against placeholder numbers used during import.
    // Allow bypass only when a test override is configured.
    if (phone === "9613000000" && String(process.env.WHATSAPP_OVERRIDE_TO || "").trim().length === 0) {
      return sendResponse(
        res,
        false,
        400,
        "External invoice phoneNumber is a placeholder (9613000000). Update the invoice phoneNumber or set WHATSAPP_OVERRIDE_TO for testing."
      );
    }

    const message = composeReminderMessage({
      fullName: invoice.fullName,
      username: invoice.username,
      invoiceId: invoice.id,
      amount: invoice.amount,
      billingMonth: invoice.billingMonth,
      status: invoice.status,
    });

    const result = await sendWhatsAppMessageStrict({
      to: phone,
      message,
      templateKind: "reminder",
      templateVariables: buildReminderTemplateVariables({
        fullName: invoice.fullName,
        username: invoice.username,
        invoiceId: invoice.id,
        amount: invoice.amount,
        billingMonth: invoice.billingMonth,
        status: invoice.status,
      }),
    });

    // Optional: mark last action (best-effort; don't fail reminder if update fails)
    try {
      await repo.update(
        { id: invoiceId },
        {
          lastAction: `reminded by ${req.user?.username || "system"} @ ${new Date().toISOString()}`,
          lastRemindedAt: new Date(),
        }
      );
    } catch {}
    try {
      await invoiceEvents.emitModification({
        invoiceId,
        username: req.user?.username || "system",
        action: "UPDATED",
        timestamp: new Date(),
        changes: { reminderSent: true },
        data: { persistLastAction: `reminded by ${req.user?.username || "system"} @ ${new Date().toISOString()}` },
      });
    } catch {}

    return sendResponse(res, true, 200, "Reminder sent", { ok: true, ...result });
  } catch (error: any) {
    console.error("Error sending external invoice reminder:", error);
    return sendResponse(res, false, 500, error?.message || "Failed to send reminder");
  }
};

export const getExternalDunningPreviewHandler = async (req: Request, res: Response) => {
  try {
    const graceDays = Math.max(0, parseIntOrDefault(req.query.graceDays, 7));
    const limit = Math.min(500, Math.max(1, parseIntOrDefault(req.query.limit, 100)));
    const minAmount = Math.max(0, Number(req.query.minAmount ?? 0) || 0);
    const statuses = parseStatuses(req.query.statuses);
    const asOfDate = parseAsOfDate(req.query.asOfDate);
    const stages = parseDunningStages(req.query.stages);
    const selectedActions = parseSelectedActions(req.query.selectedActions);

    const candidates = await getDunningCandidates({ statuses, graceDays, limit, minAmount, asOfDate });
    const withoutPhone = candidates.filter((c) => !c.phoneNumber).length;
    const readyToSend = candidates.length - withoutPhone;
    const totalAmount = candidates.reduce((acc, c) => acc + Number(c.amount || 0), 0);
    const actionSummary = {
      remind: 0,
      throttle: 0,
      suspend: 0,
      none: 0,
    };
    const withStage = candidates.map((c) => {
      const stage = detectInvoiceStage(c, stages);
      const effectiveStage = stage && selectedActions.includes(stage.action) ? stage : null;
      if (!effectiveStage) actionSummary.none += 1;
      else actionSummary[effectiveStage.action] += 1;
      return { ...c, stage: effectiveStage };
    });

    return sendResponse(res, true, 200, "Dunning preview generated", {
      graceDays,
      asOfDate: asOfDate ? asOfDate.toISOString() : null,
      statuses,
      stages,
      selectedActions,
      totalCandidates: candidates.length,
      readyToSend,
      missingPhone: withoutPhone,
      totalAmount,
      actionSummary,
      data: withStage,
    });
  } catch (error) {
    console.error("Error generating dunning preview:", error);
    return sendResponse(res, false, 500, "Failed to generate dunning preview");
  }
};

export const runExternalDunningHandler = async (req: Request, res: Response) => {
  try {
    const graceDays = Math.max(0, parseIntOrDefault(req.body?.graceDays, 7));
    const maxCount = Math.min(500, Math.max(1, parseIntOrDefault(req.body?.maxCount, 100)));
    const minAmount = Math.max(0, Number(req.body?.minAmount ?? 0) || 0);
    const dryRun = Boolean(req.body?.dryRun);
    const statuses = parseStatuses(req.body?.statuses);
    const asOfDate = parseAsOfDate(req.body?.asOfDate);
    const stages = parseDunningStages(req.body?.stages);
    const selectedActions = parseSelectedActions(req.body?.selectedActions);
    const throttleProfileId = parseIntOrDefault(req.body?.throttleProfileId, parseIntOrDefault(process.env.DUNNING_THROTTLE_PROFILE_ID, 0));
    const actor = req.user?.username || "system";

    const result = await executeExternalDunning({
      actor,
      graceDays,
      maxCount,
      minAmount,
      dryRun,
      statuses,
      asOfDate,
      stages,
      selectedActions,
      throttleProfileId: throttleProfileId > 0 ? throttleProfileId : undefined,
    });

    return sendResponse(res, true, 200, "Dunning run completed", result);
  } catch (error: any) {
    console.error("Error running dunning campaign:", error);
    return sendResponse(res, false, 500, error?.message || "Failed to run dunning campaign");
  }
};

export const runExternalDunningSystemJob = async () => {
  const graceDays = Math.max(0, parseIntOrDefault(process.env.DUNNING_GRACE_DAYS, 7));
  const maxCount = Math.min(500, Math.max(1, parseIntOrDefault(process.env.DUNNING_MAX_COUNT, 200)));
  const minAmount = Math.max(0, Number(process.env.DUNNING_MIN_AMOUNT ?? 0) || 0);
  const statuses = parseStatuses(process.env.DUNNING_STATUSES || "unpaid,pending");
  const stages = defaultDunningStages();
  const selectedActions = parseSelectedActions(process.env.DUNNING_SELECTED_ACTIONS || "");
  const throttleProfileId = parseIntOrDefault(process.env.DUNNING_THROTTLE_PROFILE_ID, 0);

  return executeExternalDunning({
    actor: "scheduler",
    graceDays,
    maxCount,
    minAmount,
    dryRun: false,
    statuses,
    stages,
    selectedActions,
    throttleProfileId: throttleProfileId > 0 ? throttleProfileId : undefined,
  });
};

export const updateExternalInvoiceHandler = async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    if (isNaN(invoiceId)) {
      return sendResponse(res, false, 400, "Invalid invoice ID");
    }

    const updateData = {
      ...req.body,
      modifiedBy: req.user?.username,
      modifiedAt: new Date()
    };
    const invoice = await updateExternalInvoice(invoiceId, updateData);
    sendResponse(res, true, 200, "External invoice updated successfully", invoice);
  } catch (error) {
    console.error("Error updating external invoice:", error);
    res.status(500).json({ message: "Failed to update external invoice" });
  }
};

/** Masked Twilio/WhatsApp env diagnostics for troubleshooting (no full secrets). */
export const getWhatsAppDiagnosticsHandler = async (_req: Request, res: Response) => {
  try {
    const config = getWhatsAppConfigStatus();
    const twilio = getTwilioCredentialDiagnostics();
    const authTest = config.enabled && config.provider === "twilio" ? await testTwilioCredentials() : null;
    return sendResponse(res, true, 200, "WhatsApp diagnostics", { config, twilio, authTest });
  } catch (error: any) {
    console.error("Error fetching WhatsApp diagnostics:", error);
    return sendResponse(res, false, 500, error?.message || "Failed to fetch WhatsApp diagnostics");
  }
};
