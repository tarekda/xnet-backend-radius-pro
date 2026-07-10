// CacheService.ts
import { redisClient } from "../redisClient";

export class CacheService {
  /**
   * Delete keys matching a glob pattern using SCAN (non-blocking) instead of KEYS.
   */
  async deleteCacheKeys(pattern: string = "user:*"): Promise<void> {
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }

      let cursor = 0;
      let deleted = 0;
      do {
        const result = await redisClient.scan(cursor, {
          MATCH: pattern,
          COUNT: 100,
        });
        cursor = typeof result.cursor === "number" ? result.cursor : Number(result.cursor);
        const keys = result.keys ?? [];
        if (keys.length > 0) {
          await redisClient.del(keys);
          deleted += keys.length;
        }
      } while (cursor !== 0);

      if (deleted > 0) {
        console.log(`Deleted ${deleted} cache key(s) matching ${pattern}`);
      }
    } catch (error) {
      console.error("Error deleting cache keys:", error);
    }
  }

  async disconnect(): Promise<void> {
    if (redisClient.isOpen) {
      await redisClient.disconnect();
      console.log("Disconnected from Redis");
    }
  }
}

export default new CacheService();
