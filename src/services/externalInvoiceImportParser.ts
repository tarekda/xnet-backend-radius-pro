import * as XLSX from 'xlsx';
import fs from 'fs';
import { ExternalInvoice } from '../db/entities/ExternalInvoice';
import { normalizeDebitLabel } from './invoiceService';

export type ImportCanonicalField =
  | 'username'
  | 'fullName'
  | 'email'
  | 'phoneNumber'
  | 'address'
  | 'provider'
  | 'debitLabel'
  | 'amount'
  | 'payDueDate'
  | 'billingMonth'
  | 'status';

export type ImportColumnMapping = Partial<Record<ImportCanonicalField, string>>;

export type ImportPreviewIssue = {
  row: number;
  field: string;
  message: string;
  severity: 'warning' | 'error';
};

export type ParsedImportSheet = {
  sheetName: string;
  headers: string[];
  rawRows: Record<string, unknown>[];
  totalRows: number;
};

export type ImportPreviewResult = {
  sheetName: string;
  headers: string[];
  suggestedMapping: ImportColumnMapping;
  rawPreview: Record<string, unknown>[];
  mappedPreview: Array<Partial<ExternalInvoice>>;
  totalRows: number;
  issues: ImportPreviewIssue[];
  validRowCount: number;
  skippedRowCount: number;
};

const CANONICAL_FIELDS: ImportCanonicalField[] = [
  'username',
  'fullName',
  'email',
  'phoneNumber',
  'address',
  'provider',
  'debitLabel',
  'amount',
  'payDueDate',
  'billingMonth',
  'status',
];

/** Header aliases → canonical field (lowercase normalized key). */
const HEADER_ALIASES: Record<string, ImportCanonicalField> = {
  username: 'username',
  user: 'username',
  user_name: 'username',
  login: 'username',
  account: 'username',
  subscriber: 'username',

  fullname: 'fullName',
  full_name: 'fullName',
  name: 'fullName',
  customer: 'fullName',
  customername: 'fullName',
  customer_name: 'fullName',

  email: 'email',
  mail: 'email',
  e_mail: 'email',

  phonenumber: 'phoneNumber',
  phone_number: 'phoneNumber',
  phone: 'phoneNumber',
  mobile: 'phoneNumber',
  tel: 'phoneNumber',
  telephone: 'phoneNumber',

  address: 'address',
  addr: 'address',
  location: 'address',
  addressline1: 'address',

  provider: 'provider',
  isp: 'provider',
  supplier: 'provider',
  company: 'provider',

  debitlabel: 'debitLabel',
  debit_label: 'debitLabel',
  debit: 'debitLabel',
  line_type: 'debitLabel',
  linetype: 'debitLabel',

  amount: 'amount',
  total: 'amount',
  price: 'amount',
  fee: 'amount',
  charge: 'amount',
  balance: 'amount',

  payduedate: 'payDueDate',
  pay_due_date: 'payDueDate',
  paydue: 'payDueDate',
  paydate: 'payDueDate',
  pay_date: 'payDueDate',
  duedate: 'payDueDate',
  due_date: 'payDueDate',
  paymentdue: 'payDueDate',

  billingmonth: 'billingMonth',
  billing_month: 'billingMonth',
  month: 'billingMonth',
  billmonth: 'billingMonth',
  period: 'billingMonth',

  status: 'status',
  paymentstatus: 'status',
  payment_status: 'status',
  paid: 'status',
};

function normalizeHeaderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeCell(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export function normalizeToMonthStart(value: string): string | null {
  if (!value) return null;
  let year = 0;
  let month = 0;
  const ymMatch = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
  if (ymMatch) {
    year = parseInt(ymMatch[1], 10);
    month = parseInt(ymMatch[2], 10);
  } else {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    year = d.getFullYear();
    month = d.getMonth() + 1;
  }
  if (!year || !month || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function parsePayDueValue(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' && raw > 20000 && raw < 100000) {
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  const d = new Date(String(raw));
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function pickMappedValue(row: Record<string, unknown>, mapping: ImportColumnMapping, field: ImportCanonicalField): unknown {
  const header = mapping[field];
  if (header && Object.prototype.hasOwnProperty.call(row, header)) {
    return row[header];
  }
  return undefined;
}

/** Legacy fallbacks when no mapping provided — matches prior upload behavior. */
function pickLegacyValue(row: Record<string, unknown>, field: ImportCanonicalField): unknown {
  switch (field) {
    case 'username':
      return row.username ?? row.user ?? row.User ?? row.login;
    case 'fullName':
      return row.fullName ?? row.full_name ?? row.name ?? row.Name ?? row.customer;
    case 'email':
      return row.email ?? row.Email ?? row.mail;
    case 'phoneNumber':
      return row.phoneNumber ?? row.phone ?? row.Phone ?? row.mobile ?? row.tel;
    case 'address':
      return (
        row.address ??
        row.Address ??
        row.ADDRESS ??
        (row as { 'Address Line 1'?: unknown })['Address Line 1']
      );
    case 'provider':
      return row.provider ?? row.Provider ?? row.isp ?? row.ISP;
    case 'debitLabel':
      return (
        row.debitLabel ??
        row.debit ??
        row.DebitLabel ??
        (row as { 'Debit Label'?: unknown })['Debit Label']
      );
    case 'amount':
      return row.amount ?? row.Amount ?? row.total ?? row.Total ?? row.price;
    case 'payDueDate':
      return (
        row.payDueDate ??
        row.paydate ??
        row.PayDate ??
        row.pay_date ??
        (row as { payDue?: unknown }).payDue ??
        (row as { 'Pay Due'?: unknown })['Pay Due']
      );
    case 'billingMonth':
      return row.billingMonth ?? row.billing_month ?? row.month ?? row.Month;
    case 'status':
      return row.status ?? row.Status ?? row.payment_status;
    default:
      return undefined;
  }
}

function getMappedRaw(row: Record<string, unknown>, mapping: ImportColumnMapping | undefined, field: ImportCanonicalField): unknown {
  const fromMap = mapping?.[field] ? pickMappedValue(row, mapping, field) : undefined;
  if (fromMap !== undefined) return fromMap;
  if (!mapping || Object.keys(mapping).length === 0) return pickLegacyValue(row, field);
  return pickMappedValue(row, mapping, field);
}

export function suggestColumnMapping(headers: string[]): ImportColumnMapping {
  const mapping: ImportColumnMapping = {};
  const used = new Set<string>();

  for (const header of headers) {
    const norm = normalizeHeaderKey(header);
    const exact = HEADER_ALIASES[norm];
    const field = exact ?? (CANONICAL_FIELDS.includes(norm as ImportCanonicalField) ? (norm as ImportCanonicalField) : undefined);
    if (!field || mapping[field] || used.has(header)) continue;
    mapping[field] = header;
    used.add(header);
  }

  // Case-insensitive exact match on canonical names
  for (const field of CANONICAL_FIELDS) {
    if (mapping[field]) continue;
    const match = headers.find((h) => h.trim().toLowerCase() === field.toLowerCase());
    if (match && !used.has(match)) {
      mapping[field] = match;
      used.add(match);
    }
  }

  return mapping;
}

export function parseImportWorkbook(filePath: string): ParsedImportSheet {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const headers =
    rawRows.length > 0
      ? Object.keys(rawRows[0])
      : (XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] as string[] | undefined) ?? [];

  return {
    sheetName,
    headers: headers.filter((h) => String(h ?? '').trim().length > 0),
    rawRows,
    totalRows: rawRows.length,
  };
}

export function shouldSkipImportRow(fullName: string | null | undefined): boolean {
  const uname = (fullName ?? '').toString().trim().toLowerCase();
  return uname.endsWith('xn');
}

export function mapRowToExternalInvoice(
  row: Record<string, unknown>,
  options: {
    mapping?: ImportColumnMapping;
    monthOverride?: string | null;
    rowIndex?: number;
    actorUsername?: string;
  }
): { invoice: Partial<ExternalInvoice> | null; issues: ImportPreviewIssue[] } {
  const { mapping, monthOverride, rowIndex = 0, actorUsername } = options;
  const issues: ImportPreviewIssue[] = [];

  const username = normalizeCell(getMappedRaw(row, mapping, 'username'));
  const fullName = normalizeCell(getMappedRaw(row, mapping, 'fullName'));
  const email = normalizeCell(getMappedRaw(row, mapping, 'email'));
  const phoneNumber = normalizeCell(getMappedRaw(row, mapping, 'phoneNumber'));
  const address = normalizeCell(getMappedRaw(row, mapping, 'address'));
  const provider = normalizeCell(getMappedRaw(row, mapping, 'provider'));
  const debitLabel = normalizeDebitLabel(getMappedRaw(row, mapping, 'debitLabel') ?? '');
  const amountRaw = getMappedRaw(row, mapping, 'amount');
  const payDueDate = parsePayDueValue(getMappedRaw(row, mapping, 'payDueDate'));
  const statusRaw = normalizeCell(getMappedRaw(row, mapping, 'status'));
  const billingMonthRaw = getMappedRaw(row, mapping, 'billingMonth');

  if (!username) {
    issues.push({ row: rowIndex, field: 'username', message: 'Missing username', severity: 'error' });
  }

  let billingDate: string;
  if (monthOverride) {
    billingDate = monthOverride;
  } else if (billingMonthRaw !== undefined && billingMonthRaw !== null && String(billingMonthRaw).trim() !== '') {
    const normalized = normalizeToMonthStart(String(billingMonthRaw));
    if (normalized) {
      billingDate = normalized;
    } else {
      issues.push({ row: rowIndex, field: 'billingMonth', message: 'Invalid billing month', severity: 'warning' });
      const today = new Date();
      billingDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    }
  } else {
    const today = new Date();
    billingDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  }

  let amount = parseFloat(String(amountRaw ?? ''));
  if (!Number.isFinite(amount)) {
    amount = 30;
    if (amountRaw !== undefined && amountRaw !== null && String(amountRaw).trim() !== '') {
      issues.push({ row: rowIndex, field: 'amount', message: 'Invalid amount — defaulted to 30', severity: 'warning' });
    }
  }

  if (shouldSkipImportRow(fullName)) {
    return { invoice: null, issues: [{ row: rowIndex, field: 'fullName', message: "Skipped row (name ends with 'xn')", severity: 'warning' }] };
  }

  if (!username) {
    return { invoice: null, issues };
  }

  const invoice: Partial<ExternalInvoice> = {
    username,
    fullName: fullName ?? '',
    email: email ?? '',
    provider: provider ?? '',
    phoneNumber: phoneNumber ?? '',
    address,
    payDueDate,
    debitLabel,
    billingMonth: billingDate,
    amount,
    status: statusRaw || 'pending',
    paidAt: null,
    modifiedBy: actorUsername,
    modifiedAt: new Date(),
    lastAction: 'UPLOAD',
  };

  return { invoice, issues };
}

export function buildImportPreview(
  parsed: ParsedImportSheet,
  options?: { mapping?: ImportColumnMapping; monthOverride?: string | null; previewLimit?: number }
): ImportPreviewResult {
  const previewLimit = options?.previewLimit ?? 10;
  const mapping = options?.mapping ?? suggestColumnMapping(parsed.headers);
  const issues: ImportPreviewIssue[] = [];
  const mappedPreview: Array<Partial<ExternalInvoice>> = [];
  let validRowCount = 0;
  let skippedRowCount = 0;

  parsed.rawRows.forEach((row, idx) => {
    const { invoice, issues: rowIssues } = mapRowToExternalInvoice(row, {
      mapping,
      monthOverride: options?.monthOverride ?? null,
      rowIndex: idx + 2,
    });
    issues.push(...rowIssues);
    if (!invoice) {
      skippedRowCount += 1;
      return;
    }
    validRowCount += 1;
    if (mappedPreview.length < previewLimit) {
      mappedPreview.push(invoice);
    }
  });

  return {
    sheetName: parsed.sheetName,
    headers: parsed.headers,
    suggestedMapping: mapping,
    rawPreview: parsed.rawRows.slice(0, previewLimit),
    mappedPreview,
    totalRows: parsed.totalRows,
    issues: issues.slice(0, 50),
    validRowCount,
    skippedRowCount,
  };
}

export function parseImportFileToInvoices(
  filePath: string,
  options: {
    mapping?: ImportColumnMapping;
    monthOverride?: string | null;
    actorUsername?: string;
  }
): { invoices: Partial<ExternalInvoice>[]; skippedCount: number; issueCount: number } {
  const parsed = parseImportWorkbook(filePath);
  const mapping =
    options.mapping && Object.keys(options.mapping).length > 0
      ? options.mapping
      : suggestColumnMapping(parsed.headers);

  const invoices: Partial<ExternalInvoice>[] = [];
  let skippedCount = 0;
  let issueCount = 0;

  for (let i = 0; i < parsed.rawRows.length; i++) {
    const { invoice, issues } = mapRowToExternalInvoice(parsed.rawRows[i], {
      mapping,
      monthOverride: options.monthOverride ?? null,
      rowIndex: i + 2,
      actorUsername: options.actorUsername,
    });
    if (issues.length) issueCount += issues.length;
    if (!invoice) {
      skippedCount += 1;
      continue;
    }
    invoices.push(invoice);
  }

  return { invoices, skippedCount, issueCount };
}

export function parseColumnMappingInput(raw: unknown): ImportColumnMapping | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as ImportColumnMapping;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ImportColumnMapping;
      return typeof parsed === 'object' && parsed ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function cleanupImportFile(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}

export const IMPORT_CANONICAL_FIELDS = CANONICAL_FIELDS;
