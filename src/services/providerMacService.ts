import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { UserMac } from "../db/entities/UserMac";
import { extractMacAddress } from "../utils/macAddress";
import {
  fetchMyISPProviderMacAddresses,
  MyISPAccount,
} from "./myispInvoiceService";
import {
  fetchHsiProviderMacAddresses,
  HsiProvider,
} from "./hsiProviderInvoiceService";

export type ProviderMacList = {
  provider: string;
  billingMonth: string;
  macAddresses: string[];
  stats: {
    totalSubscribers: number;
    withMac: number;
    missingMac: number;
    invalidMac: number;
    uniqueMacs: number;
    duplicateAssignments: number;
  };
};

export type ProviderMacSyncResult = {
  provider: string;
  billingMonth: string;
  /** Active provider users that returned a parseable MAC. */
  providerMacs: number;
  /** Invoice usernames that matched a provider MAC. */
  matchedSubscribers: number;
  updatedInvoiceRows: number;
  /** Invoice usernames with no matching provider MAC. */
  missingSubscribers: number;
  /** Unique MAC addresses from the live provider pull (not limited to invoice rows). */
  macAddresses: string[];
};

const LIVE_MAC_PROVIDERS = new Set(["myisp", "myisp2", "idm", "terra"]);

function normalizeBillingMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(value || "").trim());
  if (!match) throw new Error("Billing month must use YYYY-MM format");
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("Billing month must use YYYY-MM format");
  return `${match[1]}-${match[2]}-01`;
}

function listFromMacMap(
  provider: string,
  billingMonthYm: string,
  providerMacs: Map<string, string>
): ProviderMacList {
  const normalizedMacs = [...providerMacs.values()];
  const macAddresses = Array.from(new Set(normalizedMacs)).sort();
  return {
    provider,
    billingMonth: billingMonthYm,
    macAddresses,
    stats: {
      totalSubscribers: providerMacs.size,
      withMac: providerMacs.size,
      missingMac: 0,
      invalidMac: 0,
      uniqueMacs: macAddresses.length,
      duplicateAssignments: normalizedMacs.length - macAddresses.length,
    },
  };
}

async function fetchLiveProviderMacMap(provider: string): Promise<Map<string, string>> {
  if (provider === "myisp" || provider === "myisp2") {
    const account: MyISPAccount = provider === "myisp2" ? 2 : 1;
    return fetchMyISPProviderMacAddresses(account);
  }
  return fetchHsiProviderMacAddresses(provider as HsiProvider);
}

export async function getInvoiceProvidersForMonth(billingMonth: string): Promise<string[]> {
  const month = normalizeBillingMonth(billingMonth);
  const rows = await AppDataSource.getRepository(ExternalInvoice)
    .createQueryBuilder("invoice")
    .select("LOWER(TRIM(invoice.provider))", "provider")
    .where("invoice.billingMonth = :month", { month })
    .andWhere("invoice.deletedAt IS NULL")
    .andWhere("invoice.documentType = :documentType", { documentType: "invoice" })
    .andWhere("TRIM(invoice.provider) <> ''")
    .distinct(true)
    .orderBy("provider", "ASC")
    .getRawMany<{ provider: string }>();

  return rows.map((row) => String(row.provider || "").trim()).filter(Boolean);
}

