import { radiusAccountingQueueService, AccountingUpdatePayload } from "../radiusAccountingQueueService";
import { redisClient } from "../../redisClient";

const queues: Record<string, string[]> = {
  "radius:accounting:queue": [],
  "radius:accounting:dlq": [],
};

jest.mock("../../redisClient", () => ({
  redisClient: {
    isOpen: true,
    rPush: jest.fn(async (key: string, val: string) => {
      if (!queues[key]) queues[key] = [];
      queues[key].push(val);
      return queues[key].length;
    }),
    lLen: jest.fn(async (key: string) => (queues[key] ?? []).length),
    lPop: jest.fn(async (key: string) => {
      const q = queues[key];
      return q && q.length ? q.shift()! : null;
    }),
    lTrim: jest.fn(async () => {}),
  },
}));

jest.mock("../../db/config", () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: jest.fn(() => ({
      findOne: jest.fn(async () => null),
      create: jest.fn((item) => item),
      save: jest.fn(async (item) => item),
    })),
  },
}));

describe("RadiusAccountingQueueService", () => {
  beforeEach(() => {
    radiusAccountingQueueService.stopAutoFlush();
    // Reset all queues before each test
    Object.keys(queues).forEach((k) => (queues[k] = []));
    jest.clearAllMocks();
  });

  it("should enqueue accounting updates into Redis list", async () => {
    const payload: AccountingUpdatePayload = {
      acctsessionid: "sess-999",
      acctuniqueid: "uniq-999",
      username: "alice",
      nasipaddress: "10.0.0.1",
      acctstatustype: "Start",
      timestamp: new Date().toISOString(),
    };

    await radiusAccountingQueueService.enqueue(payload);
    expect(redisClient.rPush).toHaveBeenCalledWith(
      "radius:accounting:queue",
      expect.any(String)
    );
  });

  it("should flush queued items and process batch", async () => {
    const payload: AccountingUpdatePayload = {
      acctsessionid: "sess-1000",
      acctuniqueid: "uniq-1000",
      username: "bob",
      nasipaddress: "10.0.0.1",
      acctstatustype: "Interim-Update",
      acctsessiontime: 120,
      acctinputoctets: 5000,
      acctoutputoctets: 15000,
      timestamp: new Date().toISOString(),
    };

    await radiusAccountingQueueService.enqueue(payload);
    const flushedCount = await radiusAccountingQueueService.flushQueue();
    expect(flushedCount).toBeGreaterThanOrEqual(1);
  });

  it("should route corrupt JSON payloads to the dead-letter queue", async () => {
    // Manually push a corrupt string into the main queue
    queues["radius:accounting:queue"].push("{ not valid json !!!");

    await radiusAccountingQueueService.flushQueue();

    // DLQ should have received the bad item
    expect(redisClient.rPush).toHaveBeenCalledWith(
      "radius:accounting:dlq",
      expect.stringContaining("movedAt")
    );
    // Main queue should be empty
    expect(queues["radius:accounting:queue"].length).toBe(0);
  });

  it("should return queue depths including dlq via getQueueDepths()", async () => {
    // Seed a known state
    queues["radius:accounting:queue"] = ["item1", "item2"];
    queues["radius:accounting:dlq"] = ["dead1"];

    const depths = await radiusAccountingQueueService.getQueueDepths();

    expect(depths.queue).toBe(2);
    expect(depths.dlq).toBe(1);
  });
});
