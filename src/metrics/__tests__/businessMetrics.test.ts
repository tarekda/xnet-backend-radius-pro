import { recordInvoicePayment, recordSessionDisconnect, recordDunningRun } from "../../metrics/metrics";

describe("P2 metrics helpers are callable", () => {
  it("records invoice/disconnect/dunning counters without throwing", () => {
    expect(() => recordInvoicePayment("pay", "ok")).not.toThrow();
    expect(() => recordSessionDisconnect("mikrotik-api", "ok")).not.toThrow();
    expect(() => recordDunningRun("ok", { remind: 2 })).not.toThrow();
  });
});
