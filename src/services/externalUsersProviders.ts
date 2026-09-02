/**
 * externalUsersProviders.ts
 * Thin adapters that re-use the existing authenticated export logic from
 * myispInvoiceService and hsiProviderInvoiceService, but return ExternalUser[]
 * instead of invoice data.
 */
import type { ExternalUser, ExternalUserProvider } from "./externalUsersService";
import { parseMyISPCsv, type MyISPAccount } from "./myispInvoiceService";
import { parseHsiWorkbook, type HsiProvider } from "./hsiProviderInvoiceService";

// Re-export the internal fetchAuthenticatedExport functions by calling the
// existing invoice service fetch but grabbing only the raw export buffer.

// ─── MyISP ────────────────────────────────────────────────────────────────────

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeHeader(header: string): string {
  return header.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readField(row: Record<string, unknown>, keys: string[]): unknown {
  const wanted = new Set(keys.map(normalizeHeader));
  for (const [header, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(header))) return value;
  }
  return undefined;
}

export async function fetchAuthenticatedMyISPRows(account: MyISPAccount): Promise<ExternalUser[]> {
  // Use the fast path: login → DataTable API with live online status embedded in HTML.
  const { fetchMyISPRawUsers } = await import("./myispInvoiceService");
  const rows = await fetchMyISPRawUsers(account);

  const providerKey: ExternalUserProvider = account === 1 ? "myisp" : "myisp2";
  const providerLabel = account === 1 ? "MyISP Account 1" : "MyISP Account 2";

  return rows.map((row): ExternalUser => ({
    username: row.username,
    fullName: row.fullName,
    email: row.email,
    phoneNumber: row.phoneNumber,
    address: row.address,
    plan: row.plan,
    expiryDate: row.expiryDate,
    macAddress: row.macAddress,
    provider: providerKey,
    providerLabel,
    online: row.online,   // ← live status from provider RADIUS
    sessionIp: null,
    sessionStarted: null,
  }));
}

// ─── HSI (IDM / Terra) ───────────────────────────────────────────────────────

export async function fetchAuthenticatedHsiRows(provider: HsiProvider): Promise<ExternalUser[]> {
  const { fetchHsiRawUsers } = await import("./hsiProviderInvoiceService");
  const rows = await fetchHsiRawUsers(provider);

  const providerKey: ExternalUserProvider = provider as ExternalUserProvider;
  const providerLabel =
    provider === "misp"
      ? "MISP Cloud"
      : provider === "idm"
        ? "IDM HSI Pro"
        : provider === "terra2"
          ? "Terra ACP Pro 2"
          : "Terra ACP Pro 1";

  return rows.map((row): ExternalUser => ({
    username: row.username,
    fullName: row.fullName,
    email: row.email,
    phoneNumber: row.phoneNumber,
    address: row.address,
    plan: row.plan,
    expiryDate: row.expiryDate,
    macAddress: row.macAddress,
    provider: providerKey,
    providerLabel,
    online: row.online,
    sessionIp: row.sessionIp,
    sessionStarted: null,
  }));
}
