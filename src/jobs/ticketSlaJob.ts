/**
 * Flags tickets that have missed their SLA deadlines.
 *
 * The breach is recorded on the ticket and pushed to the assignee (or the
 * whole desk when nobody owns it) by the sweep itself, so the ticket list and
 * the phones agree on what just went red.
 */
import cron, { type ScheduledTask } from "node-cron";
import { runTicketSlaJob } from "../services/ticketService";

let slaTask: ScheduledTask | null = null;

export function startTicketSlaScheduler(): void {
  const cronExpr = String(process.env.TICKET_SLA_CRON ?? "*/5 * * * *").trim();

  if (!cronExpr || cronExpr === "off" || cronExpr === "0") {
    console.log("[ticket-sla] scheduler disabled (TICKET_SLA_CRON=off)");
    return;
  }

  if (slaTask) slaTask.stop();

  try {
    slaTask = cron.schedule(cronExpr, async () => {
      try {
        const result = await runTicketSlaJob();
        if (result.breached > 0) {
          console.warn(`[ticket-sla] ${result.breached} ticket(s) newly flagged as breached`);
        }
      } catch (err) {
        console.error("[ticket-sla] job execution failed:", err);
      }
    });
    console.log(`[ticket-sla] scheduler started with expression: "${cronExpr}"`);
  } catch (err) {
    console.error("[ticket-sla] failed to start cron scheduler:", err);
  }
}

export function stopTicketSlaScheduler(): void {
  if (slaTask) {
    slaTask.stop();
    slaTask = null;
  }
}
