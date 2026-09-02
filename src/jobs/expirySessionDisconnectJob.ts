import { AppDataSource } from "../db/config";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { Settings } from "../db/entities/Settings";
import { UserController } from "../controllers/userController";
import cacheService from "../services/cacheService";

/**
 * Bulk-flip account_status to expired when expires_at has passed (active rows only),
 * then disconnect still-online sessions that still carry a pre-expiry (full-internet)
 * auth so they re-authenticate.
 *
 * When Walled-Garden-expired is on, RADIUS accepts those re-auths into quarantine.
 * Only the latest open radacct row per username is considered — older zombie rows with
 * acctstoptime IS NULL would otherwise make every tick look like a pre-expiry session
 * and flap the CPE every cron interval.
 *
 * When the garden is off, RADIUS rejects expired logins, so every open session with
 * a past expires_at is still a leak and gets disconnected (legacy behaviour).
 *
 * Gated by EXPIRY_DISCONNECT_CRON in server.ts.
 */
export async function runExpirySessionDisconnectJob(): Promise<{
  statusFlipped: number;
  candidates: number;
  attempted: number;
  ok: number;
  failed: number;
  skippedGarden: number;
}> {
  if (!AppDataSource.isInitialized) {
    console.warn("[expiry-disconnect] skipped: database not initialized yet");
    return { statusFlipped: 0, candidates: 0, attempted: 0, ok: 0, failed: 0, skippedGarden: 0 };
  }

  const flip = await AppDataSource.getRepository(Raduserprofile)
    .createQueryBuilder()
    .update(Raduserprofile)
    .set({ accountStatus: "expired" })
    .where("expiresAt IS NOT NULL")
    .andWhere("expiresAt < CURRENT_TIMESTAMP")
    .andWhere("accountStatus = :active", { active: "active" })
    .execute();

  // MySQL driver sometimes exposes row count on raw[0].affectedRows instead of .affected
  let statusFlipped = typeof flip.affected === "number" ? flip.affected : 0;
  if (!statusFlipped && flip.raw && Array.isArray(flip.raw) && (flip.raw[0] as { affectedRows?: number })?.affectedRows != null) {
    statusFlipped = Number((flip.raw[0] as { affectedRows: number }).affectedRows) || 0;
  }

  if (statusFlipped > 0) {
    try {
      const patterns = ["users_page_*", "users_status_*", "user:*", "user_search_*"];
      for (const pattern of patterns) {
        await cacheService.deleteCacheKeys(pattern);
      }
    } catch (e) {
      console.warn("[expiry-disconnect] cache invalidation failed (non-fatal):", e);
    }
  }

  const batchRaw = parseInt(process.env.EXPIRY_DISCONNECT_BATCH || "100", 10);
  const batch = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.min(batchRaw, 500) : 100;

  const gardenRow = await AppDataSource.getRepository(Settings)
    .createQueryBuilder("s")
    .select("s.ifEnabled", "ifEnabled")
    .where("s.keyAttribute = :key", { key: "Walled-Garden-expired" })
    .getRawOne<{ ifEnabled: number | boolean | null }>();
  const gardenOn = Number(gardenRow?.ifEnabled) === 1;

  // Latest open session only. Zombie acctstoptime IS NULL rows from months ago must not
  // make a freshly re-authed garden session look "pre-expiry" forever.
  const gardenClause = gardenOn
    ? "AND ra.acctstarttime IS NOT NULL AND ra.acctstarttime < up.expires_at"
    : "";

  const rows: Array<{ username: string }> = await AppDataSource.query(
    `
    SELECT DISTINCT ra.username AS username
      FROM radacct ra
      INNER JOIN raduserprofile up ON up.username = ra.username
     WHERE ra.acctstoptime IS NULL
       AND ra.acctstarttime = (
             SELECT MAX(ra2.acctstarttime)
               FROM radacct ra2
              WHERE ra2.username = ra.username
                AND ra2.acctstoptime IS NULL
           )
       AND up.expires_at IS NOT NULL
       AND up.expires_at < CURRENT_TIMESTAMP
       ${gardenClause}
     LIMIT ?
    `,
    [batch]
  );

  const usernames = Array.from(
    new Set(rows.map((r) => String(r?.username ?? "").trim()).filter((u) => u.length > 0))
  );

  let skippedGarden = 0;
  if (gardenOn) {
    const openRows: Array<{ cnt: number | string }> = await AppDataSource.query(
      `
      SELECT COUNT(DISTINCT ra.username) AS cnt
        FROM radacct ra
        INNER JOIN raduserprofile up ON up.username = ra.username
       WHERE ra.acctstoptime IS NULL
         AND ra.acctstarttime = (
               SELECT MAX(ra2.acctstarttime)
                 FROM radacct ra2
                WHERE ra2.username = ra.username
                  AND ra2.acctstoptime IS NULL
             )
         AND up.expires_at IS NOT NULL
         AND up.expires_at < CURRENT_TIMESTAMP
      `
    );
    const openCount = Number(openRows?.[0]?.cnt ?? 0) || 0;
    skippedGarden = Math.max(0, openCount - usernames.length);
  }

  let ok = 0;
  let failed = 0;
  for (const u of usernames) {
    const result = await UserController.disconnectWithOpenSessionLookup(u);
    if (result.ok) ok += 1;
    else failed += 1;
  }

  const out = {
    statusFlipped,
    candidates: usernames.length,
    attempted: usernames.length,
    ok,
    failed,
    skippedGarden,
    gardenOn,
  };
  console.log("[expiry-disconnect] tick", out);
  return { statusFlipped, candidates: usernames.length, attempted: usernames.length, ok, failed, skippedGarden };
}
