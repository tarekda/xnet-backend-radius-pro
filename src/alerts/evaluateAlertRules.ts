import os from "os";
import { AppDataSource } from "../db/config";
import { AlertIncident } from "../db/entities/AlertIncident";
import { AlertRule } from "../db/entities/AlertRule";
import { ConnectionLogs } from "../db/entities/ConnectionLogs";
import { Radacct } from "../db/entities/Radacct";
import { readOnlineSessionConfig, sqlRadacctIsOnline } from "../utils/onlineSessionPolicy";
import {
  evaluateCondition,
  formatAlertMessage,
  type AlertMetricType,
} from "./alertMetrics";
import { alertChannelService } from "./alertChannelService";

const EVAL_MIN_INTERVAL_MS = 20_000;
let lastEvalAt = 0;
let evalInFlight: Promise<void> | null = null;

async function countOnlineUsers(): Promise<number> {
  const { staleCutoff, activeCutoff } = readOnlineSessionConfig();
  const row = await AppDataSource.getRepository(Radacct)
    .createQueryBuilder("ra")
    .select("COUNT(*)", "cnt")
    .where(sqlRadacctIsOnline("ra"))
    .setParameters({ staleCutoff, activeCutoff })
    .getRawOne<{ cnt: string }>();
  return Number(row?.cnt ?? 0);
}

async function countAuthByStatus(
  since: Date,
  statuses: Array<ConnectionLogs["status"]>
): Promise<number> {
  const row = await AppDataSource.getRepository(ConnectionLogs)
    .createQueryBuilder("cl")
    .select("COUNT(*)", "cnt")
    .where("cl.timestamp >= :since", { since })
    .andWhere("cl.status IN (:...statuses)", { statuses })
    .getRawOne<{ cnt: string }>();
  return Number(row?.cnt ?? 0);
}

function cpuUsagePercent(): number {
  const cpus = os.cpus();
  if (!cpus.length) return 0;
  const load = os.loadavg()[0] ?? 0;
  return Math.round(Math.min(100, (load / cpus.length) * 100) * 10) / 10;
}

function memoryUsagePercent(): number {
  const total = os.totalmem();
  if (!total) return 0;
  const used = total - os.freemem();
  return Math.round((used / total) * 1000) / 10;
}

async function readMetricValue(
  metric: string,
  durationMinutes: number
): Promise<number | null> {
  const windowMin = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 5;
  const since = new Date(Date.now() - windowMin * 60 * 1000);

  switch (metric as AlertMetricType) {
    case "users":
      return countOnlineUsers();
    case "auth_failed_attempts":
      return countAuthByStatus(since, ["rejected", "timeout", "error"]);
    case "auth_success_rate": {
      const accepted = await countAuthByStatus(since, ["accepted"]);
      const failed = await countAuthByStatus(since, ["rejected", "timeout", "error"]);
      const total = accepted + failed;
      if (total <= 0) return null;
      return Math.round((accepted / total) * 1000) / 10;
    }
    case "cpu_usage":
      return cpuUsagePercent();
    case "memory_usage":
      return memoryUsagePercent();
    case "bandwidth":
    case "disk_usage":
      return null;
    default:
      return null;
  }
}

async function evaluateOnce(): Promise<void> {
  if (!AppDataSource.isInitialized) return;

  const ruleRepo = AppDataSource.getRepository(AlertRule);
  const incidentRepo = AppDataSource.getRepository(AlertIncident);
  const rules = await ruleRepo
    .createQueryBuilder("r")
    .where("r.enabled = 1")
    .getMany();
  if (!rules.length) return;

  for (const rule of rules) {
    try {
      const value = await readMetricValue(rule.metric, rule.duration);
      if (value === null) continue;
      if (!evaluateCondition(rule.condition, value, Number(rule.threshold))) continue;

      const open = await incidentRepo
        .createQueryBuilder("i")
        .where("i.rule_id = :ruleId", { ruleId: rule.id })
        .andWhere("i.resolved = 0")
        .orderBy("i.timestamp", "DESC")
        .getOne();
      if (open) continue;

      const now = new Date();
      const savedIncident = await incidentRepo.save(
        incidentRepo.create({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: formatAlertMessage(rule.metric, value, Number(rule.threshold), rule.condition),
          metric: rule.metric,
          value,
          threshold: Number(rule.threshold),
          timestamp: now,
          acknowledged: false,
          resolved: false,
        })
      );

      // Asynchronously dispatch multi-channel notification
      void alertChannelService.dispatchToAllChannels(savedIncident, "created").catch((e) => {
        console.warn("[alerts] multi-channel dispatch failed:", e);
      });

      rule.lastTriggered = now;
      rule.triggerCount = Number(rule.triggerCount || 0) + 1;
      rule.updatedAt = now;
      await ruleRepo.save(rule);
    } catch (err) {
      console.warn("[alerts] rule evaluation skipped", {
        ruleId: rule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function evaluateAlertRules(): Promise<void> {
  lastEvalAt = Date.now();
  await evaluateOnce();
  void alertChannelService.checkAndEscalateUnacknowledgedIncidents().catch((e) => {
    console.warn("[alerts] incident escalation check failed:", e);
  });
}

/** Used by GET /alerts so the UI sees fresh incidents without a dedicated worker. */
export async function evaluateAlertRulesIfStale(): Promise<void> {
  if (Date.now() - lastEvalAt < EVAL_MIN_INTERVAL_MS) return;
  if (evalInFlight) {
    await evalInFlight;
    return;
  }
  evalInFlight = evaluateAlertRules().finally(() => {
    evalInFlight = null;
  });
  await evalInFlight;
}
