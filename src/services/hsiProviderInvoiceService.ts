import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, isAxiosError } from 'axios';
import * as XLSX from 'xlsx';
import type { ExternalInvoice } from '../db/entities/ExternalInvoice';
import { AppError } from '../errors/AppError';
import type { ImportPreviewIssue, ImportPreviewResult } from './externalInvoiceImportParser';
import { parsePayDueValue } from './externalInvoiceImportParser';
import { normalizeDebitLabel } from './invoiceService';
import { extractMacAddress } from '../utils/macAddress';

export type HsiProvider = 'idm' | 'terra';

type HsiConfig = {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
};

type HsiRow = Record<string, unknown>;

type HsiExport = {
  workbook: Buffer;
  providerMacByUsername: Map<string, string>;
};

export type HsiInvoiceResult = {
  invoices: Partial<ExternalInvoice>[];
  preview: ImportPreviewResult;
};

class CookieJar {
  private readonly values = new Map<string, string>();

  update(setCookie: string[] | string | undefined): void {
    const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const header of headers) {
      const first = header.split(';', 1)[0];
      const separator = first.indexOf('=');
      if (separator <= 0) continue;
      const name = first.slice(0, separator);
      const value = first.slice(separator + 1);
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(header)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  header(): string | undefined {
    if (!this.values.size) return undefined;
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }
}

function loadConfig(provider: HsiProvider): HsiConfig {
  const prefix = provider.toUpperCase();
  const defaults: Record<HsiProvider, string> = {
    idm: 'https://newhsipro.idm.net.lb',
    terra: 'https://acppro.terra.net.lb',
  };
  const username = String(process.env[`${prefix}_USERNAME`] || '').trim();
  const password = String(process.env[`${prefix}_PASSWORD`] || '');
  if (!username || !password) {
    throw new AppError(
      `${prefix} integration is not configured`,
      500,
      `${prefix}_NOT_CONFIGURED`,
      false
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(process.env[`${prefix}_BASE_URL`] || defaults[provider]);
  } catch {
    throw new AppError(`Invalid ${prefix} configuration`, 500, `${prefix}_INVALID_CONFIG`, false);
  }
  if (baseUrl.protocol !== 'https:') {
    throw new AppError(`Invalid ${prefix} configuration`, 500, `${prefix}_INVALID_CONFIG`, false);
  }
  const timeout = Number.parseInt(process.env[`${prefix}_TIMEOUT_MS`] || '30000', 10);
  return {
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    username,
    password,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
  };
}

async function request(
  client: AxiosInstance,
  jar: CookieJar,
  config: AxiosRequestConfig
): Promise<AxiosResponse> {
  const headers = { ...(config.headers || {}) } as Record<string, string>;
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  const response = await client.request({
    ...config,
    headers,
    maxRedirects: 0,
    validateStatus: () => true,
  });
  jar.update(response.headers['set-cookie']);
  return response;
}

function rowMacValue(row: Record<string, unknown>): unknown {
  const preferredKeys = [
    'macaddr',
    'macAddress',
    'mac_address',
    'Mac Address',
    'mac',
    'MAC',
    'staticip',
    'staticIp',
    'ip',
  ];
  for (const key of preferredKeys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }
  const wanted = new Set(preferredKeys.map((key) => normalizedHeader(key)));
  for (const [key, value] of Object.entries(row)) {
    if (!wanted.has(normalizedHeader(key))) continue;
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

export function mapHsiProviderMacRows(rows: unknown[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const username = text(row.username ?? row.userName ?? row.Username).toLowerCase();
    const mac = extractMacAddress(rowMacValue(row));
    if (username && mac) result.set(username, mac);
  }
  return result;
}

/** Fill gaps from the active-user XLSX export (status=3), which often has MACs the JSON list omits. */
export function mergeHsiWorkbookMacAddresses(
  target: Map<string, string>,
  rows: HsiRow[]
): Map<string, string> {
  for (const row of rows) {
    const username = text(field(row, 'Username')).toLowerCase();
    if (!username || target.has(username)) continue;
    const mac = extractMacAddress(field(row, 'Mac Address') ?? field(row, 'MAC') ?? field(row, 'mac'));
    if (mac) target.set(username, mac);
  }
  return target;
}

async function fetchProviderMacMap(
  client: AxiosInstance,
  jar: CookieJar,
  config: HsiConfig
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pageSize = 500;
  for (let pageIndex = 1; pageIndex <= 200; pageIndex += 1) {
    const response = await request(client, jar, {
      method: 'get',
      url: '/api/user/list/',
      params: { pageIndex, pageSize, status: 3 },
      headers: {
        'X-CSRFToken': jar.get('csrftoken') || '',
        Referer: `${config.baseUrl}/user/list/`,
      },
    });
    if (response.status !== 200) break;
    const payload =
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const [username, mac] of mapHsiProviderMacRows(rows)) {
      result.set(username, mac);
    }
    const total = Number(payload?.itemscount);
    if (!rows.length || rows.length < pageSize) break;
    if (Number.isFinite(total) && pageIndex * pageSize >= total) break;
  }
  return result;
}

async function fetchExport(provider: HsiProvider): Promise<HsiExport> {
  const config = loadConfig(provider);
  const client = axios.create({
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    transitional: { forcedJSONParsing: false },
  });
  const jar = new CookieJar();
  const prefix = provider.toUpperCase();

  try {
    const loginPath = '/login/?next=/user/list/';
    const loginPage = await request(client, jar, { method: 'get', url: loginPath });
    if (loginPage.status !== 200) {
      throw new AppError(`${prefix} login page failed`, 502, `${prefix}_UPSTREAM_ERROR`, true);
    }

    const form = new URLSearchParams({
      'login-username': config.username,
      'login-password': config.password,
    });
    const login = await request(client, jar, {
      method: 'post',
      url: loginPath,
      data: form.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(config.baseUrl).origin,
        Referer: `${config.baseUrl}${loginPath}`,
      },
    });
    if (login.status < 200 || login.status >= 400) {
      throw new AppError(`${prefix} authentication failed`, 502, `${prefix}_AUTH_FAILED`, true);
    }

    const usersPage = await request(client, jar, { method: 'get', url: '/user/list/' });
    const usersHtml = String(usersPage.data || '');
    if (usersPage.status !== 200 || !usersHtml.includes('download-list')) {
      throw new AppError(`${prefix} authentication failed`, 502, `${prefix}_AUTH_FAILED`, true);
    }

    let providerMacByUsername = new Map<string, string>();
    try {
      providerMacByUsername = await fetchProviderMacMap(client, jar, config);
    } catch {
      // Live-list MAC enrichment is best-effort and must not block invoice imports.
    }

    const exported = await request(client, jar, {
      method: 'get',
      url: '/user/list/download',
      params: { status: 3 },
      responseType: 'arraybuffer',
      headers: { Referer: `${config.baseUrl}/user/list/` },
    });
    if (exported.status !== 200) {
      throw new AppError(`${prefix} export failed`, 502, `${prefix}_UPSTREAM_ERROR`, true);
    }
    const contentType = String(exported.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('spreadsheetml')) {
      throw new AppError(`${prefix} returned an unexpected export format`, 502, `${prefix}_INVALID_EXPORT`, true);
    }
    return {
      workbook: Buffer.from(exported.data),
      providerMacByUsername,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isAxiosError(error) && error.code === 'ECONNABORTED') {
      throw new AppError(`${prefix} request timed out`, 504, `${prefix}_TIMEOUT`, true);
    }
    throw new AppError(`Unable to contact ${prefix}`, 502, `${prefix}_UNAVAILABLE`, true);
  }
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function field(row: HsiRow, name: string): unknown {
  const wanted = normalizedHeader(name);
  const entry = Object.entries(row).find(([key]) => normalizedHeader(key) === wanted);
  return entry?.[1];
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parsePrice(value: unknown): number {
  const cleaned = text(value).replace(/,/g, '').replace(/[^0-9.-]/g, '');
  return cleaned ? Number(cleaned) : Number.NaN;
}

function isBlockedValue(value: unknown): boolean {
  const normalized = text(value).toLowerCase();
  return ['1', 'true', 'yes', 'blocked', 'disabled'].includes(normalized);
}

export function parseHsiWorkbook(buffer: Buffer): { headers: string[]; rows: HsiRow[] } {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { headers: [], rows: [] };
  const rows = XLSX.utils.sheet_to_json<HsiRow>(sheet, { defval: '', raw: false });
  const firstRow = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false })[0] || [];
  return {
    headers: firstRow.map((item) => text(item)).filter(Boolean),
    rows,
  };
}

export function mapHsiRows(
  provider: HsiProvider,
  rows: HsiRow[],
  headers: string[],
  billingMonth: string,
  actorUsername?: string,
  providerMacByUsername = new Map<string, string>()
): HsiInvoiceResult {
  const invoices: Partial<ExternalInvoice>[] = [];
  const issues: ImportPreviewIssue[] = [];
  const today = new Date().toISOString().slice(0, 10);

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const username = text(field(row, 'Username'));
    if (isBlockedValue(field(row, 'Blocked'))) {
      issues.push({
        row: rowNumber,
        field: 'blocked',
        message: 'Skipped blocked user',
        severity: 'warning',
      });
      return;
    }
    const expiryDate = parsePayDueValue(field(row, 'Expiry'));
    const isExpired = expiryDate
      ? provider === 'terra'
        ? expiryDate < today
        : expiryDate <= today
      : true;
    if (isExpired) {
      issues.push({
        row: rowNumber,
        field: 'expiry',
        message: expiryDate ? 'Skipped expired user' : 'Skipped user with missing or invalid expiry',
        severity: expiryDate ? 'warning' : 'error',
      });
      return;
    }
    const amount = parsePrice(field(row, 'Price'));
    if (!username) {
      issues.push({ row: rowNumber, field: 'username', message: 'Missing username', severity: 'error' });
    }
    if (!Number.isFinite(amount)) {
      issues.push({ row: rowNumber, field: 'amount', message: 'Invalid or missing price', severity: 'error' });
    }
    if (!username || !Number.isFinite(amount)) return;

    invoices.push({
      username,
      fullName: text(field(row, 'Name')),
      email: '',
      phoneNumber: text(field(row, 'Mobile')),
      address: text(field(row, 'Address')) || null,
      provider,
      providerMacAddress:
        extractMacAddress(field(row, 'Mac Address')) ||
        providerMacByUsername.get(username.toLowerCase()) ||
        null,
      amount,
      payDueDate: expiryDate,
      billingMonth,
      status: 'pending',
      debitLabel: normalizeDebitLabel(field(row, 'Service')),
      paidAt: null,
      modifiedBy: actorUsername,
      modifiedAt: new Date(),
      lastAction: 'UPLOAD',
    });
  });

