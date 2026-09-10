import {
  collectorNameMatchesInvoiceName,
  extractPaymentNameFromMessage,
  extractPaymentLinesFromMessage,
  extractPaymentNamesFromMessage,
  normalizePaymentLookupKey,
  expandArabicSqlToken,
  parsePaymentLineFromPart,
  parseTrailingPaidAmount,
  splitNameTokens,
  subscriberIdentityKey,
} from "../whatsappPaymentGroupService";

describe("whatsappPaymentGroupService", () => {
  it("extracts plain names and strips paid prefixes", () => {
    expect(extractPaymentNameFromMessage("John Smith")).toBe("John Smith");
    expect(extractPaymentNameFromMessage("paid: John Smith")).toBe("John Smith");
    expect(extractPaymentNameFromMessage("PAY - john_smith")).toBe("john_smith");
  });

  it("normalizes lookup keys", () => {
    expect(normalizePaymentLookupKey("  John   Smith ")).toBe("john smith");
  });

  it("splits comma and newline separated names", () => {
    expect(extractPaymentNamesFromMessage("Ali Hassan, Sara Khoury")).toEqual(["Ali Hassan", "Sara Khoury"]);
    expect(extractPaymentNamesFromMessage("Ali Hassan\nSara Khoury\n")).toEqual(["Ali Hassan", "Sara Khoury"]);
    expect(extractPaymentNamesFromMessage("paid: Ali\nBob, Carol")).toEqual(["Ali", "Bob", "Carol"]);
    expect(extractPaymentNamesFromMessage("Ali Hassan, Ali Hassan")).toEqual(["Ali Hassan"]);
  });

  it("parses name + trailing amount", () => {
    expect(parsePaymentLineFromPart("طارق دعبول 25")).toEqual({ name: "طارق دعبول", amount: 25 });
    expect(parsePaymentLineFromPart("John Smith 19.5")).toEqual({ name: "John Smith", amount: 19.5 });
    expect(parsePaymentLineFromPart("John Smith")).toEqual({ name: "John Smith", amount: null });
    expect(parsePaymentLineFromPart("سامر دندش 0$")).toEqual({ name: "سامر دندش", amount: null });
    expect(parsePaymentLineFromPart("سامر دندش ٠$")).toEqual({ name: "سامر دندش", amount: null });
    expect(parsePaymentLineFromPart("سامر دندش $0")).toEqual({ name: "سامر دندش", amount: null });
    expect(extractPaymentLinesFromMessage("Ali 10\nBob 20")).toEqual([
      { name: "Ali", amount: 10 },
      { name: "Bob", amount: 20 },
    ]);
  });

  it("parses Arabic-Indic amount digits and currency prefixes", () => {
    expect(parseTrailingPaidAmount("٢٥")).toBe(25);
    expect(parseTrailingPaidAmount("٢٥٫٥")).toBe(25.5);
    expect(parseTrailingPaidAmount("0$")).toBe(0);
    expect(parseTrailingPaidAmount("٠$")).toBe(0);
    expect(parsePaymentLineFromPart("طارق دعبول ٢٥")).toEqual({ name: "طارق دعبول", amount: 25 });
    expect(parsePaymentLineFromPart("سامر دندش 0$")).toEqual({ name: "سامر دندش", amount: null });

    // User's exact batch cases with $ prefix and Arabic-Indic amounts
    expect(parsePaymentLineFromPart("$علي الشعار ٣٥")).toEqual({ name: "علي الشعار", amount: 35 });
    expect(parsePaymentLineFromPart("$عماد شحني ٤٠")).toEqual({ name: "عماد شحني", amount: 40 });
    expect(parsePaymentLineFromPart("$حسين احمد ٣٥")).toEqual({ name: "حسين احمد", amount: 35 });
    expect(parsePaymentLineFromPart("$محمد حكيم ٣٥")).toEqual({ name: "محمد حكيم", amount: 35 });
    expect(parsePaymentLineFromPart("$35 علي الشعار")).toEqual({ name: "علي الشعار", amount: 35 });
    expect(parsePaymentLineFromPart("35$ علي الشعار")).toEqual({ name: "علي الشعار", amount: 35 });

    const userBatch = "$علي الشعار ٣٥\n$عماد شحني ٤٠\n$حسين احمد ٣٥\n$محمد حكيم ٣٥";
    expect(extractPaymentLinesFromMessage(userBatch)).toEqual([
      { name: "علي الشعار", amount: 35 },
      { name: "عماد شحني", amount: 40 },
      { name: "حسين احمد", amount: 35 },
      { name: "محمد حكيم", amount: 35 },
    ]);
  });

  it("expands Arabic ة/ه and ال variants for SQL search", () => {
    const variants = expandArabicSqlToken("عواضة");
    expect(variants).toEqual(expect.arrayContaining(["عواضة", "عواضه"]));
    expect(expandArabicSqlToken("الشعار")).toEqual(expect.arrayContaining(["الشعار", "شعار"]));
    expect(expandArabicSqlToken("شعار")).toEqual(expect.arrayContaining(["شعار", "الشعار"]));
  });

  it("matches first and last when middle name omitted", () => {
    expect(collectorNameMatchesInvoiceName("Samir Dandash", "Samir Ahmad Dandash")).toBe(true);
    expect(collectorNameMatchesInvoiceName("سامر دندش", "سامر محمد دندش")).toBe(true);
    expect(collectorNameMatchesInvoiceName("Samir Dandash", "Samir Ali Dandash")).toBe(true);
    expect(collectorNameMatchesInvoiceName("Samir Dandash", "Karim Dandash")).toBe(false);

    // User's exact cases: first + last name match when middle name is omitted
    expect(collectorNameMatchesInvoiceName("علي الشعار", "علي محمد الشعار")).toBe(true);
    expect(collectorNameMatchesInvoiceName("علي الشعار", "علي احمد حسن الشعار")).toBe(true);
    expect(collectorNameMatchesInvoiceName("علي الشعار", "علي شعار")).toBe(true);
    expect(collectorNameMatchesInvoiceName("علي شعار", "علي محمد الشعار")).toBe(true);
    expect(collectorNameMatchesInvoiceName("عماد شحني", "عماد خليل شحني")).toBe(true);
    expect(collectorNameMatchesInvoiceName("عماد شحني", "عماد الشحني")).toBe(true);
    expect(collectorNameMatchesInvoiceName("حسين احمد", "حسين علي احمد")).toBe(true);
    expect(collectorNameMatchesInvoiceName("محمد حكيم", "محمد قاسم حكيم")).toBe(true);
    expect(collectorNameMatchesInvoiceName("محمد حكيم", "محمد الحكيم")).toBe(true);
  });

  it("matches reversed two-part names and both tokens anywhere in full name", () => {
    expect(collectorNameMatchesInvoiceName("طارق دعبول", "دعبول طارق")).toBe(true);
    expect(collectorNameMatchesInvoiceName("طارق دعبول", "طارق محمد دعبول")).toBe(true);
    expect(collectorNameMatchesInvoiceName("الشعار علي", "علي محمد الشعار")).toBe(true);
  });

  it("handles invisible Unicode bidirectional markers (LRM \\u200E, RLM \\u200F)", () => {
    // User's exact raw input containing invisible \u200E
    const textWithLRM = "$‎علي الشعار ٣٥\n$‎عماد شحني ٤٠\n$‎حسين احمد ٣٥\n$‎محمد حكيم ٣٥";
    const lines = extractPaymentLinesFromMessage(textWithLRM);
    expect(lines).toEqual([
      { name: "علي الشعار", amount: 35 },
      { name: "عماد شحني", amount: 40 },
      { name: "حسين احمد", amount: 35 },
      { name: "محمد حكيم", amount: 35 },
    ]);
    expect(lines[0].name.charCodeAt(0)).toBe(0x0639); // 'ع', NOT 0x200e
  });

  it("builds stable subscriber identity keys", () => {
    expect(subscriberIdentityKey({ username: "u1", fullName: "A B C" })).toBe("u1::a b c");
  });

  it("splitNameTokens trims and lowercases", () => {
    expect(splitNameTokens("  Foo   Bar ")).toEqual(["foo", "bar"]);
  });
});
