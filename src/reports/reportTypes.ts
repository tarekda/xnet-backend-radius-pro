/**
 * Shared types for the reporting engine.
 *
 * A report is a single titled table plus optional summary figures and a totals
 * row. Keeping every report to one table is deliberate: it lets the same
 * definition render cleanly as JSON (on-screen preview), CSV, and XLSX without
 * any lossy flattening.
 */

export type ReportColumnType =
  | "string"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "datetime";

export type ReportColumn = {
  key: string;
  label: string;
  type?: ReportColumnType;
  /** Column width hint used by spreadsheet exports. */
  width?: number;
};

export type ReportSummaryField = {
  label: string;
  value: string | number;
};

export type ReportResult = {
  key: string;
  title: string;
  subtitle?: string;
  generatedAt: string;
  /** Key/value figures rendered above the table. */
  summary: ReportSummaryField[];
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  /** Optional column-key → total, rendered as a trailing totals row. */
  totals?: Record<string, number>;
};

export type ReportParamType = "date" | "month" | "number" | "select" | "text";

export type ReportParamSpec = {
  name: string;
  label: string;
  type: ReportParamType;
  required?: boolean;
  default?: string;
  options?: Array<{ value: string; label: string }>;
  help?: string;
};

export type ReportCategory = "billing" | "collections" | "expenses" | "subscribers";

export type ReportParams = Record<string, string | undefined>;

export type ReportDefinition = {
  key: string;
  title: string;
  description: string;
  category: ReportCategory;
  params: ReportParamSpec[];
  build: (params: ReportParams) => Promise<ReportResult>;
};

/** The serialisable subset sent to the client when listing available reports. */
export type ReportDescriptor = Pick<
  ReportDefinition,
  "key" | "title" | "description" | "category" | "params"
>;

export type ReportFormat = "json" | "csv" | "xlsx";

/** Hard cap on exported rows so a report request cannot exhaust memory. */
export const REPORT_MAX_ROWS = 20_000;
