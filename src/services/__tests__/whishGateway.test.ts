import { isWhishConfigured, resolveWhishAmount } from "../whishGateway";

describe("whishGateway", () => {
  const prev = {
    website: process.env.WHISH_WEBSITE,
    secret: process.env.WHISH_SECRET,
    fx: process.env.FX_SECONDARY_PER_PRIMARY,
  };

  afterEach(() => {
    if (prev.website === undefined) delete process.env.WHISH_WEBSITE;
    else process.env.WHISH_WEBSITE = prev.website;
    if (prev.secret === undefined) delete process.env.WHISH_SECRET;
    else process.env.WHISH_SECRET = prev.secret;
    if (prev.fx === undefined) delete process.env.FX_SECONDARY_PER_PRIMARY;
    else process.env.FX_SECONDARY_PER_PRIMARY = prev.fx;
  });

  it("isWhishConfigured requires website + secret", () => {
    delete process.env.WHISH_WEBSITE;
    delete process.env.WHISH_SECRET;
    expect(isWhishConfigured()).toBe(false);
    process.env.WHISH_WEBSITE = "example.com";
    process.env.WHISH_SECRET = "tok";
    expect(isWhishConfigured()).toBe(true);
  });

  it("resolveWhishAmount converts LBP via FX rate", () => {
    process.env.FX_SECONDARY_PER_PRIMARY = "100";
    expect(resolveWhishAmount(2.5, "USD")).toBe(2.5);
    expect(resolveWhishAmount(2.5, "LBP")).toBe(250);
  });
});
