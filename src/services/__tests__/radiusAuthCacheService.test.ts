import { radiusAuthCacheService } from "../radiusAuthCacheService";
import { redisClient } from "../../redisClient";

const mockStore: Record<string, string> = {};

// Mock redisClient for unit testing
jest.mock("../../redisClient", () => {
  return {
    redisClient: {
      isOpen: true,
      isReady: true,
      get: jest.fn(async (key: string) => mockStore[key] || null),
      set: jest.fn(async (key: string, val: string, _opts?: any) => {
        mockStore[key] = val;
        return "OK";
      }),
      del: jest.fn(async (keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        let count = 0;
        for (const k of keyList) {
          if (mockStore[k]) {
            delete mockStore[k];
            count++;
          }
        }
        return count;
      }),
      scan: jest.fn(async (_cursor: number, opts: any) => {
        const pattern = opts?.MATCH || "*";
        const prefix = pattern.replace("*", "");
        const keys = Object.keys(mockStore).filter((k) => k.startsWith(prefix));
        return { cursor: 0, keys };
      }),
    },
  };
});

describe("RadiusAuthCacheService", () => {
  beforeEach(() => {
    Object.keys(mockStore).forEach((key) => delete mockStore[key]);
    jest.clearAllMocks();
  });

  it("should set and retrieve cached subscriber auth details", async () => {
    const username = "subscriber100";
    const payload = {
      username: "subscriber100",
      cleartextPassword: "SecretPassword123",
      macAddress: "AA:BB:CC:DD:EE:FF",
      profileId: 5,
      profileName: "Unlimited_50M",
      downloadSpeed: 50000000,
      uploadSpeed: 10000000,
      status: "active",
    };

    await radiusAuthCacheService.setAuthUser(username, payload);
    const cached = await radiusAuthCacheService.getAuthUser(username);

    expect(cached).not.toBeNull();
    expect(cached?.username).toBe("subscriber100");
    expect(cached?.cleartextPassword).toBe("SecretPassword123");
    expect(cached?.profileId).toBe(5);
    expect(cached?.status).toBe("active");
  });

  it("should invalidate individual subscriber auth cache", async () => {
    const username = "subscriber200";
    await radiusAuthCacheService.setAuthUser(username, { username, profileId: 2 });

    let cached = await radiusAuthCacheService.getAuthUser(username);
    expect(cached).not.toBeNull();

    await radiusAuthCacheService.invalidateUserCache(username);
    cached = await radiusAuthCacheService.getAuthUser(username);
    expect(cached).toBeNull();
  });

  it("should invalidate all subscriber caches matching a profile ID", async () => {
    await radiusAuthCacheService.setAuthUser("user1", { username: "user1", profileId: 10 });
    await radiusAuthCacheService.setAuthUser("user2", { username: "user2", profileId: 10 });
    await radiusAuthCacheService.setAuthUser("user3", { username: "user3", profileId: 20 });

    await radiusAuthCacheService.invalidateProfileCache(10);

    expect(await radiusAuthCacheService.getAuthUser("user1")).toBeNull();
    expect(await radiusAuthCacheService.getAuthUser("user2")).toBeNull();
    expect(await radiusAuthCacheService.getAuthUser("user3")).not.toBeNull();
  });

  it("should invalidate all RADIUS auth caches on flush", async () => {
    await radiusAuthCacheService.setAuthUser("userA", { username: "userA" });
    await radiusAuthCacheService.setAuthUser("userB", { username: "userB" });

    const count = await radiusAuthCacheService.invalidateAllAuthCaches();
    expect(count).toBe(2);
    expect(await radiusAuthCacheService.getAuthUser("userA")).toBeNull();
  });
});
