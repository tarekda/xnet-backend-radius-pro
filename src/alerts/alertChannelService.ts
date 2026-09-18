import axios from "axios";
import { AppDataSource } from "../db/config";
import { AlertIncident } from "../db/entities/AlertIncident";
import { alertNotificationService } from "../services/alertNotificationService";
import { CircuitBreakerRegistry } from "../utils/circuitBreaker";
import { emailConfigSummary, sendEmail, type EmailConfigSummary } from "../services/emailService";
import { sendSms, smsConfigSummary, type SmsConfigSummary } from "../services/smsService";

export type NotificationChannel = "webhook" | "email" | "sms" | "whatsapp" | "slack";

export interface ChannelDispatchResult {
  channel: NotificationChannel;
  success: boolean;
  target?: string;
  error?: string;
}

export interface MultiChannelDispatchReport {
  incidentId: number;
  results: ChannelDispatchResult[];
  escalationLevel?: number;
  dispatchedAt: string;
}

export interface ChannelConfigurationReport {
  email: EmailConfigSummary;
  sms: SmsConfigSummary;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "#e11d48";
    case "high":
      return "#ea580c";
    case "medium":
      return "#d97706";
    default:
      return "#2563eb";
  }
}

/** Plain-text rendering used by both the email and SMS channels. */
function renderIncidentText(
  incident: AlertIncident,
  eventType: "created" | "escalated" | "resolved",
  escalationLevel: number
): string {
  return [
    `Rule: ${incident.ruleName}`,
    `Severity: ${incident.severity.toUpperCase()}`,
    `Event: ${eventType}${eventType === "escalated" ? ` (level ${escalationLevel})` : ""}`,
    `Metric: ${incident.metric}`,
    `Value: ${incident.value} (threshold ${incident.threshold})`,
    `Message: ${incident.message}`,
    `Timestamp: ${new Date(incident.timestamp).toUTCString()}`,
  ].join("\n");
}

function renderIncidentHtml(
  incident: AlertIncident,
  eventType: "created" | "escalated" | "resolved",
  escalationLevel: number
): string {
  const color = severityColor(incident.severity);
  const rows: Array<[string, string]> = [
    ["Severity", incident.severity.toUpperCase()],
    ["Event", eventType === "escalated" ? `${eventType} (level ${escalationLevel})` : eventType],
    ["Metric", incident.metric],
    ["Value / threshold", `${incident.value} / ${incident.threshold}`],
    ["Timestamp", new Date(incident.timestamp).toUTCString()],
  ];

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px">
  <div style="border-left:4px solid ${color};padding:12px 16px;background:#f8fafc">
    <h2 style="margin:0 0 4px;font-size:16px;color:#0f172a">${escapeHtml(incident.ruleName)}</h2>
    <div style="font-size:12px;font-weight:600;color:${color}">${escapeHtml(incident.severity.toUpperCase())}</div>
  </div>
  <p style="margin:12px 0;color:#334155;font-size:14px">${escapeHtml(incident.message)}</p>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    ${rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:6px 8px;color:#64748b;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 8px;color:#0f172a;font-weight:500">${escapeHtml(value)}</td></tr>`
      )
      .join("")}
  </table>
  <p style="margin-top:16px;font-size:11px;color:#94a3b8">XNet RADIUS Pro alerting</p>
