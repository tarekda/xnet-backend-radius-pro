import { EntityManager, Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { CacheService } from "./cacheService";

/** Extend `from` by whole months (handles month-length edges e.g. Jan 31 +1 month). */
export function addCalendarMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

export type RenewResult = {
  renewed: boolean;
  reason?: string;
  expiresAt: Date | null;
  accountStatus: string | null;
};

/**
 * If the account is expired (status or past expiresAt), extend by `months` and set active.
 * No-op (renewed=false) when still active with future expiry.
 */
export async function renewIfExpired(
  username: string,
  months = 1,
  manager?: EntityManager
): Promise<RenewResult> {
  const repo = (manager ?? AppDataSource).getRepository(Raduserprofile);
  const user = await repo.findOne({ where: { username: Equal(username) } });
  if (!user) {
    throw Object.assign(new Error("User not found"), { status: 404 });
  }

  const st = String(user.accountStatus ?? "").trim();
  if (st === "suspended" || st === "terminated") {
    throw Object.assign(new Error(`Cannot renew: account is ${st}`), { status: 400 });
  }

  const now = new Date();
  const pastExpiry = user.expiresAt !== null && user.expiresAt.getTime() < now.getTime();
  const isExpiredStatus = st === "expired";
  if (!isExpiredStatus && !pastExpiry) {
    return {
      renewed: false,
      reason: "not_expired",
      expiresAt: user.expiresAt,
      accountStatus: user.accountStatus,
    };
  }

  const currentEnd = user.expiresAt ? new Date(user.expiresAt.getTime()) : null;
  const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  user.expiresAt = addCalendarMonths(base, months);
  user.accountStatus = "active";
  await repo.save(user);

  if (!manager) {
    try {
      await new CacheService().deleteCacheKeys();
    } catch {
      /* best-effort */
    }
  }

  return {
    renewed: true,
    expiresAt: user.expiresAt,
    accountStatus: user.accountStatus,
  };
}
