import { PERMISSIONS } from "../permissions";

describe("permission catalog", () => {
  it("includes the dunning write permission used by POST /invoices/external/dunning/run", () => {
    expect(PERMISSIONS).toContain("billing.externalInvoices.dunning");
  });

  it("keeps dunning distinct from view and pay", () => {
    expect(PERMISSIONS).toContain("billing.externalInvoices.view");
    expect(PERMISSIONS).toContain("billing.externalInvoices.pay");
    expect("billing.externalInvoices.dunning").not.toBe("billing.externalInvoices.pay");
  });

  it("includes company wallet permissions", () => {
    expect(PERMISSIONS).toContain("billing.companyWallet.view");
    expect(PERMISSIONS).toContain("billing.companyWallet.manage");
    expect(PERMISSIONS).toContain("ui.sidebar.admin.companyWallet.show");
  });
});