</div>`;
}

export class AlertChannelService {
  /**
   * Dispatches an alert incident to all enabled notification channels.
   */
  async dispatchToAllChannels(
    incident: AlertIncident,
    eventType: "created" | "escalated" | "resolved" = "created",
    escalationLevel = 1
  ): Promise<MultiChannelDispatchReport> {
    const settings = await alertNotificationService.getSettings();
    const results: ChannelDispatchResult[] = [];

    // 1. Webhook & Slack/Discord Webhook
    if (settings.webhookNotifications && settings.webhookUrl?.trim()) {
      const webhookRes = await this.dispatchWebhook(incident, eventType, settings.webhookUrl.trim(), escalationLevel);
      results.push(webhookRes);
    }

    // 2. Email Notifications
    if (settings.emailNotifications && Array.isArray(settings.emailRecipients) && settings.emailRecipients.length > 0) {
      const emailRes = await this.dispatchEmail(incident, eventType, settings.emailRecipients, escalationLevel);
      results.push(emailRes);
    }

    // 3. SMS Notifications
    if (settings.smsNotifications && Array.isArray(settings.smsRecipients) && settings.smsRecipients.length > 0) {
      const smsRes = await this.dispatchSms(incident, eventType, settings.smsRecipients, escalationLevel);
      results.push(smsRes);
    }

    return {
      incidentId: incident.id,
      results,
      escalationLevel,
      dispatchedAt: new Date().toISOString(),
    };
  }

  /**
   * Dispatches Webhook (supports generic webhook, Slack, Discord, and Teams).
   */
  async dispatchWebhook(
    incident: AlertIncident,
    eventType: "created" | "escalated" | "resolved",
    webhookUrl: string,
    escalationLevel = 1
  ): Promise<ChannelDispatchResult> {
    const breaker = CircuitBreakerRegistry.get("external_webhook");
    try {
      return await breaker.execute(async () => {
        const isSlack = webhookUrl.includes("slack.com/services/");
        const isDiscord = webhookUrl.includes("discord.com/api/webhooks/");

        if (isSlack) {
          // Format Slack blocks
          const color =
            incident.severity === "critical"
              ? "#e11d48"
              : incident.severity === "high"
              ? "#ea580c"
              : incident.severity === "medium"
              ? "#d97706"
              : "#2563eb";

          const prefix = eventType === "escalated" ? `🚨 *[ESCALATION L${escalationLevel}]* ` : "";
          const payload = {
            attachments: [
              {
                color,
                title: `${prefix}${incident.ruleName} (${incident.severity.toUpperCase()})`,
                text: incident.message,
                fields: [
                  { title: "Metric", value: incident.metric, short: true },
                  { title: "Value / Threshold", value: `${incident.value} / ${incident.threshold}`, short: true },
                  { title: "Event", value: eventType, short: true },
                  { title: "Timestamp", value: new Date(incident.timestamp).toUTCString(), short: true },
                ],
                footer: "XNet RADIUS Pro Enterprise Alerting",
              },
            ],
          };

          await axios.post(webhookUrl, payload, { timeout: 6000 });
          return { channel: "slack", success: true, target: webhookUrl };
        }

        if (isDiscord) {
          // Format Discord embed
          const color =
            incident.severity === "critical"
              ? 0xe11d48
              : incident.severity === "high"
              ? 0xea580c
              : 0x2563eb;

          const payload = {
            embeds: [
              {
                title: `[${eventType.toUpperCase()}] ${incident.ruleName}`,
                description: incident.message,
                color,
                fields: [
                  { name: "Severity", value: incident.severity.toUpperCase(), inline: true },
                  { name: "Metric", value: incident.metric, inline: true },
                  { name: "Value / Threshold", value: `${incident.value} / ${incident.threshold}`, inline: true },
                ],
                footer: { text: "XNet RADIUS Pro" },
                timestamp: new Date().toISOString(),
              },
            ],
          };

          await axios.post(webhookUrl, payload, { timeout: 6000 });
          return { channel: "webhook", success: true, target: webhookUrl };
        }

        // Generic webhook
        const webhookRes = await alertNotificationService.sendAlertWebhook(incident, eventType, {
          level: escalationLevel,
          unacknowledgedMinutes: incident.timestamp
            ? Math.max(0, Math.round((Date.now() - new Date(incident.timestamp).getTime()) / 60000))
            : 0,
        });

        return {
          channel: "webhook",
          success: webhookRes.sent,
          target: webhookUrl,
          error: webhookRes.reason,
        };
      });
    } catch (err: any) {
      return {
        channel: "webhook",
        success: false,
        target: webhookUrl,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Dispatches Email notifications over the configured SMTP transport.
   * Uses its own circuit breaker so a mail outage cannot trip other channels.
   */
  async dispatchEmail(
    incident: AlertIncident,
    eventType: "created" | "escalated" | "resolved",
    recipients: string[],
    escalationLevel = 1
  ): Promise<ChannelDispatchResult> {
    const target = recipients.join(", ");
    const subject = `[${incident.severity.toUpperCase()}${eventType === "escalated" ? ` ESCALATION L${escalationLevel}` : ""}] ${incident.ruleName}`;

    const breaker = CircuitBreakerRegistry.get("email_smtp");
    try {
      return await breaker.execute(async () => {
        const result = await sendEmail({
          to: recipients,
          subject,
          text: renderIncidentText(incident, eventType, escalationLevel),
          html: renderIncidentHtml(incident, eventType, escalationLevel),
        });

        if (!result.sent) {
          console.warn(`[alert-channel] Email dispatch failed: ${result.reason}`);
          return { channel: "email" as const, success: false, target, error: result.reason };
        }

        if (result.rejected.length > 0) {
          // Partial delivery: SMTP accepted the message but refused some mailboxes.
          console.warn(`[alert-channel] Email rejected for: ${result.rejected.join(", ")}`);
        }

        return { channel: "email" as const, success: true, target };
      });
    } catch (err: any) {
      return {
        channel: "email",
        success: false,
        target,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Dispatches SMS notifications through Twilio.
   */
  async dispatchSms(
    incident: AlertIncident,
    eventType: "created" | "escalated" | "resolved",
    recipients: string[],
    escalationLevel = 1
  ): Promise<ChannelDispatchResult> {
    const target = recipients.join(", ");
    const prefix = eventType === "escalated" ? `ESCALATION L${escalationLevel} ` : "";
    const body = `XNet Alert [${incident.severity.toUpperCase()}] ${prefix}${incident.ruleName}: ${incident.message}`;

    const breaker = CircuitBreakerRegistry.get("sms_twilio");
    try {
      return await breaker.execute(async () => {
        const result = await sendSms({ to: recipients, body });

        if (!result.sent) {
          console.warn(`[alert-channel] SMS dispatch failed: ${result.reason}`);
          return { channel: "sms" as const, success: false, target, error: result.reason };
        }

        if (result.failed.length > 0) {
          console.warn(`[alert-channel] SMS failed for: ${result.failed.join(", ")}`);
        }

        return { channel: "sms" as const, success: true, target };
      });
    } catch (err: any) {
      return {
        channel: "sms",
        success: false,
        target,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Reports which outbound channels are usable, plus the reason any are not.
   * Exposes no secrets — safe to return from an admin endpoint.
   */
  describeChannels(): ChannelConfigurationReport {
    return {
      email: emailConfigSummary(),
      sms: smsConfigSummary(),
    };
  }

  /**
   * Evaluates all open, unacknowledged incidents against the configured escalation policy.
   * Promotes severity and triggers multi-channel escalation alerts.
   */
  async checkAndEscalateUnacknowledgedIncidents(): Promise<number> {
    if (!AppDataSource.isInitialized) return 0;

    const settings = await alertNotificationService.getSettings();
    if (!settings.escalationPolicy?.enabled) return 0;

    const delayMinutes = Number(settings.escalationPolicy.escalationDelay || 15);
    const cutoffTime = new Date(Date.now() - delayMinutes * 60 * 1000);

    const incidentRepo = AppDataSource.getRepository(AlertIncident);
    const unackIncidents = await incidentRepo
      .createQueryBuilder("i")
      .where("i.acknowledged = 0")
      .andWhere("i.resolved = 0")
      .andWhere("i.timestamp <= :cutoffTime", { cutoffTime })
      .orderBy("i.timestamp", "ASC")
      .getMany();

    if (!unackIncidents.length) return 0;

    let escalatedCount = 0;
    for (const incident of unackIncidents) {
      try {
        // Escalate severity if applicable
        const currentSev = incident.severity;
        let newSev = currentSev;
        if (currentSev === "low") newSev = "medium";
        else if (currentSev === "medium") newSev = "high";
        else if (currentSev === "high") newSev = "critical";

        incident.severity = newSev;
        await incidentRepo.save(incident);

        // Dispatch escalation alert
        await this.dispatchToAllChannels(incident, "escalated", 2);
        escalatedCount++;
      } catch (e) {
        console.warn(`[alert-channel] Failed to escalate incident #${incident.id}:`, e);
      }
    }

    return escalatedCount;
  }
}

export const alertChannelService = new AlertChannelService();
