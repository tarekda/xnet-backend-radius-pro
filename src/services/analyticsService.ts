import { AppDataSource } from "../db/config";
import { ConnectionLogs } from "../db/entities/ConnectionLogs";
import { Radacct } from "../db/entities/Radacct";
import { sqlRadacctIsActive, sqlRadacctIsOnline, readOnlineSessionConfig } from "../utils/onlineSessionPolicy";

export type AnalyticsRange = "1h" | "24h" | "7d" | "30d";

const RANGE_MS: Record<AnalyticsRange, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const STATUS_COLORS: Record<string, string> = {
  accepted: "#10b981",
  Success: "#10b981",
  rejected: "#ef4444",
  Failed: "#ef4444",
  timeout: "#f59e0b",
  Timeout: "#f59e0b",
  error: "#8b5cf6",
  attempt: "#3b82f6",
};

const NAS_COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

function parseRange(raw: string | undefined): AnalyticsRange {
  const v = String(raw || "24h").toLowerCase();
  if (v === "1h" || v === "24h" || v === "7d" || v === "30d") return v;
  return "24h";
}

function bucketMs(range: AnalyticsRange): number {
  if (range === "1h") return 60 * 1000;
  if (range === "30d") return 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function formatBucketLabel(d: Date, range: AnalyticsRange): string {
  if (range === "1h") {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "30d") {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit" });
}

function growthPct(curr: number, prev: number): number {
  if (prev <= 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

export async function getUsageSeries(rangeRaw?: string) {
  const range = parseRange(rangeRaw);
  const now = Date.now();
  const windowMs = RANGE_MS[range];
  const step = bucketMs(range);
  const start = new Date(now - windowMs);

  const clRepo = AppDataSource.getRepository(ConnectionLogs);

  const authRows = await clRepo
    .createQueryBuilder("cl")
    .select("FLOOR(UNIX_TIMESTAMP(cl.timestamp) / :stepSec) * :stepSec", "bucket")
    .addSelect("COALESCE(SUM(cl.status = 'accepted'), 0)", "authSuccess")
    .addSelect("COALESCE(SUM(cl.status = 'rejected'), 0)", "authFailed")
    .addSelect("COUNT(DISTINCT CASE WHEN cl.status = 'accepted' THEN cl.username END)", "users")
    .where("cl.timestamp >= :start", { start })
    .setParameter("stepSec", Math.floor(step / 1000))
    .groupBy("bucket")
    .orderBy("bucket", "ASC")
    .getRawMany<{ bucket: string; authSuccess: string; authFailed: string; users: string }>();

  const usageRows = await AppDataSource.createQueryBuilder()
    .from("session_usage_snapshots", "sus")
    .select("FLOOR(UNIX_TIMESTAMP(sus.snapshot_at) / :stepSec) * :stepSec", "bucket")
    .addSelect("COALESCE(SUM(sus.delta_total), 0)", "bandwidth")
    .where("sus.snapshot_at >= :start", { start })
    .setParameter("stepSec", Math.floor(step / 1000))
    .groupBy("bucket")
    .orderBy("bucket", "ASC")
    .getRawMany<{ bucket: string; bandwidth: string }>();

  const authMap = new Map<number, { authSuccess: number; authFailed: number; users: number }>();
  for (const r of authRows) {
    const b = Number(r.bucket) * 1000;
    authMap.set(b, {
      authSuccess: Number(r.authSuccess ?? 0),
      authFailed: Number(r.authFailed ?? 0),
      users: Number(r.users ?? 0),
    });
  }
  const bwMap = new Map<number, number>();
  for (const r of usageRows) {
    bwMap.set(Number(r.bucket) * 1000, Number(r.bandwidth ?? 0) / (1024 * 1024)); // MB
  }

  const points: Array<{
    time: string;
    users: number;
    bandwidth: number;
    authSuccess: number;
    authFailed: number;
  }> = [];

  const alignedStart = Math.floor(start.getTime() / step) * step;
  for (let t = alignedStart; t <= now; t += step) {
    const auth = authMap.get(t) || { authSuccess: 0, authFailed: 0, users: 0 };
    points.push({
      time: formatBucketLabel(new Date(t), range),
      users: auth.users,
      bandwidth: Math.round((bwMap.get(t) || 0) * 10) / 10,
      authSuccess: auth.authSuccess,
      authFailed: auth.authFailed,
    });
  }

  return points;
}

export async function getAnalyticsMetrics() {
  const windowSeconds = 86400;
  const now = Date.now();
  const windowStart = new Date(now - windowSeconds * 1000);
  const prevStart = new Date(now - windowSeconds * 2 * 1000);
  const prevEnd = windowStart;

  const { staleCutoff, activeCutoff } = readOnlineSessionConfig();
  const raRepo = AppDataSource.getRepository(Radacct);

  const activeRow = await raRepo
    .createQueryBuilder("ra")
    .select("COUNT(DISTINCT ra.username)", "cnt")
    .where(sqlRadacctIsActive("ra"))
    .setParameters({ staleCutoff, activeCutoff })
    .getRawOne<{ cnt: string }>();

  const onlineRow = await raRepo
    .createQueryBuilder("ra")
    .select("COUNT(DISTINCT ra.username)", "cnt")
    .where(sqlRadacctIsOnline("ra"))
    .setParameters({ staleCutoff, activeCutoff })
    .getRawOne<{ cnt: string }>();

  const clRepo = AppDataSource.getRepository(ConnectionLogs);
  const getCounts = async (start: Date, end: Date) => {
    const row = await clRepo
      .createQueryBuilder("cl")
      .select("COALESCE(SUM(cl.status = 'attempt'), 0)", "attempts")
      .addSelect("COALESCE(SUM(cl.status = 'accepted'), 0)", "accepted")
      .addSelect("COALESCE(SUM(cl.status = 'rejected'), 0)", "rejected")
      .where("cl.timestamp >= :start", { start })
      .andWhere("cl.timestamp < :end", { end })
      .getRawOne<{ attempts: string; accepted: string; rejected: string }>();
    return {
      attempts: Number(row?.attempts ?? 0),
      accepted: Number(row?.accepted ?? 0),
      rejected: Number(row?.rejected ?? 0),
    };
  };

  const current = await getCounts(windowStart, new Date(now));
  const previous = await getCounts(prevStart, prevEnd);

  const bwCurrent = await AppDataSource.createQueryBuilder()
    .from("session_usage_snapshots", "sus")
    .select("COALESCE(SUM(sus.delta_total), 0)", "bytes")
    .where("sus.snapshot_at >= :start", { start: windowStart })
    .getRawOne<{ bytes: string }>();
  const bwPrev = await AppDataSource.createQueryBuilder()
    .from("session_usage_snapshots", "sus")
    .select("COALESCE(SUM(sus.delta_total), 0)", "bytes")
    .where("sus.snapshot_at >= :start", { start: prevStart })
    .andWhere("sus.snapshot_at < :end", { end: prevEnd })
    .getRawOne<{ bytes: string }>();

  const bwCurrBytes = Number(bwCurrent?.bytes ?? 0);
  const bwPrevBytes = Number(bwPrev?.bytes ?? 0);
  const bwGb = bwCurrBytes / (1024 * 1024 * 1024);
  const authSuccessRate =
    current.accepted + current.rejected > 0
      ? (current.accepted / (current.accepted + current.rejected)) * 100
      : 100;
  const prevAuthRate =
    previous.accepted + previous.rejected > 0
      ? (previous.accepted / (previous.accepted + previous.rejected)) * 100
      : 100;

  const activeUsers = Number(activeRow?.cnt ?? onlineRow?.cnt ?? 0);

  const distinctUsers = async (start: Date, end: Date) => {
    const row = await clRepo
      .createQueryBuilder("cl")
      .select("COUNT(DISTINCT cl.username)", "cnt")
      .where("cl.timestamp >= :start", { start })
      .andWhere("cl.timestamp < :end", { end })
      .andWhere("cl.status = 'accepted'")
      .getRawOne<{ cnt: string }>();
    return Number(row?.cnt ?? 0);
  };
  const usersCurr = await distinctUsers(windowStart, new Date(now));
  const usersPrev = await distinctUsers(prevStart, prevEnd);

  return {
    activeUsers,
    bandwidthUsage: `${bwGb.toFixed(2)} GB/day`,
    authSuccessRate: Math.round(authSuccessRate * 10) / 10,
    failedAttempts: current.rejected,
    userGrowth: Math.round(growthPct(usersCurr, usersPrev) * 10) / 10,
    bandwidthGrowth: Math.round(growthPct(bwCurrBytes, bwPrevBytes) * 10) / 10,
    authRateGrowth: Math.round(growthPct(authSuccessRate, prevAuthRate) * 10) / 10,
    failedAttemptsGrowth: Math.round(growthPct(current.rejected, previous.rejected) * 10) / 10,
  };
}

export async function getAuthDistribution() {
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await AppDataSource.getRepository(ConnectionLogs)
    .createQueryBuilder("cl")
    .select("cl.status", "status")
    .addSelect("COUNT(*)", "cnt")
    .where("cl.timestamp >= :start", { start })
    .andWhere("cl.status IN ('accepted', 'rejected', 'timeout', 'error')")
    .groupBy("cl.status")
    .getRawMany<{ status: string; cnt: string }>();

  const labelMap: Record<string, string> = {
    accepted: "Success",
    rejected: "Failed",
    timeout: "Timeout",
    error: "Error",
  };

  return rows.map((r) => {
    const name = labelMap[r.status] || r.status;
    return {
      name,
      value: Number(r.cnt ?? 0),
      color: STATUS_COLORS[name] || STATUS_COLORS[r.status] || "#64748b",
    };
  });
}

export async function getGeographicByNas(limit = 10) {
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await AppDataSource.getRepository(ConnectionLogs)
    .createQueryBuilder("cl")
    .select("COALESCE(cl.nas_ip, 'unknown')", "nas")
    .addSelect("COUNT(DISTINCT cl.username)", "users")
    .where("cl.timestamp >= :start", { start })
    .andWhere("cl.status = 'accepted'")
    .groupBy("nas")
    .orderBy("users", "DESC")
    .limit(limit)
    .getRawMany<{ nas: string; users: string }>();

  return rows.map((r, i) => ({
    name: r.nas || "unknown",
    users: Number(r.users ?? 0),
    color: NAS_COLORS[i % NAS_COLORS.length],
  }));
}

export async function getPeakHours() {
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await AppDataSource.getRepository(ConnectionLogs)
    .createQueryBuilder("cl")
    .select("HOUR(cl.timestamp)", "hour")
    .addSelect("COUNT(*)", "usage")
    .where("cl.timestamp >= :start", { start })
    .groupBy("hour")
    .orderBy("hour", "ASC")
    .getRawMany<{ hour: string; usage: string }>();

  const byHour = new Map<number, number>();
  for (const r of rows) {
    byHour.set(Number(r.hour), Number(r.usage ?? 0));
  }

  return Array.from({ length: 24 }, (_, hour) => ({
    hour: `${hour}:00`,
    usage: byHour.get(hour) || 0,
  }));
}

export { parseRange };
