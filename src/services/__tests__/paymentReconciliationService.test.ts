import { paymentReconciliationService, PaymentWebhookPayload } from "../paymentReconciliationService";

jest.mock("../radiusAuthCacheService", () => ({
  radiusAuthCacheService: {
    invalidateUserCache: jest.fn(async () => {}),
  },
}));

jest.mock("../../audit/writeAuditLog", () => ({
  writeAuditLog: jest.fn(async () => {}),
}));

jest.mock("../../events/invoiceEvents", () => ({
  invoiceEvents: {
    emit: jest.fn(),
  },
}));

let mockIntent: any = null;
let mockProfile: any = null;

jest.mock("../../db/config", () => ({
  AppDataSource: {
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn(async () => {}),
      startTransaction: jest.fn(async () => {}),
      commitTransaction: jest.fn(async () => {}),
      rollbackTransaction: jest.fn(async () => {}),
      release: jest.fn(async () => {}),
      manager: {
        getRepository: jest.fn(() => ({
          findOne: jest.fn(async ({ where }) => {
            if (where.gatewayIntentId) return mockIntent;
            if (where.username) return mockProfile;
            return null;
          }),
          create: jest.fn((obj) => obj),
          save: jest.fn(async (obj) => {
            // Raduserprofile has accountStatus; PaymentIntent has gatewayIntentId
            if ("accountStatus" in obj) {
              Object.assign(mockProfile, obj);
            } else if (obj.gatewayIntentId) {
              mockIntent = obj;
            }
            return obj;
          }),
        })),
      },
    })),
  },
}));

describe("PaymentReconciliationService", () => {
  beforeEach(() => {
    mockIntent = null;
    mockProfile = {
      username: "subscriber_paid",
      accountStatus: "suspended",
      isMonthlyExceeded: true,
      expiresAt: new Date("2026-01-01"),
    };
    jest.clearAllMocks();
  });

  it("should process successful payment and re-activate subscriber line", async () => {
    const payload: PaymentWebhookPayload = {
      transactionReference: "TXN-998877",
      username: "subscriber_paid",
      amountPaid: 35.0,
      currency: "USD",
      status: "SUCCESS",
    };

    const result = await paymentReconciliationService.processPaymentWebhook(payload);

    expect(result.success).toBe(true);
    expect(result.reactivated).toBe(true);
    expect(mockProfile.accountStatus).toBe("active");
    expect(mockProfile.isMonthlyExceeded).toBe(false);
  });

  it("should prevent duplicate processing of completed payment intent", async () => {
    mockIntent = {
      gatewayIntentId: "TXN-EXISTS",
      username: "subscriber_paid",
      amount: 35.0,
      status: "succeeded",
    };

    const payload: PaymentWebhookPayload = {
      transactionReference: "TXN-EXISTS",
      username: "subscriber_paid",
      amountPaid: 35.0,
      currency: "USD",
      status: "SUCCESS",
    };

    const result = await paymentReconciliationService.processPaymentWebhook(payload);

    expect(result.success).toBe(true);
    expect(result.reactivated).toBe(false);
    expect(result.message).toContain("already processed");
  });

  it("should extend expiry by exactly 1 calendar month, not 30 days", async () => {
    const baseExpiry = new Date("2026-03-15T00:00:00.000Z");
    mockProfile = {
      username: "subscriber_paid",
      accountStatus: "suspended",
      isMonthlyExceeded: false,
      expiresAt: baseExpiry,
    };

    const payload: PaymentWebhookPayload = {
      transactionReference: "TXN-MONTH-TEST",
      username: "subscriber_paid",
      amountPaid: 25.0,
      currency: "USD",
      status: "SUCCESS",
    };

    await paymentReconciliationService.processPaymentWebhook(payload);

    const newExpiry = new Date(mockProfile.expiresAt);
    // Exactly 1 calendar month later (Apr 15), NOT 30 days later (Apr 14)
    expect(newExpiry.getMonth()).toBe(3); // April = 3 (0-indexed)
    expect(newExpiry.getDate()).toBe(15);
    expect(newExpiry.getFullYear()).toBe(2026);
  });

  it("should handle month-edge (Jan 31 + 1 month = Feb 28, not Mar 3)", async () => {
    const baseExpiry = new Date("2026-01-31T00:00:00.000Z");
    mockProfile = {
      username: "subscriber_paid",
      accountStatus: "expired",
      isMonthlyExceeded: false,
      expiresAt: baseExpiry,
    };

    const payload: PaymentWebhookPayload = {
      transactionReference: "TXN-EDGE-JAN31",
      username: "subscriber_paid",
      amountPaid: 25.0,
      currency: "USD",
      status: "SUCCESS",
    };

    await paymentReconciliationService.processPaymentWebhook(payload);

    const newExpiry = new Date(mockProfile.expiresAt);
    // Feb 2026 has 28 days; must NOT overshoot into March
    expect(newExpiry.getMonth()).toBe(1); // February = 1
    expect(newExpiry.getDate()).toBe(28);
  });
});
