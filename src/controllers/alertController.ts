import { Request, Response } from "express";
import { AppDataSource } from "../db/config";
import { AlertIncident } from "../db/entities/AlertIncident";
import { AlertRule } from "../db/entities/AlertRule";
import { AlertSettings } from "../db/entities/AlertSettings";
import {
  DEFAULT_ALERT_SETTINGS,
  isAlertCondition,
  isAlertSeverity,
  mergeAlertSettings,
  parseMetricType,
  toMetricObject,
  type AlertSettingsPayload,
} from "../alerts/alertMetrics";
import { evaluateAlertRulesIfStale } from "../alerts/evaluateAlertRules";
import { alertNotificationService } from "../services/alertNotificationService";

function serializeRule(rule: AlertRule) {
  return {
    id: String(rule.id),
    name: rule.name,
    description: rule.description || "",
    metric: toMetricObject(rule.metric),
    condition: rule.condition,
    threshold: Number(rule.threshold),
    duration: Number(rule.duration),
    severity: rule.severity,
    enabled: Boolean(rule.enabled),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    lastTriggered: rule.lastTriggered || undefined,
    triggerCount: Number(rule.triggerCount || 0),
  };
}

function serializeIncident(row: AlertIncident) {
  return {
    id: String(row.id),
    ruleId: row.ruleId != null ? String(row.ruleId) : "test",
    ruleName: row.ruleName,
    severity: row.severity,
    message: row.message,
    metric: row.metric,
    value: Number(row.value),
    threshold: Number(row.threshold),
    timestamp: row.timestamp,
    acknowledged: Boolean(row.acknowledged),
    acknowledgedBy: row.acknowledgedBy || undefined,
    acknowledgedAt: row.acknowledgedAt || undefined,
    resolved: Boolean(row.resolved),
    resolvedAt: row.resolvedAt || undefined,
  };
}

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function actorFromRequest(req: Request, bodyActor?: unknown): string {
  const fromUser = String((req.user as { username?: string } | undefined)?.username || "").trim();
  if (fromUser) return fromUser;
  const fromBody = typeof bodyActor === "string" ? bodyActor.trim() : "";
  return fromBody || "unknown";
}

function parseRuleInput(body: Record<string, unknown>, partial: boolean) {
  const name = body.name !== undefined ? String(body.name).trim() : undefined;
  const metric = body.metric !== undefined ? parseMetricType(body.metric) : undefined;
  const condition = body.condition !== undefined ? String(body.condition) : undefined;
  const severity = body.severity !== undefined ? String(body.severity) : undefined;
  const thresholdRaw = body.threshold;
  const durationRaw = body.duration;

  if (!partial) {
    if (!name || metric == null || !condition || !severity || thresholdRaw === undefined || durationRaw === undefined) {
      return { ok: false as const, error: "Missing required fields" };
    }
  }

  if (body.metric !== undefined && metric == null) {
    return { ok: false as const, error: "Invalid metric" };
  }
  if (condition !== undefined && !isAlertCondition(condition)) {
    return { ok: false as const, error: "Invalid condition" };
  }
  if (severity !== undefined && !isAlertSeverity(severity)) {
    return { ok: false as const, error: "Invalid severity" };
  }

  const threshold = thresholdRaw === undefined ? undefined : Number(thresholdRaw);
  if (threshold !== undefined && !Number.isFinite(threshold)) {
    return { ok: false as const, error: "Invalid threshold" };
  }

  const duration =
    durationRaw === undefined ? undefined : Number.parseInt(String(durationRaw), 10);
  if (duration !== undefined && (!Number.isFinite(duration) || duration < 1)) {
    return { ok: false as const, error: "Invalid duration" };
  }

  return {
    ok: true as const,
    name,
    description: body.description !== undefined ? String(body.description ?? "") : undefined,
    metric,
    condition,
    threshold,
    duration,
    severity,
    enabled:
      body.enabled === undefined
        ? undefined
        : body.enabled !== false && body.enabled !== 0 && body.enabled !== "false",
  };
}

function asSettingsPayload(raw: unknown): AlertSettingsPayload {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return DEFAULT_ALERT_SETTINGS;
    }
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_ALERT_SETTINGS;
  return mergeAlertSettings(DEFAULT_ALERT_SETTINGS, parsed as Partial<AlertSettingsPayload>);
}

