/**
 * Recurring report delivery.
 *
 * A schedule pairs a report definition with a cron expression and a recipient
 * list; running it renders the report and emails it as an attachment.
 */
import cron from "node-cron";
import { AppDataSource } from "../db/config";
import { ReportSchedule } from "../db/entities/ReportSchedule";
import { getReportDefinition } from "../reports/reportRegistry";
import { reportFileName, reportToCsv, reportToXlsx } from "../reports/reportRenderer";
import type { ReportResult } from "../reports/reportTypes";
import { sendEmail } from "./emailService";

export type ReportScheduleInput = {
  name: string;
  reportKey: string;
  format: "csv" | "xlsx";
  recipients: string[];
  cronExpr: string;
  params?: Record<string, string> | null;
  enabled?: boolean;
};

export type ReportScheduleRunResult = {
  sent: boolean;
  reason: string | null;
  recipients: string[];
  rows: number;
  durationMs: number;
};

/** Rows embedded in the email body before the attachment takes over. */
const EMAIL_PREVIEW_ROWS = 15;

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function parseRecipients(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry));
}

function buildEmailBodies(report: ReportResult, recipientCount: number) {
  const preview = report.rows.slice(0, EMAIL_PREVIEW_ROWS);
  const summaryLines = report.summary.map((field) => `${field.label}: ${field.value}`);

  const text = [
    `${report.title}`,
    report.subtitle ?? "",
    `Generated ${new Date(report.generatedAt).toLocaleString()}`,
    "",
    ...summaryLines,
    "",
    `Rows: ${report.rows.length.toLocaleString()}`,
    `The full report is attached (${recipientCount} recipient(s) on this schedule).`,
  ]
    .filter(Boolean)
    .join("\n");

  const summaryHtml = report.summary
    .map(
      (field) =>
        `<tr><td style="padding:5px 8px;color:#64748b">${escapeHtml(field.label)}</td><td style="padding:5px 8px;font-weight:600">${escapeHtml(field.value)}</td></tr>`
    )
    .join("");

  const tableHtml =
    preview.length > 0
      ? `<table style="border-collapse:collapse;width:100%;font-size:12px;margin-top:14px">
           <thead><tr>${report.columns
             .map(
               (column) =>
                 `<th style="text-align:left;padding:5px 8px;background:#f1f5f9;color:#475569;font-weight:600">${escapeHtml(column.label)}</th>`
             )
             .join("")}</tr></thead>
           <tbody>${preview
             .map(
               (row) =>
                 `<tr>${report.columns
                   .map((column) => {
                     const raw = row[column.key];
                     return `<td style="padding:5px 8px;border-bottom:1px solid #f1f5f9">${escapeHtml(raw === null || raw === undefined || raw === "" ? "—" : raw)}</td>`;
                   })
                   .join("")}</tr>`
             )
             .join("")}</tbody>
         </table>`
      : "";

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;color:#0f172a">
  <div style="border-left:4px solid #6366f1;padding:12px 16px;background:#f8fafc">
    <h2 style="margin:0 0 4px;font-size:17px">${escapeHtml(report.title)}</h2>
    <div style="font-size:12px;color:#64748b">${escapeHtml(report.subtitle ?? "")}${report.subtitle ? " · " : ""}Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}</div>
  </div>
  ${summaryHtml ? `<table style="border-collapse:collapse;font-size:13px;margin-top:12px">${summaryHtml}</table>` : ""}
  ${tableHtml}
  <p style="margin-top:16px;font-size:12px;color:#64748b">
    Showing ${preview.length} of ${report.rows.length.toLocaleString()} rows. The complete report is attached.
  </p>
  <p style="margin-top:12px;font-size:11px;color:#94a3b8">XNet RADIUS Pro scheduled reports</p>
