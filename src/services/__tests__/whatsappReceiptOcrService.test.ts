import {
  detectReceiptProvider,
  extractReferenceId,
  extractReceiptAmount,
  extractCandidateNames,
  parseReceiptOcrText,
} from "../whatsappReceiptOcrService";

describe("whatsappReceiptOcrService", () => {
  describe("Whish Money receipt parsing", () => {
    const whishSample = `
      WHISH MONEY
      Payment Successful
      Ref: WH-98765432
      Recipient: Ahmad Khalil
      Amount: $25.00
      Date: 2026-09-05 14:22:01
      Phone: 70123456
    `;

    it("detects Whish provider", () => {
      expect(detectReceiptProvider(whishSample)).toBe("whish");
    });

    it("extracts Whish reference ID", () => {
      expect(extractReferenceId(whishSample)).toBe("WH-98765432");
    });

    it("extracts payment amount and currency", () => {
      const { amount, currency } = extractReceiptAmount(whishSample);
      expect(amount).toBe(25.0);
      expect(currency).toBe("USD");
    });

    it("extracts recipient name and phone", () => {
      const { names, phoneNumber } = extractCandidateNames(whishSample);
      expect(names).toContain("Ahmad Khalil");
      expect(phoneNumber).toBe("70123456");
    });

    it("builds a complete structured receipt payload with high confidence", () => {
      const parsed = parseReceiptOcrText(whishSample);
      expect(parsed.provider).toBe("whish");
      expect(parsed.referenceId).toBe("WH-98765432");
      expect(parsed.amount).toBe(25.0);
      expect(parsed.senderName).toBe("Ahmad Khalil");
      expect(parsed.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe("OMT / Western Union transfer slip parsing", () => {
    const omtSample = `
      OMT S.A.L.
      Western Union Money Transfer
      MTCN: 1234567890
      Beneficiary: جورج خوري
      Total: 40.00 USD
      Agent: Beirut Downtown
    `;

    it("detects OMT provider", () => {
      expect(detectReceiptProvider(omtSample)).toBe("omt");
    });

    it("extracts MTCN reference number", () => {
      expect(extractReferenceId(omtSample)).toBe("1234567890");
    });

    it("extracts amount correctly", () => {
      const { amount, currency } = extractReceiptAmount(omtSample);
      expect(amount).toBe(40.0);
      expect(currency).toBe("USD");
    });

    it("extracts Arabic beneficiary name", () => {
      const { names } = extractCandidateNames(omtSample);
      expect(names).toContain("جورج خوري");
    });
  });

  describe("BOB Finance / Bank transfer parsing", () => {
    const bobSample = `
      BOB FINANCE
      Cash In Receipt
      Txn ID: BOB-55443322
      Customer: سامر دندش
      Amount: 15.50 $
    `;

    it("detects BOB provider", () => {
      expect(detectReceiptProvider(bobSample)).toBe("bob");
    });

    it("extracts BOB Txn ID", () => {
      expect(extractReferenceId(bobSample)).toBe("BOB-55443322");
    });

    it("extracts decimal amount", () => {
      const { amount } = extractReceiptAmount(bobSample);
      expect(amount).toBe(15.5);
    });
  });
});
