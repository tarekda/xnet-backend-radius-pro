import cron, { ScheduledTask } from "node-cron";
import { AppDataSource } from "../db/config";
import { AlertIncident } from "../db/entities/AlertIncident";
import { redisClient } from "../redisClient";
import { alertNotificationService } from "../services/alertNotificationService";

const memoryEscalationState = new Map<number, { count: number; lastEscalatedAt: number }>();

const SEVERITY_LADDER: Record<string, string> = {
  low: "medium",
  medium: "high",
  high: "critical",
  critical: "critical",
};

interface EscalationRecord {
  count: number;
  lastEscalatedAt: number;
}

async function getEscalationState(incidentId: number): Promise<EscalationRecord> {
  const redisKey = `alert:escalation:${incidentId}`;
  try {
    if (redisClient && redisClient.isReady) {
      const raw = await redisClient.get(redisKey);
      if (raw) return JSON.parse(raw);
    }
  } catch (err) {
    // fallback to memory
  }
  return memoryEscalationState.get(incidentId) || { count: 0, lastEscalatedAt: 0 };
}

async function setEscalationState(incidentId: number, state: EscalationRecord): Promise<void> {
  const redisKey = `alert:escalation:${incidentId}`;
  try {
    if (redisClient && redisClient.isReady) {
      await redisClient.set(redisKey, JSON.stringify(state), { EX: 86400 * 7 }); // 7 days TTL
    }
  } catch (err) {
    // fallback to memory
  }
  memoryEscalationState.set(incidentId, state);
}

/**
 * Periodically checks for open, unacknowledged alert incidents that exceed
 * the configured escalation delay and escalates their severity + dispatches webhooks.
 */
export async function runAlertEscalationJob(): Promise<{
  checked: number;
  escalated: number;
  skipped: number;
}> {
  if (!AppDataSource.isInitialized) {
    return { checked: 0, escalated: 0, skipped: 0 };
  }

  const settings = await alertNotificationService.getSettings();
  const policy = settings.escalationPolicy;

  if (!policy?.enabled) {
    return { checked: 0, escalated: 0, skipped: 0 };
  }

  const escalationDelayMin = Math.max(1, Number(policy.escalationDelay) || 30);
  const maxEscalations = Math.max(1, Number(policy.maxEscalations) || 3);
  const escalationDelayMs = escalationDelayMin * 60 * 1000;

  const incidentRepo = AppDataSource.getRepository(AlertIncident);

  // Fetch open incidents: unacknowledged and unresolved
  const openIncidents = await incidentRepo
    .createQueryBuilder("i")
    .where("i.acknowledged = 0")
    .andWhere("i.resolved = 0")
    .orderBy("i.timestamp", "ASC")
    .take(100)
    .getMany();

  if (openIncidents.length === 0) {
    return { checked: 0, escalated: 0, skipped: 0 };
  }

  const now = Date.now();
  let escalatedCount = 0;
  let skippedCount = 0;

  for (const incident of openIncidents) {
    const incidentAgeMs = now - new Date(incident.timestamp).getTime();

    // Incident hasn't reached delay threshold yet
    if (incidentAgeMs < escalationDelayMs) {
      skippedCount++;
      continue;
    }

    const state = await getEscalationState(incident.id);

    // Check if max escalations reached
    if (state.count >= maxEscalations) {
      skippedCount++;
      continue;
    }

    // Check if enough time has elapsed since previous escalation
    if (state.lastEscalatedAt > 0 && now - state.lastEscalatedAt < escalationDelayMs) {
      skippedCount++;
      continue;
    }

    // Escalate severity
    const nextSeverity = SEVERITY_LADDER[incident.severity] || "critical";
    const previousSeverity = incident.severity;
    incident.severity = nextSeverity;

    try {
      await incidentRepo.save(incident);

      const nextCount = state.count + 1;
      const unackMin = Math.round(incidentAgeMs / 60000);

      await setEscalationState(incident.id, {
        count: nextCount,
        lastEscalatedAt: now,
      });

      console.warn(
        `[alert-escalation] escalated incident #${incident.id} "${incident.ruleName}" (${previousSeverity} -> ${nextSeverity}) [escalation ${nextCount}/${maxEscalations}, unacknowledged for ${unackMin}m]`
      );

      // Dispatch escalation notification via webhook
      await alertNotificationService.sendAlertWebhook(incident, "escalated", {
        level: nextCount,
        unacknowledgedMinutes: unackMin,
      });

      escalatedCount++;
    } catch (err) {
      console.error(`[alert-escalation] failed to escalate incident #${incident.id}:`, err);
    }
  }

  return { checked: openIncidents.length, escalated: escalatedCount, skipped: skippedCount };
}

let escalationCronTask: ScheduledTask | null = null;

export function startAlertEscalationScheduler(): void {
  const cronExpr = String(process.env.ALERT_ESCALATION_CRON ?? "*/2 * * * *").trim();

  if (!cronExpr || cronExpr === "off" || cronExpr === "0") {
    console.log("[alert-escalation] scheduler disabled (ALERT_ESCALATION_CRON=off)");
    return;
  }

  if (escalationCronTask) {
    escalationCronTask.stop();
  }

  try {
    escalationCronTask = cron.schedule(cronExpr, async () => {
      try {
        await runAlertEscalationJob();
      } catch (e) {
        console.error("[alert-escalation] job execution failed:", e);
      }
    });
    console.log(`[alert-escalation] scheduler started with expression: "${cronExpr}"`);
  } catch (err) {
    console.error("[alert-escalation] failed to start cron scheduler:", err);
  }
}

export function stopAlertEscalationScheduler(): void {
  if (escalationCronTask) {
    escalationCronTask.stop();
    escalationCronTask = null;
  }
}
