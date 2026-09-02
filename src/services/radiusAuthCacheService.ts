import { redisClient } from "../redisClient";

export interface CachedRadAuthUser {
  username: string;
  password?: string;
  cleartextPassword?: string;
  macAddress?: string;
  profileId?: number;
  profileName?: string;
  downloadSpeed?: number;
  uploadSpeed?: number;
  status?: string;
  expirationDate?: string | null;
  cachedAt: number;
}

const REDIS_AUTH_PREFIX = "radius:auth:";

export class RadiusAuthCacheService {
  private defaultTtl: number = 300; // 5 minutes default TTL

  private getKey(username: string): string {
    return `${REDIS_AUTH_PREFIX}${username.trim().toLowerCase()}`;
  }

  /**
   * Save subscriber authentication credentials and attributes in Redis
   */
  async setAuthUser(username: string, data: Partial<CachedRadAuthUser>, ttlSeconds: number = this.defaultTtl): Promise<void> {
    if (!username) return;
    const key = this.getKey(username);
    try {
      if (redisClient && redisClient.isOpen) {
        const payload: CachedRadAuthUser = {
          username: username.trim(),
          ...data,
          cachedAt: Date.now(),
        };
        await redisClient.set(key, JSON.stringify(payload), { EX: ttlSeconds });
      }
    } catch (err) {
      console.error(`[RadiusAuthCache] Failed to set auth cache for user '${username}':`, err);
    }
  }

  /**
   * Fetch subscriber auth details from Redis
   */
  async getAuthUser(username: string): Promise<CachedRadAuthUser | null> {
    if (!username) return null;
    const key = this.getKey(username);
    try {
      if (redisClient && redisClient.isOpen) {
        const cached = await redisClient.get(key);
        if (cached) {
          return JSON.parse(cached) as CachedRadAuthUser;
        }
      }
    } catch (err) {
      console.error(`[RadiusAuthCache] Failed to read auth cache for user '${username}':`, err);
    }
    return null;
  }

  /**
   * Invalidate subscriber cache when credentials, MAC address, status, or plan change
   */
  async invalidateUserCache(username: string): Promise<void> {
    if (!username) return;
    const key = this.getKey(username);
    try {
      if (redisClient && redisClient.isOpen) {
        await redisClient.del(key);
        // Also clear legacy user key format for compatibility
        await redisClient.del(`user:${username.trim()}`);
      }
    } catch (err) {
      console.error(`[RadiusAuthCache] Failed to invalidate cache for user '${username}':`, err);
    }
  }

  /**
   * Invalidate all subscriber auth caches linked to a specific profile
   */
  async invalidateProfileCache(profileId: number | string): Promise<void> {
    try {
      if (!redisClient || !redisClient.isOpen) return;
      let cursor = 0;
      let count = 0;
      do {
        const result = await redisClient.scan(cursor, {
          MATCH: `${REDIS_AUTH_PREFIX}*`,
          COUNT: 100,
        });
        cursor = typeof result.cursor === "number" ? result.cursor : Number(result.cursor);
        const keys = result.keys ?? [];
        for (const key of keys) {
          const raw = await redisClient.get(key);
          if (raw) {
            try {
              const data = JSON.parse(raw) as CachedRadAuthUser;
              if (String(data.profileId) === String(profileId)) {
                await redisClient.del(key);
                count++;
              }
            } catch {
              // Ignore parse error
            }
          }
        }
      } while (cursor !== 0);
      if (count > 0) {
        console.log(`[RadiusAuthCache] Invalidated ${count} auth cache key(s) for profile ${profileId}`);
      }
    } catch (err) {
      console.error(`[RadiusAuthCache] Error invalidating profile cache ${profileId}:`, err);
    }
  }

  /**
   * Flushes all RADIUS auth keys from Redis
   */
  async invalidateAllAuthCaches(): Promise<number> {
    try {
      if (!redisClient || !redisClient.isOpen) return 0;
      let cursor = 0;
      let totalDeleted = 0;
      do {
        const result = await redisClient.scan(cursor, {
          MATCH: `${REDIS_AUTH_PREFIX}*`,
          COUNT: 100,
        });
        cursor = typeof result.cursor === "number" ? result.cursor : Number(result.cursor);
        const keys = result.keys ?? [];
        if (keys.length > 0) {
          await redisClient.del(keys);
          totalDeleted += keys.length;
        }
      } while (cursor !== 0);
      return totalDeleted;
    } catch (err) {
      console.error("[RadiusAuthCache] Error flushing RADIUS auth caches:", err);
      return 0;
    }
  }
}

export const radiusAuthCacheService = new RadiusAuthCacheService();
