import {
  evaluateCondition,
  formatAlertMessage,
  mergeAlertSettings,
  parseMetricType,
  toMetricObject,
  DEFAULT_ALERT_SETTINGS,
} from "../alertMetrics";

describe("parseMetricType", () => {
  it("reads a type string", () => {
    expect(parseMetricType("users")).toBe("users");
    expect(parseMetricType("nope")).toBeNull();
  });

  it("reads the frontend metric object", () => {
    expect(
      parseMetricType({
        type: "auth_failed_attempts",
        label: "Failed Authentication Attempts",
        unit: "attempts",
        description: "x",
      })
    ).toBe("auth_failed_attempts");
  });
});

describe("toMetricObject", () => {
  it("returns catalog metadata for known types", () => {
    expect(toMetricObject("users").label).toBe("Active Users");
    expect(toMetricObject("auth_success_rate").unit).toBe("%");
  });

  it("falls back for unknown types", () => {
    expect(toMetricObject("test")).toEqual({
      type: "test",
      label: "test",
      unit: "",
      description: "",
    });
  });
});

describe("evaluateCondition", () => {
  it("compares greater_than / less_than / equals", () => {
    expect(evaluateCondition("greater_than", 12, 10)).toBe(true);
    expect(evaluateCondition("greater_than", 10, 10)).toBe(false);
    expect(evaluateCondition("less_than", 85, 90)).toBe(true);
    expect(evaluateCondition("equals", 5, 5)).toBe(true);
    expect(evaluateCondition("not_equals", 1, 2)).toBe(true);
  });

  it("does not treat percentage_change as a live condition", () => {
    expect(evaluateCondition("percentage_change", 50, 10)).toBe(false);
  });

  it("rejects non-finite numbers", () => {
    expect(evaluateCondition("greater_than", Number.NaN, 1)).toBe(false);
  });
});

describe("formatAlertMessage", () => {
  it("describes a breached user threshold", () => {
    const msg = formatAlertMessage("users", 1234, 1000, "greater_than");
    expect(msg).toContain("exceeded");
    expect(msg).toContain("Active Users");
  });

  it("describes a dropped auth success rate", () => {
    const msg = formatAlertMessage("auth_success_rate", 85, 90, "less_than");
    expect(msg).toContain("dropped below");
    expect(msg).toContain("85%");
    expect(msg).toContain("90%");
  });
});

describe("mergeAlertSettings", () => {
  it("keeps defaults for omitted nested fields", () => {
    const next = mergeAlertSettings(DEFAULT_ALERT_SETTINGS, {
      emailNotifications: true,
      quietHours: { ...DEFAULT_ALERT_SETTINGS.quietHours, enabled: true },
    });
    expect(next.emailNotifications).toBe(true);
    expect(next.inAppNotifications).toBe(true);
    expect(next.quietHours.enabled).toBe(true);
    expect(next.quietHours.startTime).toBe("22:00");
  });
});
