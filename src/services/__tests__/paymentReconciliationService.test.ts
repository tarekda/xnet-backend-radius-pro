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
        getRepository: jest.fn((entity) => ({
          findOne: jest.fn(async ({ where }) => {
            if (where.gatewayIntentId) return mockIntent;
            if (where.username) return mockProfile;
            return null;
          }),
          create: jest.fn((obj) => obj),
          save: jest.fn(async (obj) => {
            if (obj.gatewayIntentId) mockIntent = obj;
            if (obj.username) mockProfile = obj;
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
});
