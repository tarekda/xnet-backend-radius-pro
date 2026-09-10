import {
  restoreSubscriberLine,
  getSubscriberDunningEnforcementState,
  preserveUserDefaultProfile,
} from "../subscriberReactivationService";
import { UserController } from "../../controllers/userController";
import { radiusAuthCacheService } from "../radiusAuthCacheService";
import { writeAuditLog } from "../../audit/writeAuditLog";

jest.mock("../radiusAuthCacheService", () => ({
  radiusAuthCacheService: {
    invalidateUserCache: jest.fn(async () => {}),
  },
}));

jest.mock("../cacheService", () => ({
  __esModule: true,
  default: {
    deleteCacheKeys: jest.fn(async () => {}),
  },
}));

jest.mock("../../audit/writeAuditLog", () => ({
  writeAuditLog: jest.fn(async () => {}),
}));

jest.mock("../../controllers/userController", () => ({
  UserController: {
    disconnectUser: jest.fn(async () => ({ ok: true, method: "mikrotik-api", result: { pppRemoved: 1, hotspotRemoved: 0 } })),
  },
}));

let mockProfile: any = null;
let mockOverdueInvoices: any[] = [];
let mockDefaultProfileRow: any[] = [];
let mockDbQueries: any[] = [];

jest.mock("../../db/config", () => ({
  AppDataSource: {
    query: jest.fn(async (sql: string, params: any[]) => {
      mockDbQueries.push({ sql, params });
      if (sql.includes("SELECT default_profile_id FROM user_default_profiles")) {
        return mockDefaultProfileRow;
      }
      return [];
    }),
    getRepository: jest.fn((entity: any) => {
      const entityName = entity?.name || "";
      if (entityName === "ExternalInvoice") {
        return {
          createQueryBuilder: jest.fn(() => ({
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getMany: jest.fn(async () => mockOverdueInvoices),
          })),
        };
      }
      if (entityName === "Raduserprofile") {
        return {
          findOne: jest.fn(async ({ where }) => {
            if (mockProfile && where.username === mockProfile.username) {
              return mockProfile;
            }
            return null;
          }),
          save: jest.fn(async (obj) => {
            Object.assign(mockProfile, obj);
            return mockProfile;
          }),
        };
      }
      if (entityName === "Radprofile") {
        return {
          findOne: jest.fn(async () => ({ id: 5, profileName: "Standard-100Mbps" })),
        };
      }
      return {
        findOne: jest.fn(async () => null),
      };
    }),
  },
}));

describe("subscriberReactivationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbQueries = [];
    mockDefaultProfileRow = [{ default_profile_id: 5 }];
    mockOverdueInvoices = [];
    mockProfile = {
      username: "user_test_dunning",
      profileId: 99, // Throttled profile
      accountStatus: "suspended",
      isMonthlyExceeded: true,
      isFallback: true,
      expiresAt: new Date(Date.now() - 86400000), // Expired yesterday
    };
  });

  it("skips line restoration if subscriber still has remaining overdue invoices", async () => {
    mockOverdueInvoices = [
      {
        id: 101,
        username: "user_test_dunning",
        amount: 25,
        totalAmount: 25,
        amountPaid: 0,
        payDueDate: "2026-01-01",
        status: "unpaid",
      },
    ];

    const result = await restoreSubscriberLine("user_test_dunning");

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(false);
    expect(result.remainingOverdueInvoices).toBe(1);
    expect(mockProfile.accountStatus).toBe("suspended"); // Unchanged
    expect(UserController.disconnectUser).not.toHaveBeenCalled();
  });

  it("forces line restoration if force option is true, even with remaining overdue", async () => {
    mockOverdueInvoices = [
      {
        id: 101,
        username: "user_test_dunning",
        amount: 25,
        totalAmount: 25,
        amountPaid: 0,
        payDueDate: "2026-01-01",
        status: "unpaid",
      },
    ];

    const result = await restoreSubscriberLine("user_test_dunning", { force: true });

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(true);
    expect(mockProfile.accountStatus).toBe("active");
    expect(mockProfile.profileId).toBe(5); // Restored from user_default_profiles
    expect(mockProfile.isMonthlyExceeded).toBe(false);
    expect(mockProfile.isFallback).toBe(false);
    expect(UserController.disconnectUser).toHaveBeenCalledWith("user_test_dunning");
    expect(radiusAuthCacheService.invalidateUserCache).toHaveBeenCalledWith("user_test_dunning");
    expect(writeAuditLog).toHaveBeenCalled();
  });

  it("successfully restores throttled line to default profile when all invoices are paid", async () => {
    mockOverdueInvoices = []; // No overdue invoices

    const result = await restoreSubscriberLine("user_test_dunning", {
      actor: "cashier_john",
      invoiceId: 200,
      trigger: "external_invoice_paid",
    });

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.defaultProfileId).toBe(5);
    expect(mockProfile.profileId).toBe(5);
    expect(mockProfile.accountStatus).toBe("active");
    expect(UserController.disconnectUser).toHaveBeenCalledWith("user_test_dunning");
    expect(radiusAuthCacheService.invalidateUserCache).toHaveBeenCalledWith("user_test_dunning");
  });

  it("preserves base profile in user_default_profiles if not the throttle profile", async () => {
    process.env.DUNNING_THROTTLE_PROFILE_ID = "99";
    await preserveUserDefaultProfile("user_test_dunning", 7);

    expect(mockDbQueries.length).toBe(1);
    expect(mockDbQueries[0].sql).toContain("INSERT INTO user_default_profiles");
    expect(mockDbQueries[0].params).toEqual(["user_test_dunning", 7]);
  });

  it("does not overwrite user_default_profiles with the throttle profile itself", async () => {
    process.env.DUNNING_THROTTLE_PROFILE_ID = "99";
    await preserveUserDefaultProfile("user_test_dunning", 99);

    expect(mockDbQueries.length).toBe(0);
  });

  it("returns full enforcement state in getSubscriberDunningEnforcementState", async () => {
    process.env.DUNNING_THROTTLE_PROFILE_ID = "99";
    mockProfile.profileId = 99;

    const state = await getSubscriberDunningEnforcementState("user_test_dunning");

    expect(state).not.toBeNull();
    expect(state?.isThrottled).toBe(true);
    expect(state?.isSuspended).toBe(true);
    expect(state?.defaultProfileId).toBe(5);
    expect(state?.accountStatus).toBe("suspended");
  });
});
