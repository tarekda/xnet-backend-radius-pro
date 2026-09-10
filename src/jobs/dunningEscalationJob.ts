import cron, { ScheduledTask } from "node-cron";
import { AppDataSource } from "../db/config";
import { runExternalDunningSystemJob } from "../controllers/invoiceController";

export interface DunningEscalationJobResult {
  attempted: number;
  sent: number;
  failed: number;
  actionSummary: Record<string, number>;
  executedAt: string;
}

let dunningCronTask: ScheduledTask | null = null;
let isJobRunning = false;

/**
 * Runs the automated enterprise dunning escalation workflow:
 * - Scans overdue external invoices past their grace period
 * - Executes tiered actions: gentle reminder, formal overdue notice, speed throttling, or disconnection
 * - Emits audit logs and delivery metrics
 */
export async function runDunningEscalationJob(): Promise<DunningEscalationJobResult> {
  if (!AppDataSource.isInitialized) {
    console.warn("[dunning-escalation-job] skipped: database not initialized");
    return { attempted: 0, sent: 0, failed: 0, actionSummary: {}, executedAt: new Date().toISOString() };
  }

  if (isJobRunning) {
    console.warn("[dunning-escalation-job] previous dunning run still in progress, skipping concurrent execution");
    return { attempted: 0, sent: 0, failed: 0, actionSummary: {}, executedAt: new Date().toISOString() };
  }

  isJobRunning = true;
  const startedAt = Date.now();
  console.log("[dunning-escalation-job] Starting scheduled dunning escalation run...");

  try {
    const result = await runExternalDunningSystemJob();
    const durationMs = Date.now() - startedAt;

    console.log(
      `[dunning-escalation-job] Completed in ${durationMs}ms: attempted=${result.attempted}, sent=${result.sent}, failed=${result.failed}`
    );

    return {
      attempted: result.attempted,
      sent: result.sent,
      failed: result.failed,
      actionSummary: result.actionSummary || {},
      executedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[dunning-escalation-job] Error during scheduled dunning run:", error);
    throw error;
  } finally {
    isJobRunning = false;
  }
}

/**
 * Starts the cron scheduler for automated dunning escalation.
 * Default schedule: Daily at 09:00 AM (0 9 * * *)
 */
export function startDunningEscalationScheduler(): void {
  const cronExpr = String(process.env.DUNNING_ESCALATION_CRON ?? process.env.DUNNING_CRON ?? "0 9 * * *").trim();

  if (!cronExpr || cronExpr.toLowerCase() === "off" || cronExpr === "0") {
    console.log("[dunning-escalation-job] scheduler disabled via configuration");
    return;
  }

  if (!cron.validate(cronExpr)) {
    console.error(`[dunning-escalation-job] Invalid cron expression: "${cronExpr}"`);
    return;
  }

  try {
    dunningCronTask = cron.schedule(cronExpr, async () => {
      try {
        await runDunningEscalationJob();
      } catch (err) {
        console.error("[dunning-escalation-job] execution error:", err);
      }
    });

    console.log(`[dunning-escalation-job] scheduler active on expression: "${cronExpr}"`);
  } catch (err) {
    console.error("[dunning-escalation-job] failed to start scheduler:", err);
  }
}

/**
 * Stops the dunning escalation scheduler during graceful shutdown.
 */
export function stopDunningEscalationScheduler(): void {
  if (dunningCronTask) {
    dunningCronTask.stop();
    dunningCronTask = null;
    console.log("[dunning-escalation-job] scheduler stopped");
  }
}
