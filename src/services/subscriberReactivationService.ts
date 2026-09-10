import { AppDataSource } from "../db/config";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { Radprofile } from "../db/entities/Radprofile";
import { UserController } from "../controllers/userController";
import { radiusAuthCacheService } from "./radiusAuthCacheService";
import cacheService from "./cacheService";
import { writeAuditLog } from "../audit/writeAuditLog";
import { addCalendarMonths } from "./subscriptionRenewalService";

export interface RestoreLineOptions {
  actor?: string;
  invoiceId?: number;
  trigger?: "external_invoice_paid" | "manual_override" | "gateway_payment" | "quota_restore";
  force?: boolean;
  skipDisconnect?: boolean;
}

export interface RestoreLineResult {
  ok: boolean;
  restored: boolean;
  reason?: string;
  username: string;
  defaultProfileId?: number;
  accountStatus?: string;
  disconnected?: boolean;
  remainingOverdueInvoices?: number;
}

export interface SubscriberDunningEnforcementState {
  username: string;
  isThrottled: boolean;
  isSuspended: boolean;
  isExpired: boolean;
  accountStatus: string;
  currentProfileId: number | null;
  defaultProfileId: number | null;
  currentProfileName: string | null;
  defaultProfileName: string | null;
  overdueInvoicesCount: number;
  totalOverdueAmount: number;
}

/**
 * Retrieves the subscriber's default base profile from `user_default_profiles`.
 */
