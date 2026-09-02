import { clickhouseRollupService } from "../clickhouseRollupService";

jest.mock("@clickhouse/client", () => ({
  createClient: jest.fn(() => ({
    command: jest.fn(async () => ({})),
    insert: jest.fn(async () => ({})),
    query: jest.fn(async () => ({
      json: jest.fn(async () => [
        {
          eventDate: "2026-09-01",
          username: "subscriber1",
          bytesIn: 104857600,
          bytesOut: 524288000,
          flowsCount: 1500,
        },
      ]),
    })),
  })),
}));

describe("ClickHouseRollupService", () => {
  it("should ensure schema tables exist", async () => {
    const success = await clickhouseRollupService.ensureSchema();
    expect(success).toBe(true);
  });

  it("should record CGNAT mapping record", async () => {
    await expect(
      clickhouseRollupService.recordCgnatMapping({
        privateIp: "10.100.1.50",
        privatePort: 5000,
        publicIp: "185.10.20.1",
        publicPortStart: 1000,
        publicPortEnd: 2000,
        username: "subscriber1",
      })
    ).resolves.not.toThrow();
  });

  it("should query subscriber daily bandwidth usage", async () => {
    const usage = await clickhouseRollupService.getSubscriberDailyUsage("subscriber1");
    expect(usage.length).toBe(1);
    expect(usage[0].username).toBe("subscriber1");
    expect(usage[0].bytesIn).toBe(104857600);
  });
});