</div>`;

  return { text, html };
}

export async function listReportSchedules(): Promise<ReportSchedule[]> {
  return AppDataSource.getRepository(ReportSchedule).find({ order: { id: "ASC" } });
}

export async function listEnabledReportSchedules(): Promise<ReportSchedule[]> {
  return AppDataSource.getRepository(ReportSchedule).find({
    where: { enabled: true },
    order: { id: "ASC" },
  });
}

export async function getReportScheduleById(id: number): Promise<ReportSchedule> {
  const schedule = await AppDataSource.getRepository(ReportSchedule).findOne({ where: { id } });
  if (!schedule) throw new Error("NOT_FOUND");
  return schedule;
}

/** Validates a schedule payload, returning the first problem found. */
export function validateScheduleInput(input: ReportScheduleInput): string | null {
  if (!input.name?.trim()) return "name is required";
  if (!getReportDefinition(input.reportKey)) return `Unknown report "${input.reportKey}"`;
  if (input.format !== "csv" && input.format !== "xlsx") return "format must be csv or xlsx";
  if (!cron.validate(input.cronExpr)) return `Invalid cron expression "${input.cronExpr}"`;
  if (parseRecipients(input.recipients.join(",")).length === 0) {
    return "At least one valid recipient email address is required";
  }
  return null;
}

export async function createReportSchedule(
  input: ReportScheduleInput,
  actor?: string
): Promise<ReportSchedule> {
  const problem = validateScheduleInput(input);
  if (problem) throw new Error(problem);

  const repo = AppDataSource.getRepository(ReportSchedule);
  const schedule = repo.create({
    name: input.name.trim(),
    reportKey: input.reportKey,
    format: input.format,
    recipients: parseRecipients(input.recipients.join(",")).join(", "),
    cronExpr: input.cronExpr.trim(),
    params: input.params ?? null,
    enabled: input.enabled ?? true,
    createdBy: actor ?? null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
  });
  return repo.save(schedule);
}

export async function updateReportSchedule(
  id: number,
  input: ReportScheduleInput,
  _actor?: string
): Promise<ReportSchedule> {
  const repo = AppDataSource.getRepository(ReportSchedule);
  const existing = await repo.findOne({ where: { id } });
  if (!existing) throw new Error("NOT_FOUND");

  const problem = validateScheduleInput(input);
  if (problem) throw new Error(problem);

  existing.name = input.name.trim();
  existing.reportKey = input.reportKey;
  existing.format = input.format;
  existing.recipients = parseRecipients(input.recipients.join(",")).join(", ");
  existing.cronExpr = input.cronExpr.trim();
  existing.params = input.params ?? null;
  if (input.enabled !== undefined) existing.enabled = input.enabled;

  return repo.save(existing);
}

export async function deleteReportSchedule(id: number): Promise<{ ok: true }> {
  const repo = AppDataSource.getRepository(ReportSchedule);
  const existing = await repo.findOne({ where: { id } });
  if (!existing) throw new Error("NOT_FOUND");
  await repo.remove(existing);
  return { ok: true };
}

/**
 * Renders a schedule's report and emails it. Always records the outcome on the
 * row; only throws when the schedule itself is missing.
 */
export async function runReportSchedule(id: number): Promise<ReportScheduleRunResult> {
  const repo = AppDataSource.getRepository(ReportSchedule);
  const schedule = await repo.findOne({ where: { id } });
  if (!schedule) throw new Error("NOT_FOUND");

  const recipients = parseRecipients(schedule.recipients);
  const startedAt = Date.now();

  const recordFailure = async (reason: string): Promise<ReportScheduleRunResult> => {
    const durationMs = Date.now() - startedAt;
    await repo.update(
      { id },
      { lastRunAt: new Date(), lastStatus: "failed", lastError: reason, lastDurationMs: durationMs }
    );
    return { sent: false, reason, recipients, rows: 0, durationMs };
  };

  const definition = getReportDefinition(schedule.reportKey);
  if (!definition) return recordFailure(`Unknown report "${schedule.reportKey}"`);
  if (recipients.length === 0) return recordFailure("No valid recipients configured");

  let report: ReportResult;
  try {
    report = await definition.build(schedule.params ?? {});
  } catch (err) {
    return recordFailure(`Report build failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const buffer =
    schedule.format === "csv"
      ? Buffer.from(reportToCsv(report), "utf8")
      : reportToXlsx(report);

  const { text, html } = buildEmailBodies(report, recipients.length);

  const result = await sendEmail({
    to: recipients,
    subject: `[Report] ${report.title} — ${new Date().toLocaleDateString()}`,
    text,
    html,
    attachments: [
      {
        filename: reportFileName(report, schedule.format),
        content: buffer,
        contentType: schedule.format === "csv" ? "text/csv; charset=utf-8" : XLSX_MIME,
      },
    ],
  });

  const durationMs = Date.now() - startedAt;
  await repo.update(
    { id },
    {
      lastRunAt: new Date(),
      lastStatus: result.sent ? "success" : "failed",
      lastError: result.sent ? null : result.reason,
      lastDurationMs: durationMs,
    }
  );

  return {
    sent: result.sent,
    reason: result.sent ? null : result.reason,
    recipients,
    rows: report.rows.length,
    durationMs,
  };
}
