/**
 * externalUsersService.ts
 * Fetches subscriber lists from all configured external providers in parallel,
 * normalises them into a unified ExternalUser shape, and cross-references each
 * username against the local RADIUS radacct table to determine online status.
 */
import { AppDataSource } from "../db/config";
import { Radacct } from "../db/entities/Radacct";
import { readOnlineSessionConfig, sqlRadacctIsOnline } from "../utils/onlineSessionPolicy";
import { Logger } from "../logging/logging";

const logger = Logger.getInstance();

export type ExternalUserProvider = "myisp" | "myisp2" | "idm" | "terra" | "terra2" | "misp";

export interface ExternalUser {
  username: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  address: string | null;
  plan: string | null;
  expiryDate: string | null;
  macAddress: string | null;
  provider: ExternalUserProvider;
  providerLabel: string;
  /** Populated by cross-reference with local radacct */
  online: boolean;
  /** Populated by cross-reference with local radacct */
  sessionIp: string | null;
  sessionStarted: string | null;
}

export interface ProviderResult {
  provider: ExternalUserProvider;
  label: string;
  users: ExternalUser[];
  error: string | null;
  fetchedAt: string;
}

export interface ExternalUsersResult {
  providers: ProviderResult[];
  totalUsers: number;
  totalOnline: number;
  fetchedAt: string;
}

// ─── Provider config guards ───────────────────────────────────────────────────

function isMyISPConfigured(account: 1 | 2): boolean {
  const prefix = `MYISP_${account}_`;
  return (
    Boolean(process.env[`${prefix}USERNAME`]?.trim()) &&
    Boolean(process.env[`${prefix}PASSWORD`]?.trim())
  );
}

function isHsiConfigured(provider: "IDM" | "TERRA" | "TERRA2" | "MISP"): boolean {
  return (
    Boolean(process.env[`${provider}_USERNAME`]?.trim()) &&
    Boolean(process.env[`${provider}_PASSWORD`]?.trim())
  );
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchMyISPUsers(account: 1 | 2): Promise<ExternalUser[]> {
  // Dynamically import to avoid loading if not needed
  const { fetchAuthenticatedMyISPRows } = await import("./externalUsersProviders");
  return fetchAuthenticatedMyISPRows(account);
}

async function fetchHsiUsers(provider: "idm" | "terra" | "terra2" | "misp"): Promise<ExternalUser[]> {
  const { fetchAuthenticatedHsiRows } = await import("./externalUsersProviders");
  return fetchAuthenticatedHsiRows(provider);
}

// ─── Online status cross-reference ───────────────────────────────────────────

async function buildOnlineUsernameMap(): Promise<Map<string, { ip: string | null; started: string | null }>> {
  const map = new Map<string, { ip: string | null; started: string | null }>();
  try {
    const { staleCutoff, activeCutoff } = readOnlineSessionConfig();
    const repo = AppDataSource.getRepository(Radacct);
    const rows = await repo
      .createQueryBuilder("ra")
      .select("ra.username", "username")
      .addSelect("ra.framedipaddress", "ip")
      .addSelect("ra.acctstarttime", "started")
      .where(sqlRadacctIsOnline("ra"))
      .setParameters({ staleCutoff, activeCutoff })
      .distinctOn(["ra.username"])
      .orderBy("ra.username")
      .addOrderBy("ra.acctstarttime", "DESC")
      .getRawMany<{ username: string; ip: string | null; started: string | null }>();

    for (const row of rows) {
      if (row.username) {
        map.set(row.username.toLowerCase(), { ip: row.ip ?? null, started: row.started ?? null });
      }
    }
  } catch (err: any) {
    logger.warn("[externalUsersService] Failed to query online users:", err?.message);
  }
  return map;
}

function enrichWithOnlineStatus(users: ExternalUser[], onlineMap: Map<string, { ip: string | null; started: string | null }>): ExternalUser[] {
  return users.map((u) => {
    // If the provider already reported this user as online (e.g. MyISP embeds status in their API),
    // trust that and don't override with the local RADIUS lookup.
    if (u.online) return u;
    const session = onlineMap.get(u.username.toLowerCase());
    if (session) {
      return { ...u, online: true, sessionIp: session.ip, sessionStarted: session.started };
    }
    return u;
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function fetchExternalUsers(opts: {
  providers?: ExternalUserProvider[];
}): Promise<ExternalUsersResult> {
  const wantedProviders = opts.providers ?? (["myisp", "myisp2", "idm", "terra", "terra2", "misp"] as ExternalUserProvider[]);
  const fetchedAt = new Date().toISOString();

  const providerJobs: Array<{ provider: ExternalUserProvider; label: string; job: Promise<ExternalUser[]> }> = [];

  if (wantedProviders.includes("myisp") && isMyISPConfigured(1)) {
    providerJobs.push({ provider: "myisp", label: "MyISP Account 1", job: fetchMyISPUsers(1) });
  }
  if (wantedProviders.includes("myisp2") && isMyISPConfigured(2)) {
    providerJobs.push({ provider: "myisp2", label: "MyISP Account 2", job: fetchMyISPUsers(2) });
  }
  if (wantedProviders.includes("idm") && isHsiConfigured("IDM")) {
    providerJobs.push({ provider: "idm", label: "IDM HSI Pro", job: fetchHsiUsers("idm") });
  }
  if (wantedProviders.includes("terra") && isHsiConfigured("TERRA")) {
    providerJobs.push({ provider: "terra", label: "Terra ACP Pro 1", job: fetchHsiUsers("terra") });
  }
  if (wantedProviders.includes("terra2") && isHsiConfigured("TERRA2")) {
    providerJobs.push({ provider: "terra2", label: "Terra ACP Pro 2", job: fetchHsiUsers("terra2") });
  }
  if (wantedProviders.includes("misp") && isHsiConfigured("MISP")) {
    providerJobs.push({ provider: "misp", label: "MISP Cloud", job: fetchHsiUsers("misp") });
  }

  // Run all providers in parallel + build online map concurrently
  const [settled, onlineMap] = await Promise.all([
    Promise.allSettled(providerJobs.map((j) => j.job)),
    buildOnlineUsernameMap(),
  ]);

  const providerResults: ProviderResult[] = settled.map((result, idx) => {
    const { provider, label } = providerJobs[idx];
    if (result.status === "fulfilled") {
      const enriched = enrichWithOnlineStatus(result.value, onlineMap);
      return { provider, label, users: enriched, error: null, fetchedAt };
    }
    logger.warn(`[externalUsersService] Provider ${provider} failed:`, (result.reason as any)?.message);
    return { provider, label, users: [], error: String((result.reason as any)?.message ?? "Unknown error"), fetchedAt };
  });

  const totalUsers = providerResults.reduce((acc, p) => acc + p.users.length, 0);
  const totalOnline = providerResults.reduce((acc, p) => acc + p.users.filter((u) => u.online).length, 0);

  return { providers: providerResults, totalUsers, totalOnline, fetchedAt };
}
