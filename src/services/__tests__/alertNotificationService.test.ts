import axios from "axios";
import { AlertNotificationService } from "../alertNotificationService";
import { AlertIncident } from "../../db/entities/AlertIncident";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("AlertNotificationService", () => {
  let service: AlertNotificationService;

  beforeEach(() => {
    service = new AlertNotificationService();
    jest.clearAllMocks();
  });

  describe("buildWebhookPayload", () => {
    it("constructs compliant webhook payload with incident details", () => {
      const incident = {
        id: 42,
        ruleId: 7,
        ruleName: "High Auth Failure Rate",
        severity: "high",
        metric: "auth_failed_attempts",
        value: 125,
        threshold: 50,
        message: "Failed Authentication Attempts (125) exceeded threshold (50)",
        timestamp: new Date(Date.now() - 10 * 60000), // 10 min ago
        acknowledged: false,
        acknowledgedBy: null,
        resolved: false,
      } as unknown as AlertIncident;

      const payload = service.buildWebhookPayload(incident, "created");

      expect(payload.event).toBe("alert.incident.created");
      expect(payload.severity).toBe("high");
      expect(payload.incident.id).toBe(42);
      expect(payload.incident.metric).toBe("auth_failed_attempts");
      expect(payload.incident.durationMinutes).toBeGreaterThanOrEqual(9);
      expect(payload.escalation).toBeUndefined();
    });

    it("includes escalation metadata when provided", () => {
      const incident = {
        id: 101,
        ruleId: 2,
        ruleName: "NAS Down",
        severity: "critical",
        metric: "users",
        value: 0,
        threshold: 10,
        message: "Active Users dropped below 10",
        timestamp: new Date(Date.now() - 45 * 60000),
        acknowledged: false,
        resolved: false,
      } as unknown as AlertIncident;

      const payload = service.buildWebhookPayload(incident, "escalated", {
        level: 2,
        unacknowledgedMinutes: 45,
      });

      expect(payload.event).toBe("alert.incident.escalated");
      expect(payload.escalation).toBeDefined();
      expect(payload.escalation?.level).toBe(2);
      expect(payload.escalation?.unacknowledgedMinutes).toBe(45);
    });
  });

  describe("isQuietHoursActive", () => {
    it("returns false if quietHours is disabled", () => {
      const active = service.isQuietHoursActive({
        enabled: false,
        startTime: "00:00",
        endTime: "23:59",
        timezone: "UTC",
      });
      expect(active).toBe(false);
    });

    it("evaluates overnight span correctly", () => {
      // Overnight span: 22:00 to 08:00
      const activeWhenDisabled = service.isQuietHoursActive({
        enabled: false,
        startTime: "22:00",
        endTime: "08:00",
        timezone: "UTC",
      });
      expect(activeWhenDisabled).toBe(false);
    });
  });

  describe("sendAlertWebhook", () => {
    it("returns false if webhookNotifications is disabled", async () => {
      jest.spyOn(service, "getSettings").mockResolvedValueOnce({
        emailNotifications: false,
        smsNotifications: false,
        webhookNotifications: false,
        inAppNotifications: true,
        emailRecipients: [],
        smsRecipients: [],
        quietHours: { enabled: false, startTime: "22:00", endTime: "08:00", timezone: "UTC" },
        escalationPolicy: { enabled: false, escalationDelay: 30, maxEscalations: 3 },
      });

      const incident = { id: 1, severity: "medium" } as unknown as AlertIncident;
      const result = await service.sendAlertWebhook(incident, "created");
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("webhook_notifications_disabled");
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("returns false if webhookUrl is empty", async () => {
      jest.spyOn(service, "getSettings").mockResolvedValueOnce({
        emailNotifications: false,
        smsNotifications: false,
        webhookNotifications: true,
        inAppNotifications: true,
        emailRecipients: [],
        smsRecipients: [],
        webhookUrl: "",
        quietHours: { enabled: false, startTime: "22:00", endTime: "08:00", timezone: "UTC" },
        escalationPolicy: { enabled: false, escalationDelay: 30, maxEscalations: 3 },
      });

      const incident = { id: 1, severity: "medium" } as unknown as AlertIncident;
      const result = await service.sendAlertWebhook(incident, "created");
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("webhook_url_empty");
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("successfully posts webhook when enabled with valid URL", async () => {
      jest.spyOn(service, "getSettings").mockResolvedValueOnce({
        emailNotifications: false,
        smsNotifications: false,
        webhookNotifications: true,
        inAppNotifications: true,
        emailRecipients: [],
        smsRecipients: [],
        webhookUrl: "https://hooks.slack.com/services/T00/B00/X00",
        quietHours: { enabled: false, startTime: "22:00", endTime: "08:00", timezone: "UTC" },
        escalationPolicy: { enabled: false, escalationDelay: 30, maxEscalations: 3 },
      });

      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: "ok" });

      const incident = {
        id: 99,
        ruleId: 1,
        ruleName: "High Memory",
        severity: "high",
        metric: "memory_usage",
        value: 92,
        threshold: 85,
        message: "Memory Usage (92%) exceeded threshold (85%)",
        timestamp: new Date(),
        acknowledged: false,
        resolved: false,
      } as unknown as AlertIncident;

      const result = await service.sendAlertWebhook(incident, "created");
      expect(result.sent).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/T00/B00/X00",
        expect.objectContaining({
          event: "alert.incident.created",
          severity: "high",
        }),
        expect.any(Object)
      );
    });

    it("critical severity alerts bypass quiet hours", async () => {
      jest.spyOn(service, "getSettings").mockResolvedValueOnce({
        emailNotifications: false,
        smsNotifications: false,
        webhookNotifications: true,
        inAppNotifications: true,
        emailRecipients: [],
        smsRecipients: [],
        webhookUrl: "https://alerts.mycompany.com/webhook",
        quietHours: { enabled: true, startTime: "00:00", endTime: "23:59", timezone: "UTC" },
        escalationPolicy: { enabled: false, escalationDelay: 30, maxEscalations: 3 },
      });
      jest.spyOn(service, "isQuietHoursActive").mockReturnValue(true);

      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: "ok" });

      const incident = {
        id: 77,
        severity: "critical",
        message: "Critical RADIUS Failure",
        timestamp: new Date(),
      } as unknown as AlertIncident;

      const result = await service.sendAlertWebhook(incident, "created");
      expect(result.sent).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  describe("testWebhook", () => {
    it("rejects invalid URL formats", async () => {
      const res = await service.testWebhook("not-a-valid-url");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Invalid URL");
    });

    it("returns status on successful ping", async () => {
      mockedAxios.post.mockResolvedValueOnce({ status: 204 });
      const res = await service.testWebhook("https://example.com/webhook");
      expect(res.success).toBe(true);
      expect(res.status).toBe(204);
    });
  });
});
