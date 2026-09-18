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
    const now = new Date();
    // 15th of the month, two months ahead — always in the future so the service
    // extends from the stored expiry (baseDate = max(expiresAt, now)) rather than today.
    const baseExpiry = new Date(now.getFullYear(), now.getMonth() + 2, 15, 0, 0, 0, 0);
    const expected = new Date(now.getFullYear(), now.getMonth() + 3, 15, 0, 0, 0, 0);
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
    // Exactly 1 calendar month later, NOT 30 days later.
    expect(newExpiry.getFullYear()).toBe(expected.getFullYear());
    expect(newExpiry.getMonth()).toBe(expected.getMonth());
    expect(newExpiry.getDate()).toBe(15);
  });

  it("should handle month-edge (Jan 31 + 1 month = last day of Feb)", async () => {
    const year = new Date().getFullYear() + 1;
    const baseExpiry = new Date(year, 0, 31, 0, 0, 0, 0); // Jan 31 next year (always future)
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
    // Feb has 28 or 29 days; must NOT overshoot into March.
    const lastDayOfFeb = new Date(year, 2, 0).getDate();
    expect(newExpiry.getFullYear()).toBe(year);
    expect(newExpiry.getMonth()).toBe(1); // February
    expect(newExpiry.getDate()).toBe(lastDayOfFeb);
  });
});
