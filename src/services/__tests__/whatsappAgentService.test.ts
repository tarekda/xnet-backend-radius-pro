import {
  extractPhoneLookupDigits,
  classifyConversationalIntent,
  isPaymentLineMessage,
  buildBatchPaymentReply,
  generateAgentResponse,
  buildMenuMessage,
  SubscriberContext,
} from "../whatsappAgentService";
import { UserController } from "../../controllers/userController";

jest.mock("../../controllers/userController", () => ({
  UserController: {
    disconnectUser: jest.fn(async () => ({ ok: true, method: "mikrotik-api", result: { pppRemoved: 1, hotspotRemoved: 0 } })),
  },
}));

jest.mock("../topupService", () => ({
  getTopupPlans: jest.fn(async () => [
    { id: 1, name: "Turbo Boost 20GB", gb: 20, price: 3.0, formattedPrice: "$3.00" },
    { id: 2, name: "Turbo Boost 50GB", gb: 50, price: 6.0, formattedPrice: "$6.00" },
  ]),
  getSubscriberActiveTopupBytes: jest.fn(async () => BigInt(0)),
  purchaseTopupPack: jest.fn(async () => ({
    success: true,
    unthrottled: true,
    topup: { id: "1" },
  })),
}));

describe("whatsappAgentService", () => {
  describe("extractPhoneLookupDigits", () => {
    it("extracts last 8 digits from various phone formats", () => {
      expect(extractPhoneLookupDigits("+96170123456")).toBe("70123456");
      expect(extractPhoneLookupDigits("03123456")).toBe("03123456");
      expect(extractPhoneLookupDigits("whatsapp:+961 71 987 654")).toBe("71987654");
      expect(extractPhoneLookupDigits("01-234567")).toBe("01234567");
    });
  });

  describe("classifyConversationalIntent", () => {
    it("classifies English intents accurately", () => {
      expect(classifyConversationalIntent("How much is my bill?")).toBe("bill_inquiry");
      expect(classifyConversationalIntent("What is my account status?")).toBe("account_status");
      expect(classifyConversationalIntent("How much quota do I have left?")).toBe("quota_inquiry");
      expect(classifyConversationalIntent("How can I pay my invoice?")).toBe("how_to_pay");
      expect(classifyConversationalIntent("My internet is very slow")).toBe("reconnect_speed");
      expect(classifyConversationalIntent("I want to speak with an agent")).toBe("support_escalation");
      expect(classifyConversationalIntent("hello")).toBe("greeting_menu");
    });

    it("classifies Franco-Arab (Lebanese transliteration) intents accurately", () => {
      expect(classifyConversationalIntent("addeh el fattoura")).toBe("bill_inquiry");
      expect(classifyConversationalIntent("shou 3layi masari")).toBe("bill_inquiry");
      expect(classifyConversationalIntent("w2tish byekhlas el net")).toBe("account_status");
      expect(classifyConversationalIntent("emta byentehe el ishtirak")).toBe("account_status");
      expect(classifyConversationalIntent("kam giga ba2i ma3i")).toBe("quota_inquiry");
      expect(classifyConversationalIntent("kif fiyye idfa3")).toBe("how_to_pay");
      expect(classifyConversationalIntent("el net kteer bati2")).toBe("reconnect_speed");
      expect(classifyConversationalIntent("bade ehke ma3 mowazzaf")).toBe("support_escalation");
      expect(classifyConversationalIntent("marhaba")).toBe("greeting_menu");
    });

    it("classifies Arabic intents accurately", () => {
      expect(classifyConversationalIntent("كم حسابي")).toBe("bill_inquiry");
      expect(classifyConversationalIntent("قديش عليي فاتورة")).toBe("bill_inquiry");
      expect(classifyConversationalIntent("متى ينتهي اشتراكي")).toBe("account_status");
      expect(classifyConversationalIntent("كم باقي غيغا")).toBe("quota_inquiry");
      expect(classifyConversationalIntent("طريقة الدفع")).toBe("how_to_pay");
      expect(classifyConversationalIntent("الانترنت بطيء")).toBe("reconnect_speed");
      expect(classifyConversationalIntent("تحدث مع موظف")).toBe("support_escalation");
      expect(classifyConversationalIntent("مرحبا")).toBe("greeting_menu");
    });

    it("handles numeric menu shortcuts", () => {
      expect(classifyConversationalIntent("1")).toBe("bill_inquiry");
      expect(classifyConversationalIntent("2")).toBe("account_status");
      expect(classifyConversationalIntent("3")).toBe("quota_inquiry");
      expect(classifyConversationalIntent("4")).toBe("how_to_pay");
      expect(classifyConversationalIntent("5")).toBe("reconnect_speed");
      expect(classifyConversationalIntent("6")).toBe("topup_inquiry");
      expect(classifyConversationalIntent("7")).toBe("support_escalation");
    });

    it("classifies topup and turbo boost intents accurately", () => {
      expect(classifyConversationalIntent("I want to topup 50GB")).toBe("topup_inquiry");
      expect(classifyConversationalIntent("baddi zide giga")).toBe("topup_inquiry");
      expect(classifyConversationalIntent("turbo boost extra")).toBe("topup_inquiry");
      expect(classifyConversationalIntent("بدي اشحن باقة اضافية")).toBe("topup_inquiry");
    });

    it("detects receipt payment when media is present", () => {
      expect(classifyConversationalIntent("", true)).toBe("receipt_payment");
      expect(classifyConversationalIntent("whish transfer", true)).toBe("receipt_payment");
    });
  });

  describe("generateAgentResponse", () => {
    const mockSubscriberWithBill: SubscriberContext = {
      username: "user_ahmad",
      fullName: "Ahmad Khalil",
      phoneNumber: "70123456",
      accountStatus: "active",
      expiresAt: new Date("2026-10-01"),
      profileName: "Fiber-300M",
      openInvoices: [
        {
          id: 401,
          amount: 35,
          amountPaid: 0,
          remainingDue: 35,
          billingMonth: "2026-09",
          dueDate: "2026-09-15",
        },
      ],
      totalDue: 35,
    };

    const mockPaidSubscriber: SubscriberContext = {
      username: "user_sarah",
      fullName: "Sarah Mansour",
      phoneNumber: "71987654",
      accountStatus: "active",
      expiresAt: new Date("2026-10-15"),
      profileName: "Fast-100M",
      openInvoices: [],
      totalDue: 0,
    };

    it("generates detailed bill inquiry response for subscriber with balance", async () => {
      const response = await generateAgentResponse("bill_inquiry", mockSubscriberWithBill);

      expect(response).toContain("Ahmad Khalil");
      expect(response).toContain("Invoice #401");
      expect(response).toContain("$35.00");
      expect(response).toContain("Whish Money");
    });

    it("generates fully-paid response when subscriber has zero due", async () => {
      const response = await generateAgentResponse("bill_inquiry", mockPaidSubscriber);

      expect(response).toContain("Great news");
      expect(response).toContain("no outstanding invoices");
      expect(response).toContain("user_sarah");
    });

    it("generates account status response with profile and expiry", async () => {
      const response = await generateAgentResponse("account_status", mockSubscriberWithBill);

      expect(response).toContain("Fiber-300M");
      expect(response).toContain("Active (Full Speed)");
      expect(response).toContain("Pending Due:");
      expect(response).toContain("$35.00");
    });

    it("generates reconnect response and triggers network session refresh", async () => {
      const response = await generateAgentResponse("reconnect_speed", mockPaidSubscriber);

      expect(response).toContain("Connection Refreshed");
      expect(UserController.disconnectUser).toHaveBeenCalledWith("user_sarah");
    });

    it("warns about overdue balance when throttled user requests speed reconnect", async () => {
      const throttledUser: SubscriberContext = {
        ...mockSubscriberWithBill,
        accountStatus: "suspended",
      };

      const response = await generateAgentResponse("reconnect_speed", throttledUser);

      expect(response).toContain("Connection Notice");
      expect(response).toContain("overdue balance of *$35.00*");
    });

    it("generates turbo boost catalog when no specific pack is mentioned", async () => {
      const response = await generateAgentResponse("topup_inquiry", mockSubscriberWithBill);
      expect(response).toContain("Turbo Boost");
      expect(response).toContain("20GB");
    });

    it("activates topup pack when specific pack is requested", async () => {
      const response = await generateAgentResponse("topup_inquiry", mockSubscriberWithBill, "topup 50gb");
      expect(response).toContain("Turbo Boost Activated");
      expect(response).toContain("50 GB");
    });

    it("builds friendly self-service menu", () => {
      const menu = buildMenuMessage("Ahmad");

      expect(menu).toContain("Hello *Ahmad*");
      expect(menu).toContain("1️⃣ *Check Bill & Balance*");
      expect(menu).toContain("Whish / OMT");
    });
  });

  describe("isPaymentLineMessage & Batch Payment Parser", () => {
    it("detects single name with trailing amount", () => {
      expect(isPaymentLineMessage("Ahmad Khalil 35")).toBe(true);
      expect(isPaymentLineMessage("Sarah Mansour 40$")).toBe(true);
      expect(isPaymentLineMessage("ali_user 25.50")).toBe(true);
      expect(isPaymentLineMessage("طارق دعبول 25")).toBe(true);
    });

    it("detects multi-line names and amounts across newlines and commas", () => {
      const multiLine = "Ahmad Khalil 35\nSarah Mansour 40\nCharbel Haddad 50";
      expect(isPaymentLineMessage(multiLine)).toBe(true);
      expect(classifyConversationalIntent(multiLine)).toBe("batch_payment");

      const commaList = "Ahmad Khalil 35, Sarah Mansour 40, Charbel Haddad 50";
      expect(isPaymentLineMessage(commaList)).toBe(true);
      expect(classifyConversationalIntent(commaList)).toBe("batch_payment");

      const namesWithoutAmount = "Ahmad Khalil\nSarah Mansour\nCharbel Haddad";
      expect(isPaymentLineMessage(namesWithoutAmount)).toBe(true);
      expect(classifyConversationalIntent(namesWithoutAmount)).toBe("batch_payment");
    });

    it("detects explicit staff payment prefixes", () => {
      expect(isPaymentLineMessage("paid: Ahmad Khalil 35")).toBe(true);
      expect(isPaymentLineMessage("تم الدفع: احمد خليل 35")).toBe(true);
      expect(isPaymentLineMessage("pay: user123")).toBe(true);
      expect(classifyConversationalIntent("paid: Ahmad Khalil 35")).toBe("batch_payment");
    });

    it("does not falsely classify general inquiries as batch payments", () => {
      expect(isPaymentLineMessage("How much is my bill?")).toBe(false);
      expect(isPaymentLineMessage("How can I pay?")).toBe(false);
      expect(isPaymentLineMessage("hello")).toBe(false);
      expect(isPaymentLineMessage("1")).toBe(false);
    });

    it("formats itemized multi-line confirmation report in buildBatchPaymentReply", () => {
      const mockBatchResult: any = {
        ok: true,
        names: ["Ahmad Khalil", "Sarah Mansour", "Charbel Haddad"],
        paidInvoiceIds: [101, 102],
        results: [
          { name: "Ahmad Khalil", status: "paid", amount: 35, paidInvoiceIds: [101], billingMonth: "2026-09" },
          { name: "Sarah Mansour", status: "paid", amount: 40, paidInvoiceIds: [102], billingMonth: "2026-09" },
          { name: "Charbel Haddad", status: "no_match", amount: 50 },
        ],
      };

      const reply = buildBatchPaymentReply(mockBatchResult);
      expect(reply).toContain("Batch Payment Report");
      expect(reply).toContain("*Paid:* 2");
      expect(reply).toContain("*No Match:* 1");
      expect(reply).toContain("*Total Amount:* *$75.00*");
      expect(reply).toContain("Ahmad Khalil*: Paid $35.00 (#101)");
      expect(reply).toContain("Sarah Mansour*: Paid $40.00 (#102)");
      expect(reply).toContain("Charbel Haddad*: No unpaid invoice found");
      expect(reply).toContain("CoA throttle release");
    });

    it("formats concise single-line payment confirmation in buildBatchPaymentReply", () => {
      const mockSingleResult: any = {
        ok: true,
        names: ["Ahmad Khalil"],
        paidInvoiceIds: [101],
        results: [
          { name: "Ahmad Khalil", status: "paid", amount: 35, paidInvoiceIds: [101], billingMonth: "2026-09" },
        ],
      };

      const reply = buildBatchPaymentReply(mockSingleResult);
      expect(reply).toContain("Payment Confirmed & Line Activated");
      expect(reply).toContain("Ahmad Khalil");
      expect(reply).toContain("$35.00");
      expect(reply).toContain("Invoice Paid:* #101");
      expect(reply).toContain("Speed throttle has been removed");
    });
  });
});
