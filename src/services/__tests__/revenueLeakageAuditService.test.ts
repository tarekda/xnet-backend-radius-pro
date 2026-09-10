import {
  calculateEstimatedRevenueLoss,
  runRevenueLeakageAudit,
  remediateLeakageRecord,
  getRevenueLeakageSummary,
} from "../revenueLeakageAuditService";
import { AppDataSource } from "../../db/config";
import { RevenueLeakageAudit } from "../../db/entities/RevenueLeakageAudit";
import { Radacct } from "../../db/entities/Radacct";
import { Raduserprofile } from "../../db/entities/Raduserprofile";
import { ExternalInvoice } from "../../db/entities/ExternalInvoice";
import { bandwidthService } from "../bandwidthService";
import { UserController } from "../../controllers/userController";

jest.mock("../../db/config", () => ({
  AppDataSource: {
    query: jest.fn(),
    getRepository: jest.fn(),
  },
}));

jest.mock("../bandwidthService", () => ({
  bandwidthService: {
    getActiveConnections: jest.fn(),
    disconnectUser: jest.fn(),
  },
}));

jest.mock("../../controllers/userController", () => ({
  UserController: {
    disconnectUser: jest.fn(),
  },
}));

jest.mock("../../realtime/wsHub", () => ({
  broadcastToClients: jest.fn(),
}));