async function getOrCreateSettings(): Promise<AlertSettingsPayload> {
  const repo = AppDataSource.getRepository(AlertSettings);
  let row = (await repo.find({ take: 1 }))[0];
  if (!row) {
    row = await repo.save(repo.create({ payload: DEFAULT_ALERT_SETTINGS }));
  }
  return asSettingsPayload(row.payload);
}

export const getAlertRules = async (_req: Request, res: Response) => {
  try {
    const rules = await AppDataSource.getRepository(AlertRule).find({
      order: { id: "ASC" },
    });
    res.json({ success: true, data: rules.map(serializeRule) });
  } catch (error) {
    console.error("Error fetching alert rules:", error);
    res.status(500).json({ success: false, message: "Failed to fetch alert rules" });
  }
};

export const createAlertRule = async (req: Request, res: Response) => {
  try {
    const parsed = parseRuleInput((req.body ?? {}) as Record<string, unknown>, false);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, message: parsed.error });
    }
    if (!parsed.name || !parsed.metric || !parsed.condition || parsed.threshold === undefined || parsed.duration === undefined || !parsed.severity) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const repo = AppDataSource.getRepository(AlertRule);
    const saved = await repo.save(
      repo.create({
        name: parsed.name,
        description: parsed.description || "",
        metric: parsed.metric,
        condition: parsed.condition,
        threshold: parsed.threshold,
        duration: parsed.duration,
        severity: parsed.severity,
        enabled: parsed.enabled !== false,
        triggerCount: 0,
      })
    );

    res.status(201).json({ success: true, data: serializeRule(saved) });
  } catch (error) {
    console.error("Error creating alert rule:", error);
    res.status(500).json({ success: false, message: "Failed to create alert rule" });
  }
};

export const updateAlertRule = async (req: Request, res: Response) => {
  try {
    const id = parseId(String(req.params.id ?? ""));
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid alert rule id" });
    }

    const repo = AppDataSource.getRepository(AlertRule);
    const rule = await repo.findOne({ where: { id } });
    if (!rule) {
      return res.status(404).json({ success: false, message: "Alert rule not found" });
    }

    const parsed = parseRuleInput((req.body ?? {}) as Record<string, unknown>, true);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, message: parsed.error });
    }

    if (parsed.name !== undefined) rule.name = parsed.name;
    if (parsed.description !== undefined) rule.description = parsed.description;
    if (parsed.metric) rule.metric = parsed.metric;
    if (parsed.condition !== undefined) rule.condition = parsed.condition;
    if (parsed.threshold !== undefined) rule.threshold = parsed.threshold;
    if (parsed.duration !== undefined) rule.duration = parsed.duration;
    if (parsed.severity !== undefined) rule.severity = parsed.severity;
    if (parsed.enabled !== undefined) rule.enabled = parsed.enabled;
    rule.updatedAt = new Date();

    const saved = await repo.save(rule);
    res.json({ success: true, data: serializeRule(saved) });
  } catch (error) {
    console.error("Error updating alert rule:", error);
    res.status(500).json({ success: false, message: "Failed to update alert rule" });
  }
};

export const deleteAlertRule = async (req: Request, res: Response) => {
  try {
    const id = parseId(String(req.params.id ?? ""));
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid alert rule id" });
    }

    const repo = AppDataSource.getRepository(AlertRule);
    const rule = await repo.findOne({ where: { id } });
    if (!rule) {
      return res.status(404).json({ success: false, message: "Alert rule not found" });
    }

    await repo.remove(rule);
    res.json({ success: true, message: "Alert rule deleted successfully" });
  } catch (error) {
    console.error("Error deleting alert rule:", error);
    res.status(500).json({ success: false, message: "Failed to delete alert rule" });
  }
};

