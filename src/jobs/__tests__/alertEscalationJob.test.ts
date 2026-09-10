import { runAlertEscalationJob } from "../alertEscalationJob";
import { AppDataSource } from "../../db/config";
import { alertNotificationService } from "../../services/alertNotificationService";

jest.mock("../../db/config", () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: jest.fn(),
  },
}));

jest.mock("../../services/alertNotificationService", () => ({
  alertNotificationService: {
    getSettings: jest.fn(),
    sendAlertWebhook: jest.fn(async () => ({ sent: true })),
  },
}));

describe("runAlertEscalationJob", () => {
  let mockRepository: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRepository = {
      createQueryBuilder: jest.fn(),
      save: jest.fn(async (item) => item),
    };
    (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockRepository);
  });

  it("returns zero if escalation policy is disabled", async () => {
    (alertNotificationService.getSettings as jest.Mock).mockResolvedValueOnce({
      escalationPolicy: { enabled: false, escalationDelay: 15, maxEscalations: 3 },
    });

    const res = await runAlertEscalationJob();
    expect(res.checked).toBe(0);
    expect(res.escalated).toBe(0);
    expect(mockRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("escalates unacknowledged incident past threshold and triggers notification", async () => {
    (alertNotificationService.getSettings as jest.Mock).mockResolvedValueOnce({
      escalationPolicy: { enabled: true, escalationDelay: 15, maxEscalations: 3 },
    });

    const oldIncident = {
      id: 555,
      ruleId: 1,
      ruleName: "High Packet Drop",
      severity: "medium",
      metric: "auth_failed_attempts",
      value: 200,
      threshold: 100,
      timestamp: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago (> 15 min delay)
      acknowledged: false,
      resolved: false,
    };

    const qbMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValueOnce([oldIncident]),
    };
    mockRepository.createQueryBuilder.mockReturnValue(qbMock);

    const res = await runAlertEscalationJob();

    expect(res.checked).toBe(1);
    expect(res.escalated).toBe(1);
    expect(oldIncident.severity).toBe("high"); // escalated medium -> high
    expect(mockRepository.save).toHaveBeenCalledWith(oldIncident);
    expect(alertNotificationService.sendAlertWebhook).toHaveBeenCalledWith(
      oldIncident,
      "escalated",
      expect.objectContaining({
        level: 1,
        unacknowledgedMinutes: expect.any(Number),
      })
    );
  });

  it("skips incidents that have not reached the escalation delay", async () => {
    (alertNotificationService.getSettings as jest.Mock).mockResolvedValueOnce({
      escalationPolicy: { enabled: true, escalationDelay: 30, maxEscalations: 3 },
    });

    const recentIncident = {
      id: 777,
      ruleId: 2,
      ruleName: "Recent Warning",
      severity: "low",
      timestamp: new Date(Date.now() - 5 * 60 * 1000), // only 5 min ago (< 30 min delay)
      acknowledged: false,
      resolved: false,
    };

    const qbMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValueOnce([recentIncident]),
    };
    mockRepository.createQueryBuilder.mockReturnValue(qbMock);

    const res = await runAlertEscalationJob();

    expect(res.checked).toBe(1);
    expect(res.escalated).toBe(0);
    expect(res.skipped).toBe(1);
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(alertNotificationService.sendAlertWebhook).not.toHaveBeenCalled();
  });
});
