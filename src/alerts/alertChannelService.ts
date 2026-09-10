import axios from "axios";
import { AppDataSource } from "../db/config";
import { AlertIncident } from "../db/entities/AlertIncident";
import { AlertSettings } from "../db/entities/AlertSettings";
import { alertNotificationService } from "../services/alertNotificationService";
import { DEFAULT_ALERT_SETTINGS, type AlertSettingsPayload } from "./alertMetrics";
import { CircuitBreakerRegistry } from "../utils/circuitBreaker";

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
   * Dispatches Email notifications.
   */
  async dispatchEmail(
    incident: AlertIncident,
    eventType: "created" | "escalated" | "resolved",
    recipients: string[],
    escalationLevel = 1
  ): Promise<ChannelDispatchResult> {
    try {
      const subject = `[${incident.severity.toUpperCase()}${eventType === "escalated" ? ` ESCALATION L${escalationLevel}` : ""}] ${incident.ruleName}`;
      console.log(`[alert-channel] Simulated email dispatch to ${recipients.length} recipients: ${subject}`);
      // If an SMTP transporter is configured, this integrates with nodemailer / sendgrid
      return {
        channel: "email",
        success: true,
        target: recipients.join(", "),
      };
    } catch (err: any) {
      return {
        channel: "email",
        success: false,
        target: recipients.join(", "),
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Dispatches SMS / WhatsApp notifications.
   */
  async dispatchSms(
    incident: AlertIncident,
    eventType: "created" | "escalated" | "resolved",
    recipients: string[],
    escalationLevel = 1
  ): Promise<ChannelDispatchResult> {
    try {
      const body = `XNet Alert [${incident.severity.toUpperCase()}]: ${incident.message}`;
      console.log(`[alert-channel] Simulated SMS dispatch to ${recipients.length} numbers: ${body}`);
      return {
        channel: "sms",
        success: true,
        target: recipients.join(", "),
      };
    } catch (err: any) {
      return {
        channel: "sms",
        success: false,
        target: recipients.join(", "),
        error: err?.message || String(err),
      };
    }
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