  return {
    invoices,
    preview: {
      sheetName: `${provider.toUpperCase()} users`,
      headers: headers.filter((header) => normalizedHeader(header) !== 'password'),
      suggestedMapping: {},
      rawPreview: [],
      mappedPreview: invoices.slice(0, 10),
      totalRows: rows.length,
      issues: issues.slice(0, 50),
      validRowCount: invoices.length,
      skippedRowCount: rows.length - invoices.length,
    },
  };
}

export async function fetchHsiProviderInvoices(
  provider: HsiProvider,
  billingMonth: string,
  actorUsername?: string
): Promise<HsiInvoiceResult> {
  const { workbook, providerMacByUsername } = await fetchExport(provider);
  const { headers, rows } = parseHsiWorkbook(workbook);
  return mapHsiRows(
    provider,
    rows,
    headers,
    billingMonth,
    actorUsername,
    providerMacByUsername
  );
}

/** Fetch live Username → MAC values without importing or altering invoices. */
export async function fetchHsiProviderMacAddresses(
  provider: HsiProvider
): Promise<Map<string, string>> {
  const { workbook, providerMacByUsername } = await fetchExport(provider);
  const { rows } = parseHsiWorkbook(workbook);
  return mergeHsiWorkbookMacAddresses(providerMacByUsername, rows);
}
