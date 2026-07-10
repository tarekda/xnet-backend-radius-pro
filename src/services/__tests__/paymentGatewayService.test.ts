import { parseWhishCallbackPayload, verifyProviderWebhookAuth } from "../paymentGatewayService";

jest.mock("../../db/config", () => ({ AppDataSource: { getRepository: jest.fn() } }));
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
