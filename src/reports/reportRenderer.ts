/**
 * Renders a `ReportResult` into CSV or XLSX. Both formats share the same
 * layout: title block, summary pairs, the main table, then a totals row.
 */
import * as XLSX from "xlsx";
import type { ReportColumn, ReportResult } from "./reportTypes";

/** Filename-safe timestamp, e.g. `2026-09-13T08-41-02`. */
function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/** Normalises a raw cell value for spreadsheet/CSV output. */
function formatCellValue(value: unknown, column: ReportColumn): string | number {
  if (value === null || value === undefined || value === "") return "";

  switch (column.type) {
    case "number":
    case "currency":
    case "percent": {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : String(value);
    }
    case "date":
      return toIsoString(value).slice(0, 10);
    case "datetime":
      return toIsoString(value);
    default:
      return String(value);
  }
}

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportToCsv(report: ReportResult): string {
  const lines: string[] = [];

  lines.push(escapeCsv(report.title));
  if (report.subtitle) lines.push(escapeCsv(report.subtitle));
  lines.push(escapeCsv(`Generated ${report.generatedAt}`));
  lines.push("");

  if (report.summary.length > 0) {
    for (const field of report.summary) {
      lines.push(`${escapeCsv(field.label)},${escapeCsv(field.value)}`);
    }
    lines.push("");
  }

  lines.push(report.columns.map((column) => escapeCsv(column.label)).join(","));
  for (const row of report.rows) {
    lines.push(
      report.columns.map((column) => escapeCsv(formatCellValue(row[column.key], column))).join(",")
    );
  }

  if (report.totals) {
    const totals = report.totals;
    lines.push(
      report.columns
        .map((column, index) => {
          if (index === 0) return escapeCsv("Totals");
          const total = totals[column.key];
          return typeof total === "number" ? escapeCsv(total) : "";
        })
        .join(",")
    );
  }

  return lines.join("\r\n") + "\r\n";
}

export function reportToXlsx(report: ReportResult): Buffer {
  const sheet: Array<Array<string | number>> = [];

  sheet.push([report.title]);
  if (report.subtitle) sheet.push([report.subtitle]);
  sheet.push([`Generated ${report.generatedAt}`]);
  sheet.push([]);

  if (report.summary.length > 0) {
    sheet.push(["Summary"]);
    for (const field of report.summary) sheet.push([field.label, field.value]);
    sheet.push([]);
  }

  sheet.push(report.columns.map((column) => column.label));
  for (const row of report.rows) {
    sheet.push(report.columns.map((column) => formatCellValue(row[column.key], column)));
  }

  if (report.totals) {
    const totals = report.totals;
    sheet.push(
      report.columns.map((column, index) => {
        if (index === 0) return "Totals";
        const total = totals[column.key];
        return typeof total === "number" ? total : "";
      })
    );
  }

  const worksheet = XLSX.utils.aoa_to_sheet(sheet);
  worksheet["!cols"] = report.columns.map((column) => ({
    wch: column.width ?? Math.max(12, column.label.length + 4),
  }));

  const workbook = XLSX.utils.book_new();
  // Excel sheet names are capped at 31 chars and reject : \ / ? * [ ]
  const sheetName = report.title.replace(/[:\\/?*[\]]/g, "").slice(0, 31) || "Report";
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function reportFileName(report: ReportResult, extension: string): string {
  const slug = report.key.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `${slug}-${fileStamp()}.${extension}`;
}
