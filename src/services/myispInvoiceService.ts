import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  isAxiosError,
} from 'axios';
import * as XLSX from 'xlsx';
import type { ExternalInvoice } from '../db/entities/ExternalInvoice';
import { AppError } from '../errors/AppError';
import type {
  ImportPreviewIssue,
  ImportPreviewResult,
} from './externalInvoiceImportParser';
import { normalizeDebitLabel } from './invoiceService';

type MyISPRow = Record<string, unknown>;
export type MyISPAccount = 1 | 2;

export type MyISPMappingResult = {
  invoices: Partial<ExternalInvoice>[];
  preview: ImportPreviewResult;
};

type MyISPConfig = {
  baseUrl: string;
  username: string;
  password: string;
  resellerId?: string;
  timeoutMs: number;
};

function normalizeCell(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function isBlockedValue(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'blocked', 'disabled'].includes(normalized);
}

function parsePayDueValue(value: unknown): string | null {
  const normalized = normalizeCell(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  update(setCookie: string[] | string | undefined): void {
    const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const value of values) {
      const parts = value.split(';').map((part) => part.trim());
      const separator = parts[0].indexOf('=');
      if (separator <= 0) continue;
      const name = parts[0].slice(0, separator);
      const cookieValue = parts[0].slice(separator + 1);
      const attributes = parts.slice(1).map((part) => part.toLowerCase());
      const deleted =
        cookieValue === '' ||
        attributes.some((part) => part === 'max-age=0') ||
        attributes.some((part) => {
          if (!part.startsWith('expires=')) return false;
          const expiresAt = new Date(part.slice('expires='.length)).getTime();
          return Number.isFinite(expiresAt) && expiresAt <= Date.now();
        });
      if (deleted) this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

function loadConfig(account: MyISPAccount): MyISPConfig {
  const prefix = `MYISP_${account}_`;
  const legacy = (name: string) => (account === 1 ? process.env[`MYISP_${name}`] : undefined);
  const username = String(process.env[`${prefix}USERNAME`] || legacy('USERNAME') || '').trim();
  const password = String(process.env[`${prefix}PASSWORD`] || legacy('PASSWORD') || '');
  if (!username || !password) {
    throw new AppError(
      'MyISP integration is not configured',
      500,
      'MYISP_NOT_CONFIGURED',
      false
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(
      process.env[`${prefix}BASE_URL`] || legacy('BASE_URL') || 'https://pi.myisp.live'
    );
  } catch {
    throw new AppError('Invalid MyISP configuration', 500, 'MYISP_INVALID_CONFIG', false);
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new AppError('Invalid MyISP configuration', 500, 'MYISP_INVALID_CONFIG', false);
  }

  const parsedTimeout = Number.parseInt(
    process.env[`${prefix}TIMEOUT_MS`] || legacy('TIMEOUT_MS') || '30000',
    10
  );
  return {
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    username,
    password,
    resellerId:
      String(process.env[`${prefix}RESELLER_ID`] || legacy('RESELLER_ID') || '').trim() ||
      undefined,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30000,
  };
}

function extractCsrfToken(html: string): string | null {
  const inputTags = html.match(/<input\b[^>]*>/gi) || [];
  for (const tag of inputTags) {
    const name = /\bname\s*=\s*["']csrf_token["']/i.test(tag);
    if (!name) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (value?.[1]) return value[1];
  }
  return null;
}

function extractResellerId(html: string): string | null {
  const normalized = html.replace(/&amp;/gi, '&');
  const match = /export-users\.php\?[^"'<>]*\bresellerId=([^&"'<>]+)/i.exec(normalized);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

async function requestWithCookies(
  client: AxiosInstance,
  jar: CookieJar,
  config: AxiosRequestConfig,
  redirectsRemaining = 5
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

  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.location &&
    redirectsRemaining > 0
  ) {
    const currentUrl = new URL(
      String(response.config.url || ''),
      String(client.defaults.baseURL)
    );
    const redirectedUrl = new URL(
      response.headers.location,
      currentUrl
    ).toString();
    const switchToGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        String(config.method || 'get').toLowerCase() === 'post');
    return requestWithCookies(
      client,
      jar,
      {
        ...config,
        url: redirectedUrl,
        method: switchToGet ? 'get' : config.method,
        data: switchToGet ? undefined : config.data,
      },
      redirectsRemaining - 1
    );
  }

  return response;
}

function assertSuccessful(response: AxiosResponse, operation: string): void {
  if (response.status < 200 || response.status >= 400) {
    throw new AppError(
      `MyISP ${operation} failed`,
      502,
      'MYISP_UPSTREAM_ERROR',
      true
    );
  }
}

async function fetchAuthenticatedExport(account: MyISPAccount): Promise<Buffer> {
  const config = loadConfig(account);
  const client = axios.create({
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    responseType: 'text',
    transitional: { forcedJSONParsing: false },
  });
  const jar = new CookieJar();

  try {
    let usersHtml = '';
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const loginPage = await requestWithCookies(client, jar, {
        method: 'get',
        url: '/login.php',
      });
      assertSuccessful(loginPage, 'login');
      const csrfToken = extractCsrfToken(String(loginPage.data || ''));
      if (!csrfToken) {
        throw new AppError(
          'MyISP login page did not contain a CSRF token',
          502,
          'MYISP_LOGIN_CHANGED',
          true
        );
      }

      const form = new URLSearchParams({
        login_username: config.username,
        login_password: config.password,
        captcha: '',
        csrf_token: csrfToken,
      });
      const formHeaders = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${config.baseUrl}/login.php`,
        Origin: new URL(config.baseUrl).origin,
        'X-CSRF-Token': csrfToken,
      };
      const checkLogin = await requestWithCookies(client, jar, {
        method: 'post',
        url: '/checklogin.php',
        data: form.toString(),
        headers: {
          ...formHeaders,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      assertSuccessful(checkLogin, 'authentication');

      const loginSubmit = await requestWithCookies(client, jar, {
        method: 'post',
        url: '/login.php',
        data: form.toString(),
        headers: formHeaders,
      });
      assertSuccessful(loginSubmit, 'authentication');

      const usersPage = await requestWithCookies(client, jar, {
        method: 'get',
        url: '/resellerUsers.php',
      });
      if (
        usersPage.status >= 200 &&
        usersPage.status < 300 &&
        String(usersPage.data || '').includes('export-users.php')
      ) {
        usersHtml = String(usersPage.data);
        break;
      }
    }

    if (!usersHtml) {
      throw new AppError(
        'MyISP authentication failed',
        502,
        'MYISP_AUTH_FAILED',
        true
      );
    }

    const resellerId = config.resellerId || extractResellerId(usersHtml);
    if (!resellerId) {
      throw new AppError(
        'MyISP reseller ID could not be determined',
        502,
        'MYISP_RESELLER_ID_MISSING',
        true
      );
    }

    const exportResponse = await requestWithCookies(client, jar, {
      method: 'get',
      url: '/export-users.php',
      params: { resellerId },
      responseType: 'arraybuffer',
    });
    assertSuccessful(exportResponse, 'export');
    const contentType = String(exportResponse.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'text/csv') {
      throw new AppError(
        'MyISP returned an unexpected export format',
        502,
        'MYISP_INVALID_EXPORT',
        true
      );
    }
    return Buffer.from(exportResponse.data);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isAxiosError(error) && error.code === 'ECONNABORTED') {
      throw new AppError('MyISP request timed out', 504, 'MYISP_TIMEOUT', true);
    }
    throw new AppError('Unable to contact MyISP', 502, 'MYISP_UNAVAILABLE', true);
  }
}

function normalizeHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function readField(row: MyISPRow, keys: string[]): unknown {
  const wanted = new Set(keys.map(normalizeHeader));
  for (const [header, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(header))) return value;
  }
  return undefined;
}

function joinFields(row: MyISPRow, keys: string[]): string {
  return keys
    .map((key) => normalizeCell(readField(row, [key])))
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

export function parseMyISPCsv(buffer: Buffer): { headers: string[]; rows: MyISPRow[] } {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { headers: [], rows: [] };
  const rows = XLSX.utils.sheet_to_json<MyISPRow>(sheet, { defval: '', raw: false });
  const headerRow =
    (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false })[0] as
      | unknown[]
      | undefined) || [];
  const headers = headerRow
    .map((header) => String(header ?? '').replace(/^\uFEFF/, '').trim())
    .filter(Boolean);
  return { headers, rows };
}

export function mapMyISPRows(
  rows: MyISPRow[],
  headers: string[],
  billingMonth: string,
  actorUsername?: string,
  provider = 'myisp'
): MyISPMappingResult {
  const safeHeaders = headers.filter(
    (header) => !normalizeHeader(header).includes('password')
  );
  const issues: ImportPreviewIssue[] = [];
  const invoices: Partial<ExternalInvoice>[] = [];
  const today = new Date().toISOString().slice(0, 10);

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const username = normalizeCell(readField(row, ['username']));
    if (isBlockedValue(readField(row, ['blockuser', 'blocked']))) {
      issues.push({
        row: rowNumber,
        field: 'blockuser',
        message: 'Skipped blocked user',
        severity: 'warning',
      });
      return;
    }
    const expiryDate = parsePayDueValue(readField(row, ['expirydate', 'expiry']));
    if (!expiryDate || expiryDate <= today) {
      issues.push({
        row: rowNumber,
        field: 'expirydate',
        message: expiryDate ? 'Skipped expired user' : 'Skipped user with missing or invalid expiry',
        severity: expiryDate ? 'warning' : 'error',
      });
      return;
    }
    const amountRaw = readField(row, ['sellingprice']);
    const amountText = normalizeCell(amountRaw);
    const amount = amountText === null ? Number.NaN : Number(amountText.replace(/,/g, ''));

    if (!username) {
      issues.push({
        row: rowNumber,
        field: 'username',
        message: 'Missing username',
        severity: 'error',
      });
    }
    if (!Number.isFinite(amount)) {
      issues.push({
        row: rowNumber,
        field: 'amount',
        message: 'Invalid or missing selling price',
        severity: 'error',
      });
    }
    if (!username || !Number.isFinite(amount)) return;

    const fullName = joinFields(row, ['userfname', 'userlname']);
    const address = joinFields(row, ['address', 'address2', 'building']);
    const mobile = normalizeCell(
      readField(row, ['mobile', 'mobilenumber', 'mobilephone'])
    );
    const phone = normalizeCell(
      readField(row, ['phone', 'phonenumber', 'telephone'])
    );
    const invoice: Partial<ExternalInvoice> = {
      username,
      fullName,
      email: normalizeCell(readField(row, ['email'])) || '',
      phoneNumber: mobile || phone || '',
      address: address || null,
      provider,
      amount,
      payDueDate: expiryDate,
      billingMonth,
      status: 'pending',
      debitLabel: normalizeDebitLabel(readField(row, ['planname', 'plan'])),
      paidAt: null,
      modifiedBy: actorUsername,
      modifiedAt: new Date(),
      lastAction: 'UPLOAD',
    };
    invoices.push(invoice);
  });

  return {
    invoices,
    preview: {
      sheetName: 'MyISP',
      headers: safeHeaders,
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

export async function fetchMyISPInvoices(
  billingMonth: string,
  actorUsername?: string,
  account: MyISPAccount = 1
): Promise<MyISPMappingResult> {
  const csv = await fetchAuthenticatedExport(account);
  const { headers, rows } = parseMyISPCsv(csv);
  return mapMyISPRows(
    rows,
    headers,
    billingMonth,
    actorUsername,
    account === 1 ? 'myisp' : 'myisp2'
  );
}
