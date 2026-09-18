import { AppDataSource } from "../../db/config";
import { invoiceEvents } from "../../events/invoiceEvents";
import { writeAuditLog } from "../../audit/writeAuditLog";
import { payExternalInvoice } from "../invoiceService";
import {
  handlePaymentWebhook,
  parseWhishCallbackPayload,
  verifyProviderWebhookAuth,
  voidCreditNote,
} from "../paymentGatewayService";

jest.mock("../../db/config", () => ({ AppDataSource: { getRepository: jest.fn() } }));
jest.mock("../../events/invoiceEvents", () => ({
  invoiceEvents: { emitModification: jest.fn() },
}));
jest.mock("../../audit/writeAuditLog", () => ({ writeAuditLog: jest.fn() }));
jest.mock("../invoiceService", () => ({ payExternalInvoice: jest.fn() }));
jest.mock("../whishGateway", () => ({
  isWhishConfigured: jest.fn(() => false),
  createWhishPaymentInvoice: jest.fn(),
  resolveWhishAmount: jest.fn((n: number) => n),
}));

describe("paymentGatewayService webhook helpers", () => {
  const prevRelaxed = process.env.PAYMENT_WEBHOOK_RELAXED;
  const prevWhish = process.env.WHISH_SECRET;
  const prevHmac = process.env.PAYMENT_WEBHOOK_SECRET;

  afterEach(() => {
    if (prevRelaxed === undefined) delete process.env.PAYMENT_WEBHOOK_RELAXED;
    else process.env.PAYMENT_WEBHOOK_RELAXED = prevRelaxed;
    if (prevWhish === undefined) delete process.env.WHISH_SECRET;
    else process.env.WHISH_SECRET = prevWhish;
    if (prevHmac === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = prevHmac;
  });

  it("parseWhishCallbackPayload reads order_id and status", () => {
    expect(
      parseWhishCallbackPayload({ order_id: "whish_1_2", status: "success" }, null)
    ).toEqual({ gatewayIntentId: "whish_1_2", status: "success" });
    expect(
      parseWhishCallbackPayload(null, { orderId: "abc", payment_status: "paid" })
    ).toEqual({ gatewayIntentId: "abc", status: "paid" });
  });

  it("ignores PAYMENT_WEBHOOK_RELAXED in production", () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.PAYMENT_WEBHOOK_RELAXED = "1";
    process.env.WHISH_SECRET = "s3cret";
    expect(
      verifyProviderWebhookAuth({
        provider: "whish",
        rawBody: "{}",
        secretParam: "wrong",
      })
    ).toBe(false);
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  });

  it("verifyProviderWebhookAuth accepts WHISH_SECRET for whish", () => {
    process.env.PAYMENT_WEBHOOK_RELAXED = "0";
    process.env.WHISH_SECRET = "s3cret";
    process.env.PAYMENT_WEBHOOK_SECRET = "hmac";
    expect(
      verifyProviderWebhookAuth({
        provider: "whish",
        rawBody: "{}",
        secretParam: "s3cret",
      })
    ).toBe(true);
    expect(
      verifyProviderWebhookAuth({
        provider: "whish",
        rawBody: "{}",
        secretParam: "wrong",
      })
    ).toBe(false);
  });
});

describe("handlePaymentWebhook provider binding", () => {
  const mockedPay = payExternalInvoice as jest.MockedFunction<typeof payExternalInvoice>;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevHmac = process.env.PAYMENT_WEBHOOK_SECRET;

  const pendingIntent = (provider: string) => ({
    id: 1,
    externalInvoiceId: 5,
    gatewayIntentId: provider === "whish" ? "whish_5_1700000000000" : "stub_5_1700000000000",
    gatewayProvider: provider,
    status: "pending",
    amount: 10,
    currency: "USD",
  });

  /** Minimal repository double for the claim-and-settle path. */
  const wireRepo = (intent: Record<string, unknown>) => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const findOne = jest.fn().mockResolvedValue(intent);
    const save = jest.fn().mockResolvedValue(intent);
    (AppDataSource.getRepository as jest.Mock).mockReturnValue({
      findOne,
      save,
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      })),
    });
    return { findOne, save };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Jest runs with NODE_ENV=test, so the stub provider is available here.
    process.env.NODE_ENV = "test";
    process.env.PAYMENT_WEBHOOK_SECRET = "test-hmac";
  });

  afterAll(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevHmac === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = prevHmac;
  });

  it("refuses to settle a whish intent through the stub provider", async () => {
    const intent = pendingIntent("whish");
    wireRepo(intent);

    await expect(
      handlePaymentWebhook("stub", { gatewayIntentId: String(intent.gatewayIntentId), status: "succeeded" })
    ).rejects.toThrow(/Provider mismatch/);

    expect(mockedPay).not.toHaveBeenCalled();
  });

  it("refuses the stub provider in production, before any intent lookup", async () => {
    process.env.NODE_ENV = "production";
    const intent = pendingIntent("stub");
    const { findOne } = wireRepo(intent);

    await expect(
      handlePaymentWebhook("stub", { gatewayIntentId: String(intent.gatewayIntentId), status: "succeeded" })
    ).rejects.toThrow(/not available in production/);

    expect(findOne).not.toHaveBeenCalled();
    expect(mockedPay).not.toHaveBeenCalled();
  });

  it("settles an intent when the provider matches", async () => {
    const intent = pendingIntent("whish");
    wireRepo(intent);

    const settled = await handlePaymentWebhook("whish", {
      gatewayIntentId: String(intent.gatewayIntentId),
      status: "succeeded",
    });

    expect(settled.status).toBe("succeeded");
    expect(mockedPay).toHaveBeenCalledWith(5, "gateway", "gateway");
    expect(writeAuditLog).toHaveBeenCalled();
  });
});

describe("voidCreditNote", () => {
  const getRepository = AppDataSource.getRepository as jest.Mock;
  const emitModification = invoiceEvents.emitModification as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("retains and marks a credit note void with actor and reason", async () => {
    const note = {
      id: 42,
      username: "alice",
      documentType: "credit_note",
      parentInvoiceId: 7,
      voidedAt: null,
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(note),
      save: jest.fn(async (value) => value),
    };
    getRepository.mockReturnValue(repo);

    const result = await voidCreditNote(42, "admin", "Created for wrong invoice");

    expect(result.voidedAt).toBeInstanceOf(Date);
    expect(result.voidedBy).toBe("admin");
    expect(result.voidReason).toBe("Created for wrong invoice");
    expect(repo.save).toHaveBeenCalledWith(note);
    expect(emitModification).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 42, action: "VOIDED" })
    );
    expect(emitModification).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 7, action: "UPDATED" })
    );
  });

  it("rejects a normal invoice", async () => {
    getRepository.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        id: 1,
        documentType: "invoice",
        voidedAt: null,
      }),
    });

    await expect(voidCreditNote(1, "admin", "Wrong document")).rejects.toThrow(
      "Only credit notes can be voided"
    );
  });

  it("rejects an already voided credit note", async () => {
    getRepository.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({
        id: 2,
        documentType: "credit_note",
        voidedAt: new Date(),
      }),
    });

    await expect(voidCreditNote(2, "admin", "Duplicate request")).rejects.toThrow(
      "already voided"
    );
  });

  it("requires a meaningful reason", async () => {
    await expect(voidCreditNote(2, "admin", "x")).rejects.toThrow(
      "at least 3 characters"
    );
    expect(getRepository).not.toHaveBeenCalled();
  });
});
