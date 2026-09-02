import { radiusAccountingQueueService, AccountingUpdatePayload } from "../radiusAccountingQueueService";
import { redisClient } from "../../redisClient";

jest.mock("../../redisClient", () => {
  const queue: string[] = [];
  return {
    redisClient: {
      isOpen: true,
      rPush: jest.fn(async (_key: string, val: string) => {
        queue.push(val);
        return queue.length;
      }),
      lLen: jest.fn(async (_key: string) => queue.length),
      lPop: jest.fn(async (_key: string) => queue.shift() || null),
    },
  };
});

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
    expect(redisClient.rPush).toHaveBeenCalled();
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
});