export const getAlerts = async (req: Request, res: Response) => {
  try {
    try {
      await evaluateAlertRulesIfStale();
    } catch (evalErr) {
      console.warn("Alert evaluation skipped:", evalErr);
    }

    const status = String(req.query.status ?? "all").trim().toLowerCase();
    const limitRaw = Number.parseInt(String(req.query.limit ?? "200"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;

    const qb = AppDataSource.getRepository(AlertIncident)
      .createQueryBuilder("a")
      .orderBy("a.timestamp", "DESC")
      .take(limit);

    if (status === "active") {
      qb.andWhere("a.resolved = 0");
    } else if (status === "resolved") {
      qb.andWhere("a.resolved = 1");
    }

    const rows = await qb.getMany();
    res.json({ success: true, data: rows.map(serializeIncident) });
  } catch (error) {
    console.error("Error fetching alerts:", error);
    res.status(500).json({ success: false, message: "Failed to fetch alerts" });
  }
};

export const acknowledgeAlert = async (req: Request, res: Response) => {
  try {
    const id = parseId(String(req.params.id ?? ""));
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid alert id" });
    }

    const repo = AppDataSource.getRepository(AlertIncident);
    const row = await repo.findOne({ where: { id } });
    if (!row) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }

    row.acknowledged = true;
    row.acknowledgedBy = actorFromRequest(req, (req.body as { acknowledgedBy?: unknown } | undefined)?.acknowledgedBy);
    row.acknowledgedAt = new Date();
    const saved = await repo.save(row);
    res.json({ success: true, data: serializeIncident(saved) });
  } catch (error) {
    console.error("Error acknowledging alert:", error);
    res.status(500).json({ success: false, message: "Failed to acknowledge alert" });
  }
};

export const resolveAlert = async (req: Request, res: Response) => {
  try {
    const id = parseId(String(req.params.id ?? ""));
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid alert id" });
    }

    const repo = AppDataSource.getRepository(AlertIncident);
    const row = await repo.findOne({ where: { id } });
    if (!row) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }

    row.resolved = true;
    row.resolvedAt = new Date();
    const saved = await repo.save(row);
    res.json({ success: true, data: serializeIncident(saved) });
  } catch (error) {
    console.error("Error resolving alert:", error);
    res.status(500).json({ success: false, message: "Failed to resolve alert" });
  }
};

export const getAlertSettings = async (_req: Request, res: Response) => {
  try {
    const settings = await getOrCreateSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error("Error fetching alert settings:", error);
    res.status(500).json({ success: false, message: "Failed to fetch alert settings" });
  }
};

export const updateAlertSettings = async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(AlertSettings);
    let row = (await repo.find({ take: 1 }))[0];
    const current = asSettingsPayload(row?.payload);
    const next = mergeAlertSettings(current, (req.body ?? {}) as Partial<AlertSettingsPayload>);

    if (!row) {
      row = repo.create({ payload: next });
    } else {
      row.payload = next;
    }
    row.updatedAt = new Date();
    await repo.save(row);
    res.json({ success: true, data: next });
  } catch (error) {
    console.error("Error updating alert settings:", error);
    res.status(500).json({ success: false, message: "Failed to update alert settings" });
  }
};

export const testAlert = async (req: Request, res: Response) => {
  try {
    const severityRaw = String((req.body ?? {}).severity ?? "medium");
    const severity = isAlertSeverity(severityRaw) ? severityRaw : "medium";
    const message = String((req.body ?? {}).message ?? "Test alert");

    const repo = AppDataSource.getRepository(AlertIncident);
    const saved = await repo.save(
      repo.create({
        ruleId: null,
        ruleName: "Test Alert",
        severity,
        message,
        metric: "test",
        value: 100,
        threshold: 50,
        timestamp: new Date(),
        acknowledged: false,
        resolved: false,
      })
    );

    // Asynchronously dispatch test webhook if configured
    void alertNotificationService.sendAlertWebhook(saved, "test").catch((e) => {
      console.warn("[alerts] test webhook dispatch failed:", e);
    });

    res.json({
      success: true,
      data: serializeIncident(saved),
      message: "Test alert created successfully",
    });
  } catch (error) {
    console.error("Error creating test alert:", error);
    res.status(500).json({ success: false, message: "Failed to create test alert" });
  }
};

export const testWebhookEndpoint = async (req: Request, res: Response) => {
  try {
    const url = String((req.body ?? {}).url ?? "").trim();
    if (!url) {
      return res.status(400).json({ success: false, message: "Webhook URL is required" });
    }
    const result = await alertNotificationService.testWebhook(url);
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error || "Failed to reach webhook endpoint" });
    }
    return res.json({ success: true, message: `Webhook test succeeded (HTTP ${result.status})` });
  } catch (error: any) {
    console.error("Error testing webhook:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to test webhook" });
  }
};
