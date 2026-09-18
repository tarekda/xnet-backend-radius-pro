import { NextFunction, Request, Response } from "express";
import { getReportDefinition, listReportDefinitions } from "../reports/reportRegistry";
import { reportFileName, reportToCsv, reportToXlsx } from "../reports/reportRenderer";
import type { ReportFormat } from "../reports/reportTypes";
import type { ReportSchedule } from "../db/entities/ReportSchedule";
import {
  createReportSchedule,
  deleteReportSchedule,
  getReportScheduleById,
  listReportSchedules,
  parseRecipients,
  runReportSchedule,
  updateReportSchedule,
  validateScheduleInput,
  type ReportScheduleInput,
} from "../services/reportScheduleService";
import {
  getNextReportScheduleRun,
  registerReportScheduleTask,
  unregisterReportScheduleTask,
} from "../jobs/reportScheduleJob";

const VALID_FORMATS: readonly ReportFormat[] = ["json", "csv", "xlsx"];

/* ── report catalog + generation (unchanged) ─────────────────────────────── */

/** `GET /api/reports` — the catalog of available reports and their parameters. */
export const listReportsHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    res.status(200).json({
      success: true,
      message: "Reports listed",
      data: listReportDefinitions(),
    });
  } catch (err) {
    next(err);
  }
};

/** `GET /api/reports/:key` — build a report and return it as json, csv, or xlsx. */
export const generateReportHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const key = String(req.params.key ?? "").trim();
    const definition = getReportDefinition(key);
    if (!definition) {
      res.status(404).json({ success: false, message: `Unknown report: ${key}`, data: null });
      return;
    }

    const format = String(req.query.format ?? "json").toLowerCase() as ReportFormat;
    if (!VALID_FORMATS.includes(format)) {
      res.status(400).json({
        success: false,
        message: `Unsupported format "${format}". Use one of: ${VALID_FORMATS.join(", ")}.`,
        data: null,
      });
      return;
    }

    // Only parameters declared by the definition are read, so the query string
    // cannot smuggle arbitrary values into the report builders.
    const params: Record<string, string> = {};
    for (const spec of definition.params) {
      const raw = req.query[spec.name];
      if (typeof raw === "string" && raw.trim() !== "") params[spec.name] = raw.trim();
    }

    const missing = definition.params.filter((spec) => spec.required && !params[spec.name]);
    if (missing.length > 0) {
      res.status(400).json({
        success: false,
        message: `Missing required parameter(s): ${missing.map((spec) => spec.name).join(", ")}`,
        data: null,
      });
      return;
    }

    const report = await definition.build(params);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${reportFileName(report, "csv")}"`
      );
      res.status(200).send(reportToCsv(report));
      return;
    }

    if (format === "xlsx") {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${reportFileName(report, "xlsx")}"`
      );
      res.status(200).send(reportToXlsx(report));
      return;
    }

    res.status(200).json({ success: true, message: "Report generated", data: report });
  } catch (err) {
    next(err);
  }
};

/* ── scheduled delivery ──────────────────────────────────────────────────── */

/** Never exposes internal columns beyond what the UI needs. */
function serializeSchedule(schedule: ReportSchedule) {
  return {
    id: schedule.id,
    name: schedule.name,
    reportKey: schedule.reportKey,
    format: schedule.format,
    recipients: parseRecipients(schedule.recipients),
    cronExpr: schedule.cronExpr,
    params: schedule.params ?? {},
    enabled: Boolean(schedule.enabled),
    lastRunAt: schedule.lastRunAt,
    lastStatus: schedule.lastStatus,
    lastError: schedule.lastError,
    lastDurationMs: schedule.lastDurationMs,
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    nextRunAt: schedule.id ? getNextReportScheduleRun(schedule.id) : null,
  };
}

function readScheduleInput(body: Record<string, unknown>): ReportScheduleInput {
  const rawRecipients = body.recipients;
  const recipients = Array.isArray(rawRecipients)
    ? rawRecipients.map(String)
    : String(rawRecipients ?? "").split(/[,;\s]+/);

  const rawParams = body.params;

  return {
    name: String(body.name ?? "").trim(),
    reportKey: String(body.reportKey ?? "").trim(),
    format: body.format === "csv" ? "csv" : "xlsx",
    recipients,
    cronExpr: String(body.cronExpr ?? "").trim(),
    params:
      rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
        ? (rawParams as Record<string, string>)
        : null,
    enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
  };
}

export const listReportSchedulesHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const schedules = await listReportSchedules();
    res.status(200).json({
      success: true,
      message: "Report schedules listed",
      data: schedules.map(serializeSchedule),
    });
  } catch (err) {
    next(err);
  }
};

export const createReportScheduleHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const input = readScheduleInput((req.body ?? {}) as Record<string, unknown>);
    const problem = validateScheduleInput(input);
    if (problem) {
      res.status(400).json({ success: false, message: problem, data: null });
      return;
    }

    const created = await createReportSchedule(input, req.user?.username);
    const armed =
      Boolean(created.id) &&
      Boolean(created.enabled) &&
      registerReportScheduleTask(created.id as number, created.cronExpr, created.name);

    res.status(201).json({
      success: true,
      message: armed
        ? "Schedule created and armed"
        : created.enabled
          ? "Schedule created (not armed — see logs for cron issues)"
          : "Schedule created (disabled)",
      data: serializeSchedule(created),
    });
  } catch (err) {
    next(err);
  }
};

export const updateReportScheduleHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, message: "Invalid schedule ID", data: null });
      return;
    }

    const input = readScheduleInput((req.body ?? {}) as Record<string, unknown>);
    const problem = validateScheduleInput(input);
    if (problem) {
      res.status(400).json({ success: false, message: problem, data: null });
      return;
    }

    let updated: ReportSchedule;
    try {
      updated = await updateReportSchedule(id, input, req.user?.username);
    } catch (err) {
      if (err instanceof Error && err.message === "NOT_FOUND") {
        res.status(404).json({ success: false, message: "Schedule not found", data: null });
        return;
      }
      throw err;
    }

    // Keep the running cron tasks in step with the saved row.
    if (updated.enabled) {
      registerReportScheduleTask(id, updated.cronExpr, updated.name);
    } else {
      unregisterReportScheduleTask(id);
    }

    res.status(200).json({
      success: true,
      message: "Schedule updated",
      data: serializeSchedule(updated),
    });
  } catch (err) {
    next(err);
  }
};

export const deleteReportScheduleHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, message: "Invalid schedule ID", data: null });
      return;
    }

    try {
      await deleteReportSchedule(id);
    } catch (err) {
      if (err instanceof Error && err.message === "NOT_FOUND") {
        res.status(404).json({ success: false, message: "Schedule not found", data: null });
        return;
      }
      throw err;
    }

    unregisterReportScheduleTask(id);
    res.status(200).json({ success: true, message: "Schedule deleted", data: { ok: true } });
  } catch (err) {
    next(err);
  }
};

export const runReportScheduleHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, message: "Invalid schedule ID", data: null });
      return;
    }

    // Confirm the row exists so a bad id is a 404 rather than a generic error.
    try {
      await getReportScheduleById(id);
    } catch {
      res.status(404).json({ success: false, message: "Schedule not found", data: null });
      return;
    }

    const result = await runReportSchedule(id);
    res.status(200).json({
      success: true,
      message: result.sent
        ? `Report sent to ${result.recipients.join(", ")}`
        : `Report not sent: ${result.reason}`,
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