export async function getUserDefaultProfileId(username: string): Promise<number | null> {
  try {
    const rows = await AppDataSource.query(
      `SELECT default_profile_id FROM user_default_profiles WHERE username = ? LIMIT 1`,
      [username]
    );
    const id = Number(rows?.[0]?.default_profile_id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (err: any) {
    console.warn("[subscriber-reactivation] Failed to read user_default_profiles:", err?.message || err);
    return null;
  }
}

/**
 * Saves or preserves the subscriber's base profile before any dunning throttling occurs.
 */
export async function preserveUserDefaultProfile(username: string, profileId: number): Promise<void> {
  try {
    if (!username || !Number.isFinite(profileId) || profileId <= 0) return;
    const throttleProfileId = Number(process.env.DUNNING_THROTTLE_PROFILE_ID ?? 0);
    if (throttleProfileId > 0 && profileId === throttleProfileId) return;

    await AppDataSource.query(
      `
      INSERT INTO user_default_profiles (username, default_profile_id)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE default_profile_id = default_profile_id;
      `,
      [username, profileId]
    );
  } catch (err: any) {
    console.warn("[subscriber-reactivation] Failed to preserve user_default_profiles:", err?.message || err);
  }
}

/**
 * Evaluates whether a subscriber has any remaining overdue unpaid invoices.
 */
export async function getOverdueInvoicesForUser(username: string): Promise<{ count: number; totalDue: number }> {
  try {
    const repo = AppDataSource.getRepository(ExternalInvoice);
    const rows = await repo
      .createQueryBuilder("ext")
      .where("ext.username = :username", { username })
      .andWhere("ext.deletedAt IS NULL")
      .andWhere("ext.voidedAt IS NULL")
      .andWhere("ext.status IN ('unpaid', 'pending')")
      .andWhere("ext.documentType != 'credit_note'")
      .getMany();

    const now = new Date();
    let count = 0;
    let totalDue = 0;

    for (const inv of rows) {
      const amount = Number(inv.totalAmount ?? inv.amount ?? 0);
      const paid = Number(inv.amountPaid ?? 0);
      const left = Math.max(0, amount - paid);
      if (left < 0.01) continue;

      let isOverdue = false;
      if (inv.payDueDate) {
        const dueDate = new Date(inv.payDueDate);
        if (!Number.isNaN(dueDate.getTime()) && dueDate < now) {
          isOverdue = true;
        }
      } else if (inv.billingMonth) {
        const bm = new Date(inv.billingMonth);
        if (!Number.isNaN(bm.getTime()) && bm < now) {
          isOverdue = true;
        }
      }

      if (isOverdue) {
        count += 1;
        totalDue += left;
      }
    }

    return { count, totalDue: Number(totalDue.toFixed(2)) };
  } catch (err: any) {
    console.warn("[subscriber-reactivation] Failed to check overdue invoices:", err?.message || err);
    return { count: 0, totalDue: 0 };
  }
}

/**
 * Inspects the subscriber's live enforcement state (throttled vs normal vs suspended).
 */
export async function getSubscriberDunningEnforcementState(
  username: string
): Promise<SubscriberDunningEnforcementState | null> {
  const cleanUser = String(username || "").trim();
  if (!cleanUser) return null;

  const profileRepo = AppDataSource.getRepository(Raduserprofile);
  const user = await profileRepo.findOne({ where: { username: cleanUser } });
  if (!user) return null;

  const defaultProfileId = await getUserDefaultProfileId(cleanUser);
  const throttleProfileId = Number(process.env.DUNNING_THROTTLE_PROFILE_ID ?? 0);

  const radProfileRepo = AppDataSource.getRepository(Radprofile);
  let currentProfileName: string | null = null;
  let defaultProfileName: string | null = null;

  if (user.profileId) {
    const cur = await radProfileRepo.findOne({ where: { id: user.profileId } as any });
    currentProfileName = cur?.profileName ?? null;
  }
  if (defaultProfileId) {
    const def = await radProfileRepo.findOne({ where: { id: defaultProfileId } as any });
    defaultProfileName = def?.profileName ?? null;
  }

  const isThrottled = throttleProfileId > 0 && user.profileId === throttleProfileId;
  const status = String(user.accountStatus ?? "active").toLowerCase();
  const isSuspended = status === "suspended";
  const now = new Date();
  const isExpired = status === "expired" || (user.expiresAt !== null && new Date(user.expiresAt) < now);

  const overdue = await getOverdueInvoicesForUser(cleanUser);

  return {
    username: cleanUser,
    isThrottled,
    isSuspended,
    isExpired,
    accountStatus: status,
    currentProfileId: user.profileId ?? null,
    defaultProfileId,
    currentProfileName,
    defaultProfileName,
    overdueInvoicesCount: overdue.count,
    totalOverdueAmount: overdue.totalDue,
  };
}

/**
 * Autonomous Self-Healing Line Restoration:
 * - Checks that no other overdue unpaid invoices remain (unless force: true).
 * - Restores `Raduserprofile.profileId` to the subscriber's default base profile.
 * - Flips `accountStatus` back to 'active'.
 * - Resets `isMonthlyExceeded = false` and `isFallback = false`.
 * - Extends `expiresAt` if currently expired.
 * - Invalidates RADIUS auth cache.
 * - Triggers RouterOS API / RADIUS disconnect so the CPE/ONT re-auths immediately at full speed.
 */
export async function restoreSubscriberLine(
  username: string,
  options: RestoreLineOptions = {}
): Promise<RestoreLineResult> {
  const cleanUser = String(username || "").trim();
  if (!cleanUser) {
    return { ok: false, restored: false, reason: "Username is required", username: "" };
  }

  const overdue = await getOverdueInvoicesForUser(cleanUser);
  if (!options.force && overdue.count > 0) {
    console.log(
      `[subscriber-reactivation] Skipping line restoration for ${cleanUser}: ${overdue.count} overdue invoice(s) remain unpaid ($${overdue.totalDue})`
    );
    return {
      ok: true,
      restored: false,
      reason: `Subscriber still has ${overdue.count} overdue invoice(s) pending ($${overdue.totalDue})`,
      username: cleanUser,
      remainingOverdueInvoices: overdue.count,
    };
  }

  const profileRepo = AppDataSource.getRepository(Raduserprofile);
  const user = await profileRepo.findOne({ where: { username: cleanUser } });
  if (!user) {
    return { ok: false, restored: false, reason: "Subscriber radius profile not found", username: cleanUser };
  }

  const defaultProfileId = (await getUserDefaultProfileId(cleanUser)) ?? user.profileId;
  const throttleProfileId = Number(process.env.DUNNING_THROTTLE_PROFILE_ID ?? 0);

  let profileChanged = false;
  if (defaultProfileId && user.profileId !== defaultProfileId) {
    user.profileId = defaultProfileId;
    profileChanged = true;
  } else if (throttleProfileId > 0 && user.profileId === throttleProfileId) {
    if (defaultProfileId && defaultProfileId !== throttleProfileId) {
      user.profileId = defaultProfileId;
      profileChanged = true;
    }
  }

  const wasNonActive = String(user.accountStatus ?? "").toLowerCase() !== "active";
  user.accountStatus = "active";
  user.isMonthlyExceeded = false;
  user.isFallback = false;

  const now = new Date();
  const pastExpiry = user.expiresAt !== null && new Date(user.expiresAt) < now;
  if (pastExpiry || !user.expiresAt) {
    user.expiresAt = addCalendarMonths(now, 1);
  }

  await profileRepo.save(user);

  // Invalidate caches
  try {
    await radiusAuthCacheService.invalidateUserCache(cleanUser);
    const cacheKeys = [
      `user:${cleanUser}*`,
      "users_page_*",
      "users_status_*",
      "user_search_*",
      "dashboard_*",
    ];
    for (const pattern of cacheKeys) {
      await cacheService.deleteCacheKeys(pattern);
    }
  } catch (err: any) {
    console.warn("[subscriber-reactivation] Cache invalidation best-effort warning:", err?.message || err);
  }

  // Network session re-auth / Disconnect
  let disconnected = false;
  if (!options.skipDisconnect) {
    try {
      const dcResult = await UserController.disconnectUser(cleanUser);
      disconnected = Boolean(dcResult.ok);
      console.log(`[subscriber-reactivation] Network disconnect for ${cleanUser}:`, dcResult);
    } catch (dcErr: any) {
      console.warn(`[subscriber-reactivation] Network disconnect for ${cleanUser} failed (non-fatal):`, dcErr?.message || dcErr);
    }
  }

  // Audit log
  try {
    await writeAuditLog({
      action: "billing.subscriber.self_heal",
      actorUsername: options.actor || "system:self-heal",
      targetUsernames: [cleanUser],
      meta: {
        invoiceId: options.invoiceId,
        trigger: options.trigger || "external_invoice_paid",
        defaultProfileId,
        profileChanged,
        wasNonActive,
        disconnected,
      },
    });
  } catch (auditErr: any) {
    console.warn("[subscriber-reactivation] Audit log write warning:", auditErr?.message || auditErr);
  }

  console.log(`✅ [subscriber-reactivation] Successfully restored line for subscriber ${cleanUser} (profileId=${defaultProfileId}, disconnected=${disconnected})`);

  return {
    ok: true,
    restored: true,
    username: cleanUser,
    defaultProfileId: defaultProfileId ?? undefined,
    accountStatus: "active",
    disconnected,
    remainingOverdueInvoices: 0,
  };
}