async function getInvoiceProviderMacList(
  provider: string,
  month: string
): Promise<ProviderMacList> {
  const rows = await AppDataSource.getRepository(ExternalInvoice)
    .createQueryBuilder("invoice")
    .leftJoin(
      UserMac,
      "userMac",
      "userMac.username = invoice.username COLLATE utf8mb4_unicode_ci"
    )
    .select("invoice.username", "username")
    .addSelect(
      "COALESCE(NULLIF(invoice.providerMacAddress, ''), userMac.macAddress)",
      "macAddress"
    )
    .where("LOWER(TRIM(invoice.provider)) = :provider", { provider })
    .andWhere("invoice.billingMonth = :month", { month })
    .andWhere("invoice.deletedAt IS NULL")
    .andWhere("invoice.documentType = :documentType", { documentType: "invoice" })
    .groupBy("invoice.username")
    .addGroupBy("invoice.providerMacAddress")
    .addGroupBy("userMac.macAddress")
    .orderBy("invoice.username", "ASC")
    .getRawMany<{ username: string; macAddress: string | null }>();

  const normalizedMacs: string[] = [];
  let missingMac = 0;
  let invalidMac = 0;
  for (const row of rows) {
    const raw = String(row.macAddress || "").trim();
    if (!raw) {
      missingMac += 1;
      continue;
    }
    const normalized = extractMacAddress(raw);
    if (!normalized) {
      invalidMac += 1;
      continue;
    }
    normalizedMacs.push(normalized);
  }

  const macAddresses = Array.from(new Set(normalizedMacs)).sort();
  return {
    provider,
    billingMonth: month.slice(0, 7),
    macAddresses,
    stats: {
      totalSubscribers: rows.length,
      withMac: normalizedMacs.length,
      missingMac,
      invalidMac,
      uniqueMacs: macAddresses.length,
      duplicateAssignments: normalizedMacs.length - macAddresses.length,
    },
  };
}

export async function getProviderMacList(
  providerInput: string,
  billingMonth: string
): Promise<ProviderMacList> {
  const provider = String(providerInput || "").trim().toLowerCase();
  if (!provider) throw new Error("Provider is required");
  if (provider.length > 10) throw new Error("Provider is invalid");
  const month = normalizeBillingMonth(billingMonth);

  // Live-capable providers: MAC download should reflect active provider users with a MAC,
  // not only usernames that happen to exist in this month's invoice import.
  if (LIVE_MAC_PROVIDERS.has(provider)) {
    try {
      const providerMacs = await fetchLiveProviderMacMap(provider);
      return listFromMacMap(provider, month.slice(0, 7), providerMacs);
    } catch {
      // Fall back to invoice-stored MACs when the provider is unreachable.
    }
  }

  return getInvoiceProviderMacList(provider, month);
}

export async function syncProviderMacAddresses(
  providerInput: string,
  billingMonth: string
): Promise<ProviderMacSyncResult> {
  const provider = String(providerInput || "").trim().toLowerCase();
  if (!LIVE_MAC_PROVIDERS.has(provider)) {
    throw new Error("Live MAC sync is unavailable for this provider");
  }
  const month = normalizeBillingMonth(billingMonth);
  const providerMacs = await fetchLiveProviderMacMap(provider);

  const repo = AppDataSource.getRepository(ExternalInvoice);
  const invoices = await repo
    .createQueryBuilder("invoice")
    .where("LOWER(TRIM(invoice.provider)) = :provider", { provider })
    .andWhere("invoice.billingMonth = :month", { month })
    .andWhere("invoice.deletedAt IS NULL")
    .andWhere("invoice.documentType = :documentType", { documentType: "invoice" })
    .getMany();

  const matchedSubscribers = new Set<string>();
  const invoiceSubscribers = new Set<string>();
  const changed: ExternalInvoice[] = [];
  for (const invoice of invoices) {
    const username = String(invoice.username || "").trim().toLowerCase();
    if (!username) continue;
    invoiceSubscribers.add(username);
    const mac = providerMacs.get(username);
    if (!mac) continue;
    matchedSubscribers.add(username);
    if (invoice.providerMacAddress !== mac) {
      invoice.providerMacAddress = mac;
      changed.push(invoice);
    }
  }

  if (changed.length) await repo.save(changed, { chunk: 250 });

  const list = listFromMacMap(provider, month.slice(0, 7), providerMacs);
  return {
    provider,
    billingMonth: month.slice(0, 7),
    providerMacs: providerMacs.size,
    matchedSubscribers: matchedSubscribers.size,
    updatedInvoiceRows: changed.length,
    missingSubscribers: invoiceSubscribers.size - matchedSubscribers.size,
    macAddresses: list.macAddresses,
  };
}
