import axios from "axios";
import { sendWhatsAppMessageStrict } from "../whatsappService";

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("whatsappService Twilio authentication fallback", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC_test_account";
    process.env.TWILIO_AUTH_TOKEN = "account_auth_token";
    process.env.TWILIO_API_KEY_SID = "SK_stale_key";
    process.env.TWILIO_API_KEY_SECRET = "stale_key_secret";
    process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+14155550123";
    process.env.TWILIO_CONTENT_SID = "HX_payment_template";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("retries with the account auth token after an API-key 401", async () => {
    mockedAxios.post
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ data: { sid: "SM_sent", status: "queued" } });
    mockedAxios.get.mockResolvedValue({
      data: { sid: "SM_sent", status: "queued" },
    });

    const result = await sendWhatsAppMessageStrict({
      to: "96170123456",
      message: "Payment received",
      templateKind: "payment",
      templateVariables: { "1": "Customer", "2": "11170", "3": "10.00" },
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post.mock.calls[0][2]?.auth?.username).toBe("SK_stale_key");
    expect(mockedAxios.post.mock.calls[1][2]?.auth?.username).toBe("AC_test_account");
    expect(result).toMatchObject({ provider: "twilio", sid: "SM_sent", status: "queued" });
  });

  it("does not retry errors that are not authentication failures", async () => {
    mockedAxios.post.mockRejectedValueOnce({ response: { status: 400 } });

    await expect(
      sendWhatsAppMessageStrict({
        to: "96170123456",
        message: "Payment received",
        templateKind: "payment",
      })
    ).rejects.toThrow("Twilio WhatsApp send failed");

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
