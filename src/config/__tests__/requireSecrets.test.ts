describe("requireSecrets", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it("allows insecure defaults outside production", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.JWT_SECRET;
    const { getJwtSecret } = await import("../../config/requireSecrets");
    expect(getJwtSecret()).toBe("your_jwt_secret");
  });

  it("throws in production when JWT_SECRET is missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;
    const { getJwtSecret } = await import("../../config/requireSecrets");
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
  });

  it("throws in production when JWT_SECRET is a known default", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "your_jwt_secret";
    const { getJwtSecret } = await import("../../config/requireSecrets");
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
  });

  it("accepts a strong secret in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a-strong-production-secret-value";
    const { getJwtSecret } = await import("../../config/requireSecrets");
    expect(getJwtSecret()).toBe("a-strong-production-secret-value");
  });

  it("uses an explicitly set weak MikroTik password in production (with warning)", async () => {
    process.env.NODE_ENV = "production";
    process.env.MIKROTIK_PASSWORD = "123456";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { getMikroTikPassword } = await import("../../config/requireSecrets");
    expect(getMikroTikPassword()).toBe("123456");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not invent a MikroTik password when unset in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.MIKROTIK_PASSWORD;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { getMikroTikPassword } = await import("../../config/requireSecrets");
    expect(getMikroTikPassword()).toBeUndefined();
    warn.mockRestore();
  });
});
