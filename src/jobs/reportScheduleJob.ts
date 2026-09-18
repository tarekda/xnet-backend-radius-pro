/**
 * Cron scheduler for recurring report emails.
 *
 * Each enabled `report_schedules` row gets its own node-cron task. Tasks are
 * rebuilt from the database at boot and whenever a schedule is changed, so the
 * database stays the single source of truth.
 */
import cron, { type ScheduledTask } from "node-cron";
import { listEnabledReportSchedules, runReportSchedule } from "../services/reportScheduleService";

const tasks = new Map<number, ScheduledTask>();

/** Registers (or re-registers) the cron task for one schedule. */
export function registerReportScheduleTask(
  id: number,
  cronExpr: string,
  name: string
): boolean {
  unregisterReportScheduleTask(id);

  if (!cron.validate(cronExpr)) {
    console.warn(`[report-schedule] invalid cron for "${name}" (#${id}): ${cronExpr}`);
    return false;
  }

  const task = cron.schedule(
    cronExpr,
    async () => {
      try {
        const result = await runReportSchedule(id);
        if (result.sent) {
          console.log(
            `[report-schedule] "${name}" (#${id}) sent to ${result.recipients.join(", ")} (${result.rows} rows, ${result.durationMs}ms)`
          );
        } else {
          console.warn(`[report-schedule] "${name}" (#${id}) failed: ${result.reason}`);
        }
      } catch (err) {
        console.error(`[report-schedule] "${name}" (#${id}) threw:`, err);
      }
    },
    { name: `report-schedule-${id}`, noOverlap: true }
  );

  tasks.set(id, task);
  return true;
}

export function unregisterReportScheduleTask(id: number): void {
  const existing = tasks.get(id);
  if (!existing) return;
  try {
    existing.destroy();
  } catch {
    existing.stop();
  }
  tasks.delete(id);
}

/** Next fire time for a registered schedule, as an ISO string. */
export function getNextReportScheduleRun(id: number): string | null {
  const task = tasks.get(id);
  if (!task) return null;
  try {
    const next = task.getNextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/** Rebuilds every task from the database. Returns how many were registered. */
export async function reloadReportScheduleTasks(): Promise<number> {
  for (const id of Array.from(tasks.keys())) unregisterReportScheduleTask(id);

  if (process.env.REPORT_SCHEDULES_ENABLED === "0") {
    console.log("[report-schedule] scheduler disabled (REPORT_SCHEDULES_ENABLED=0)");
    return 0;
  }

  const schedules = await listEnabledReportSchedules();
  let registered = 0;
  for (const schedule of schedules) {
    if (!schedule.id) continue;
    if (registerReportScheduleTask(schedule.id, schedule.cronExpr, schedule.name)) {
      registered += 1;
    }
  }
  return registered;
}

export async function startReportScheduleScheduler(): Promise<void> {
  try {
    const registered = await reloadReportScheduleTasks();
    console.log(`[report-schedule] scheduler enabled: ${registered} schedule(s) registered`);
  } catch (err) {
    console.error("[report-schedule] failed to load schedules:", err);
  }
}

export function stopReportScheduleScheduler(): void {
  for (const id of Array.from(tasks.keys())) unregisterReportScheduleTask(id);
}
