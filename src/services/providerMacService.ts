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
  providerMacs: number;
  matchedSubscribers: number;
  updatedInvoiceRows: number;
  missingSubscribers: number;
};

function normalizeBillingMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(value || "").trim());
  if (!match) throw new Error("Billing month must use YYYY-MM format");
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("Billing month must use YYYY-MM format");
  return `${match[1]}-${match[2]}-01`;
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

export async function getProviderMacList(
  providerInput: string,
  billingMonth: string
): Promise<ProviderMacList> {
  const provider = String(providerInput || "").trim().toLowerCase();
  if (!provider) throw new Error("Provider is required");
  if (provider.length > 10) throw new Error("Provider is invalid");
  const month = normalizeBillingMonth(billingMonth);

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

export async function syncProviderMacAddresses(
  providerInput: string,
  billingMonth: string
): Promise<ProviderMacSyncResult> {
  const provider = String(providerInput || "").trim().toLowerCase();
  if (!["myisp", "myisp2", "idm", "terra"].includes(provider)) {
    throw new Error("Live MAC sync is unavailable for this provider");
  }
  const month = normalizeBillingMonth(billingMonth);
  let providerMacs: Map<string, string>;
  if (provider === "myisp" || provider === "myisp2") {
    const account: MyISPAccount = provider === "myisp2" ? 2 : 1;
    providerMacs = await fetchMyISPProviderMacAddresses(account);
  } else {
    providerMacs = await fetchHsiProviderMacAddresses(provider as HsiProvider);
  }

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

  return {
    provider,
    billingMonth: month.slice(0, 7),
    providerMacs: providerMacs.size,
    matchedSubscribers: matchedSubscribers.size,
    updatedInvoiceRows: changed.length,
    missingSubscribers: invoiceSubscribers.size - matchedSubscribers.size,
  };
}
