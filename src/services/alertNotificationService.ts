import axios from "axios";
import { AppDataSource } from "../db/config";
import { AlertSettings } from "../db/entities/AlertSettings";
import { AlertIncident } from "../db/entities/AlertIncident";
import {
  DEFAULT_ALERT_SETTINGS,
  type AlertSettingsPayload,
} from "../alerts/alertMetrics";

export type AlertEventType = "created" | "escalated" | "resolved" | "test";

export interface AlertWebhookPayload {
  event: string;
  timestamp: string;
  environment: string;
  severity: string;
  incident: {
    id: number;
    ruleId: number | null;
    ruleName: string;
    severity: string;
    metric: string;
    value: number;
    threshold: number;
    message: string;
    acknowledged: boolean;
    acknowledgedBy?: string | null;
    resolved: boolean;
    durationMinutes?: number;
  };
  escalation?: {
    level: number;
    unacknowledgedMinutes: number;
    escalatedAt: string;
  };
}

export class AlertNotificationService {
  private timeoutMs = 6000;

  /**
   * Retrieves active alert settings from database or fallback defaults.
   */
  async getSettings(): Promise<AlertSettingsPayload> {
    if (!AppDataSource.isInitialized) {
      return DEFAULT_ALERT_SETTINGS;
    }
    try {
      const repo = AppDataSource.getRepository(AlertSettings);
      const row = (await repo.find({ take: 1 }))[0];
      if (!row || !row.payload) {
        return DEFAULT_ALERT_SETTINGS;
      }
      return {
        ...DEFAULT_ALERT_SETTINGS,
        ...row.payload,
        quietHours: {
          ...DEFAULT_ALERT_SETTINGS.quietHours,
          ...(row.payload.quietHours || {}),
        },
        escalationPolicy: {
          ...DEFAULT_ALERT_SETTINGS.escalationPolicy,
          ...(row.payload.escalationPolicy || {}),
        },
      };
    } catch (err) {
      console.warn("[alert-notification] failed to load alert settings, using defaults:", err);
      return DEFAULT_ALERT_SETTINGS;
    }
  }

  /**
   * Evaluates if current time falls within configured quiet hours window.
   */
  isQuietHoursActive(quietHours: AlertSettingsPayload["quietHours"]): boolean {
    if (!quietHours?.enabled) return false;

    try {
      const timeZone = quietHours.timezone || "UTC";
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const parts = formatter.formatToParts(now);
      const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
      const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
      const current = `${hour}:${minute}`;

      const start = quietHours.startTime || "22:00";
      const end = quietHours.endTime || "08:00";

      if (start <= end) {
        return current >= start && current < end;
      } else {
        // Overnight span (e.g. 22:00 to 08:00)
        return current >= start || current < end;
      }
    } catch (e) {
      console.warn("[alert-notification] error checking quiet hours:", e);
      return false;
    }
  }

  /**
   * Formats the incident payload for outbound webhooks.
   */
  buildWebhookPayload(
    incident: AlertIncident,
    eventType: AlertEventType,
    escalation?: { level: number; unacknowledgedMinutes: number }
  ): AlertWebhookPayload {
    const unackMin = incident.timestamp
      ? Math.max(0, Math.round((Date.now() - new Date(incident.timestamp).getTime()) / 60000))
      : 0;

    return {
      event: `alert.incident.${eventType}`,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || "production",
      severity: incident.severity,
      incident: {
        id: incident.id,
        ruleId: incident.ruleId,
        ruleName: incident.ruleName,
        severity: incident.severity,
        metric: incident.metric,
        value: Number(incident.value),
        threshold: Number(incident.threshold),
        message: incident.message,
        acknowledged: Boolean(incident.acknowledged),
        acknowledgedBy: incident.acknowledgedBy,
        resolved: Boolean(incident.resolved),
        durationMinutes: unackMin,
      },
      escalation: escalation
        ? {
            level: escalation.level,
            unacknowledgedMinutes: escalation.unacknowledgedMinutes,
            escalatedAt: new Date().toISOString(),
          }
        : undefined,
    };
  }

  /**
   * Dispatches outbound webhook for an alert incident.
   */
  async sendAlertWebhook(
    incident: AlertIncident,
    eventType: AlertEventType,
    escalation?: { level: number; unacknowledgedMinutes: number }
  ): Promise<{ sent: boolean; reason?: string }> {
    const settings = await this.getSettings();

    if (!settings.webhookNotifications) {
      return { sent: false, reason: "webhook_notifications_disabled" };
    }

    const webhookUrl = (settings.webhookUrl || "").trim();
    if (!webhookUrl) {
      return { sent: false, reason: "webhook_url_empty" };
    }

    // Critical severity alerts bypass quiet hours to guarantee visibility
    if (incident.severity !== "critical" && this.isQuietHoursActive(settings.quietHours)) {
      console.log(`[alert-notification] webhook skipped during quiet hours for incident #${incident.id} (${incident.severity})`);
      return { sent: false, reason: "quiet_hours_active" };
    }

    const payload = this.buildWebhookPayload(incident, eventType, escalation);

    try {
      const response = await axios.post(webhookUrl, payload, {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "xnet-radius-alerting/1.0",
        },
      });

      console.log(`[alert-notification] webhook dispatched for incident #${incident.id} [${eventType}] -> ${response.status}`);
      return { sent: true };
    } catch (err: any) {
      const errMsg = err.response ? `HTTP ${err.response.status}` : err.message;
      console.error(`[alert-notification] webhook failed for incident #${incident.id}:`, errMsg);
      return { sent: false, reason: errMsg };
    }
  }

  /**
   * Test a webhook URL directly with a synthetic test event.
   */
  async testWebhook(targetUrl: string): Promise<{ success: boolean; status?: number; error?: string }> {
    const url = (targetUrl || "").trim();
    if (!url || !url.startsWith("http")) {
      return { success: false, error: "Invalid URL. Must start with http:// or https://" };
    }

    const testPayload: AlertWebhookPayload = {
      event: "alert.incident.test",
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || "production",
      severity: "medium",
      incident: {
        id: 0,
        ruleId: null,
        ruleName: "Webhook Connectivity Test",
        severity: "medium",
        metric: "connectivity_test",
        value: 1,
        threshold: 1,
        message: "This is a test notification from the xnet RADIUS Alerting System.",
        acknowledged: false,
        resolved: false,
      },
    };

    try {
      const response = await axios.post(url, testPayload, {
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "xnet-radius-alerting-test/1.0",
        },
      });
      return { success: true, status: response.status };
    } catch (err: any) {
      const errorMsg = err.response
        ? `Remote responded with HTTP ${err.response.status}`
        : err.code === "ECONNABORTED"
          ? "Request timed out after 5000ms"
          : err.message || "Failed to reach endpoint";
      return { success: false, error: errorMsg };
    }
  }
}

export const alertNotificationService = new AlertNotificationService();
