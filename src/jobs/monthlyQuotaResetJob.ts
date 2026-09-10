import cron from "node-cron";
import { AppDataSource } from "../db/config";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import cacheService from "../services/cacheService";

/**
 * Resets the monthly quota (isMonthlyExceeded flag) for users whose billing
 * cycle has rolled over based on their individual `quotaResetDay` field.
 *
 * The job runs daily and only touches users whose reset day matches today's
 * date-of-month, so it is safe to schedule at any interval ≤ 1 day.
 *
 * Gated by MONTHLY_QUOTA_RESET_CRON in server.ts.
 */
export async function runMonthlyQuotaResetJob(): Promise<{
  usersReset: number;
  errors: number;
}> {
  if (!AppDataSource.isInitialized) {
    console.warn("[monthly-quota-reset] skipped: database not initialized");
    return { usersReset: 0, errors: 0 };
  }

  const today = new Date();
  const dayOfMonth = today.getDate();

  // Find users whose quotaResetDay matches today and who still have isMonthlyExceeded = true
  const candidates = await AppDataSource.getRepository(Raduserprofile)
    .createQueryBuilder("up")
    .select(["up.id", "up.username", "up.quotaResetDay"])
    .where("up.quotaResetDay = :day", { day: dayOfMonth })
    .andWhere("up.isMonthlyExceeded = 1")
    .andWhere("up.accountStatus NOT IN (:...skipStatuses)", {
      skipStatuses: ["suspended", "terminated"],
    })
    .getMany();

  if (candidates.length === 0) {
    console.log(`[monthly-quota-reset] no users to reset for day ${dayOfMonth}`);
    return { usersReset: 0, errors: 0 };
  }

  let usersReset = 0;
  let errors = 0;

  for (const user of candidates) {
    try {
      await AppDataSource.transaction(async (manager) => {
        // Reset the monthly exceeded flag and restore the default profile if user was on fallback
        await manager.query(
          `
          UPDATE raduserprofile up
          LEFT JOIN user_default_profiles udp ON udp.username = up.username
          SET
            up.is_monthly_exceeded = 0,
            up.is_fallback         = 0,
            up.profile_id          = COALESCE(udp.default_profile_id, up.profile_id)
          WHERE up.id = ?
          `,
          [user.id]
        );

        // Reset monthly usage stats for this user: zero out the current cycle window
        await manager.query(
          `
          UPDATE radusagestats
          SET data_usage = 0
          WHERE username = ?
            AND day >= DATE_SUB(CURRENT_DATE, INTERVAL 32 DAY)
          `,
          [user.username]
        );
      });

      usersReset += 1;
    } catch (err) {
      errors += 1;
      console.error(`[monthly-quota-reset] failed for user ${user.username}:`, err);
    }
  }

  // Invalidate user caches for all reset users
  if (usersReset > 0) {
    try {
      const patterns = ["users_page_*", "users_status_*", "user:*", "user_search_*"];
      for (const pattern of patterns) {
        await cacheService.deleteCacheKeys(pattern);
      }
    } catch (e) {
      console.warn("[monthly-quota-reset] cache invalidation failed (non-fatal):", e);
    }
  }

  console.log("[monthly-quota-reset] tick", { dayOfMonth, usersReset, errors });
  return { usersReset, errors };
}

export function startMonthlyQuotaResetScheduler(): void {
  // Default: run every day at 00:05 local time (avoids midnight load spike)
  const cronExpr = String(process.env.MONTHLY_QUOTA_RESET_CRON ?? "5 0 * * *").trim();

  if (!cronExpr || cronExpr === "off" || cronExpr === "0") {
    console.log("[monthly-quota-reset] scheduler disabled (MONTHLY_QUOTA_RESET_CRON=off)");
    return;
  }

  try {
    cron.schedule(cronExpr, async () => {
      try {
        await runMonthlyQuotaResetJob();
      } catch (e) {
        console.error("[monthly-quota-reset] job failed:", e);
      }
    });
    console.log(`[monthly-quota-reset] scheduler enabled: ${cronExpr}`);
  } catch (e) {
    console.error("[monthly-quota-reset] invalid MONTHLY_QUOTA_RESET_CRON:", e);
  }
}
