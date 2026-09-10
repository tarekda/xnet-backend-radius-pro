import cron, { ScheduledTask } from "node-cron";
import { AppDataSource } from "../db/config";
import { runRevenueLeakageAudit, AuditRunResult } from "../services/revenueLeakageAuditService";

let leakageAuditTask: ScheduledTask | null = null;
let isJobRunning = false;

/**
 * Runs the automated background revenue leakage and ghost session audit.
 */
export async function executeScheduledRevenueLeakageAudit(): Promise<AuditRunResult | null> {
  if (!AppDataSource.isInitialized) {
    console.warn("[revenue-leakage-job] skipped: database not initialized yet");
    return null;
  }

  if (isJobRunning) {
    console.warn("[revenue-leakage-job] previous audit still in progress, skipping concurrent execution");
    return null;
  }

  isJobRunning = true;
  console.log("[revenue-leakage-job] Starting scheduled revenue leakage network audit...");

  try {
    const autoRemediate = process.env.REVENUE_LEAKAGE_AUTO_REMEDIATE === "true";
    const result = await runRevenueLeakageAudit({
      autoRemediate,
      actor: "revenue_leakage_cron_job",
    });

    console.log(
      `[revenue-leakage-job] Audit completed in ${result.durationMs}ms: inspected=${result.totalInspected}, leaks=${result.leaksDetected}, estimatedLoss=$${result.totalEstimatedLossUsd}, remediated=${result.remediatedCount}`
    );

    return result;
  } catch (error) {
    console.error("[revenue-leakage-job] Error during scheduled audit:", error);
    return null;
  } finally {
    isJobRunning = false;
  }
}

/**
 * Starts the revenue leakage audit scheduler. Default: every 2 hours (0 *\/2 * * *).
 */
export function startRevenueLeakageAuditScheduler(): void {
  const cronExpr = String(process.env.REVENUE_LEAKAGE_AUDIT_CRON || "0 */2 * * *").trim();

  if (leakageAuditTask) {
    leakageAuditTask.stop();
    leakageAuditTask = null;
  }

  try {
    leakageAuditTask = cron.schedule(cronExpr, async () => {
      await executeScheduledRevenueLeakageAudit();
    });
    console.log(`[revenue-leakage-job] scheduler active on expression: "${cronExpr}"`);
  } catch (err) {
    console.error(`[revenue-leakage-job] Failed to schedule cron with expression "${cronExpr}":`, err);
  }
}

export function stopRevenueLeakageAuditScheduler(): void {
  if (leakageAuditTask) {
    leakageAuditTask.stop();
    leakageAuditTask = null;
    console.log("[revenue-leakage-job] scheduler stopped");
  }
}