describe("revenueLeakageAuditService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("calculateEstimatedRevenueLoss", () => {
    it("calculates baseline loss for default monthly fee and 1 day overdue", () => {
      const loss = calculateEstimatedRevenueLoss({
        monthlyAmount: 30,
        unpaidDays: 3,
        bytesTotal: 0,
      });
      // 30 / 30 = $1/day * 3 days = $3.00
      expect(loss).toBe(3);
    });

    it("factors in bandwidth consumption at $0.15/GB", () => {
      // 10 GB in bytes = 10 * 1024^3
      const tenGbBytes = BigInt(10) * BigInt(1024 * 1024 * 1024);
      const loss = calculateEstimatedRevenueLoss({
        monthlyAmount: 30,
        unpaidDays: 1, // 1 day * $1 = $1.00
        bytesTotal: tenGbBytes, // 10 * 0.15 = $1.50
      });
      expect(loss).toBe(2.5);
    });

    it("falls back to $25/mo when monthly amount is missing or <= 0", () => {
      const loss = calculateEstimatedRevenueLoss({
        monthlyAmount: 0,
        unpaidDays: 6, // 6 * (25/30) = $5.00
        bytesTotal: 0,
      });
      expect(loss).toBe(5);
    });
  });

  describe("runRevenueLeakageAudit", () => {
    it("detects EXPIRED_UNPAID_ONLINE when user is online with an overdue invoice", async () => {
      // 1. Router connections mock
      (bandwidthService.getActiveConnections as jest.Mock).mockResolvedValue({
        pppConnections: [
          {
            name: "unpaid_user",
            "caller-id": "00:11:22:33:44:55",
            address: "10.10.10.50",
            "bytes-in": "1000000000",
            "bytes-out": "2000000000",
            uptime: "2d 4h",
          },
        ],
      });

      // 2. Radacct mock (qb)
      const radacctQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            username: "unpaid_user",
            nasipaddress: "172.9.16.2",
            framedipaddress: "10.10.10.50",
            callingstationid: "00:11:22:33:44:55",
            acctinputoctets: 1000000000,
            acctoutputoctets: 2000000000,
          },
        ]),
      };

      // 3. Profiles mock (qb)
      const profileQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            username: "unpaid_user",
            accountStatus: "active",
            profile: { profileName: "Standard-15M" },
            expiresAt: new Date(Date.now() - 5 * 86400000), // expired 5 days ago
          },
        ]),
      };

      // 4. Invoices mock (qb)
      const invoiceQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 101,
            username: "unpaid_user",
            fullName: "John Doe",
            status: "unpaid",
            payDueDate: new Date(Date.now() - 5 * 86400000),
            amount: "35.00",
            totalAmount: "35.00",
          },
        ]),
      };

      // 5. Audit repo mock
      const mockAuditRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((val) => val),
        save: jest.fn().mockImplementation((val) => Promise.resolve({ id: 1, ...val })),
      };

      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === Radacct) return { createQueryBuilder: () => radacctQb };
        if (entity === Raduserprofile) return { createQueryBuilder: () => profileQb };
        if (entity === ExternalInvoice) return { createQueryBuilder: () => invoiceQb };
        if (entity === RevenueLeakageAudit) return mockAuditRepo;
        return { createQueryBuilder: () => ({ select: jest.fn().mockReturnThis(), getMany: jest.fn().mockResolvedValue([]) }) };
      });

      const result = await runRevenueLeakageAudit({ autoRemediate: false });

      expect(result.leaksDetected).toBe(1);
      expect(result.leaks[0].username).toBe("unpaid_user");
      expect(result.leaks[0].leakType).toBe("EXPIRED_UNPAID_ONLINE");
      expect(result.leaks[0].estimatedLossUsd).toBeGreaterThan(0);
      expect(mockAuditRepo.save).toHaveBeenCalled();
    });

    it("detects GHOST_STALE_SESSION when router session exists without FreeRADIUS radacct", async () => {
      (bandwidthService.getActiveConnections as jest.Mock).mockResolvedValue({
        pppConnections: [
          {
            name: "ghost_user",
            "caller-id": "AA:BB:CC:DD:EE:FF",
            address: "10.10.20.99",
            "bytes-in": "5000000",
            "bytes-out": "5000000",
          },
        ],
      });

      const radacctQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]), // No radacct session!
      };

      const profileQb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            username: "ghost_user",
            accountStatus: "active",
            profile: { profileName: "Standard" },
          },
        ]),
      };

      const invoiceQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      const mockAuditRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((val) => val),
        save: jest.fn().mockImplementation((val) => Promise.resolve({ id: 2, ...val })),
      };

      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === Radacct) return { createQueryBuilder: () => radacctQb };
        if (entity === Raduserprofile) return { createQueryBuilder: () => profileQb };
        if (entity === ExternalInvoice) return { createQueryBuilder: () => invoiceQb };
        if (entity === RevenueLeakageAudit) return mockAuditRepo;
        return {};
      });

      const result = await runRevenueLeakageAudit({ autoRemediate: false });

      expect(result.leaksDetected).toBe(1);
      expect(result.leaks[0].username).toBe("ghost_user");
      expect(result.leaks[0].leakType).toBe("GHOST_STALE_SESSION");
    });
  });

  describe("remediateLeakageRecord", () => {
    it("disconnects session via bandwidthService and PoD, and sets status to remediated", async () => {
      const mockRecord = {
        id: 10,
        username: "leaker1",
        status: "detected",
        remediationAction: "pending_review",
        resolvedAt: null,
        resolvedBy: null,
      };

      const mockRepo = {
        findOne: jest.fn().mockResolvedValue(mockRecord),
        save: jest.fn().mockImplementation((val) => Promise.resolve(val)),
      };

      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockRepo);
      (bandwidthService.disconnectUser as jest.Mock).mockResolvedValue({ success: true });
      (UserController.disconnectUser as jest.Mock).mockResolvedValue(true);

      const res = await remediateLeakageRecord(10, "admin");

      expect(res).not.toBeNull();
      expect(bandwidthService.disconnectUser).toHaveBeenCalledWith("leaker1");
      expect(UserController.disconnectUser).toHaveBeenCalledWith("leaker1");
      expect(mockRecord.status).toBe("remediated");
      expect(mockRecord.remediationAction).toBe("mikrotik_disconnect");
      expect(mockRecord.resolvedAt).toBeInstanceOf(Date);
      expect(mockRepo.save).toHaveBeenCalledWith(mockRecord);
    });
  });

  describe("getRevenueLeakageSummary", () => {
    it("aggregates audit stats from repository queries", async () => {
      const activeRecords = [
        { leakType: "GHOST_STALE_SESSION", estimatedLossUsd: "50.00" },
        { leakType: "GHOST_STALE_SESSION", estimatedLossUsd: "25.00" },
        { leakType: "GHOST_STALE_SESSION", estimatedLossUsd: "25.00" },
        { leakType: "EXPIRED_UNPAID_ONLINE", estimatedLossUsd: "100.00" },
        { leakType: "PROFILE_SPEED_MISALIGNMENT", estimatedLossUsd: "45.50" },
      ];

      const mockRepo = {
        createQueryBuilder: jest.fn().mockImplementation(() => {
          let currentStatus = "";
          const qb: any = {
            where: jest.fn().mockImplementation((cond: string, params: any) => {
              currentStatus = params?.status;
              return qb;
            }),
            orderBy: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockImplementation(() => {
              if (currentStatus === "detected") return Promise.resolve(activeRecords);
              return Promise.resolve([]);
            }),
            getCount: jest.fn().mockImplementation(() => {
              if (currentStatus === "remediated") return Promise.resolve(18);
              return Promise.resolve(0);
            }),
            getOne: jest.fn().mockResolvedValue({
              detectedAt: new Date("2026-09-10T12:00:00Z"),
            }),
          };
          return qb;
        }),
      };

      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockRepo);

      const summary = await getRevenueLeakageSummary();

      expect(summary.activeGhostCount).toBe(3);
      expect(summary.unpaidOnlineCount).toBe(1);
      expect(summary.speedMisalignmentCount).toBe(1);
      expect(summary.totalActiveLeaks).toBe(5);
      expect(summary.totalEstimatedLossUsd).toBe(245.5);
      expect(summary.remediatedCount).toBe(18);
      expect(summary.lastAuditAt).toEqual(new Date("2026-09-10T12:00:00Z"));
    });
  });
});
