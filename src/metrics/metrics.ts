import client from "prom-client";
import type { Request, Response, NextFunction } from "express";

export const register = client.register;

// Default process/runtime metrics
client.collectDefaultMetrics({
  register,
});

// HTTP metrics
const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Websocket clients gauge (set from server.ts)
const websocketClients = new client.Gauge({
  name: "websocket_clients",
  help: "Number of currently connected websocket clients",
  registers: [register],
});

/** Billing / RADIUS ops counters for Grafana SLOs */
const invoicePaymentsTotal = new client.Counter({
  name: "invoice_payments_total",
  help: "Invoice payment / collect / unpay outcomes",
  labelNames: ["kind", "result"] as const,
  registers: [register],
});

const sessionDisconnectsTotal = new client.Counter({
  name: "session_disconnects_total",
  help: "Session disconnect / CoA attempts",
  labelNames: ["method", "result"] as const,
  registers: [register],
});

const dunningRunsTotal = new client.Counter({
  name: "dunning_runs_total",
  help: "External invoice dunning job runs",
  labelNames: ["result"] as const,
  registers: [register],
});

const dunningActionsTotal = new client.Counter({
  name: "dunning_actions_total",
  help: "Dunning actions applied (remind/throttle/suspend)",
  labelNames: ["action"] as const,
  registers: [register],
});

const quotaResetsTotal = new client.Counter({
  name: "quota_resets_total",
  help: "Daily/monthly quota reset operations",
  labelNames: ["scope", "result"] as const,
  registers: [register],
});

/** Background job health, so a silent cron failure is visible in Grafana. */
const jobRunsTotal = new client.Counter({
  name: "job_runs_total",
  help: "Background job runs by job name and outcome",
  labelNames: ["job", "result"] as const,
  registers: [register],
});

const jobLastRunTimestamp = new client.Gauge({
  name: "job_last_run_timestamp_seconds",
  help: "Unix timestamp of the last completed run of each background job",
  labelNames: ["job"] as const,
  registers: [register],
});

export function setWebsocketClients(count: number) {
  websocketClients.set(count);
}

export function recordInvoicePayment(
  kind: "pay" | "collect" | "unpay" | "external_pay",
  result: "ok" | "error" | "idempotent"
) {
  invoicePaymentsTotal.inc({ kind, result });
}

export function recordSessionDisconnect(method: string, result: "ok" | "error") {
  sessionDisconnectsTotal.inc({ method: method || "unknown", result });
}

export function recordDunningRun(result: "ok" | "error", actions?: Record<string, number>) {
  dunningRunsTotal.inc({ result });
  if (actions) {
    for (const [action, count] of Object.entries(actions)) {
      if (count > 0) dunningActionsTotal.inc({ action }, count);
    }
  }
}

export function recordQuotaReset(scope: "daily" | "monthly", result: "ok" | "error") {
  quotaResetsTotal.inc({ scope, result });
}

/**
 * Records the outcome of a background job. The timestamp lets an alert fire on
 * "job has not completed successfully in N hours" rather than only on errors.
 */
export function recordJobRun(job: string, result: "ok" | "error") {
  jobRunsTotal.inc({ job, result });
  jobLastRunTimestamp.set({ job }, Date.now() / 1000);
}

function getRouteLabel(req: Request): string {
  const routePath = (req as any).route?.path;
  const baseUrl = req.baseUrl || "";
  if (routePath) return `${baseUrl}${routePath}`;
  return "unmatched";
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationSeconds = Number(durationNs) / 1e9;
    const labels = {
      method: req.method,
      route: getRouteLabel(req),
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });
  next();
}
