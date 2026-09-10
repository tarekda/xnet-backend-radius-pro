import { AppDataSource } from "../db/config";
import { sqlMonthlyCycleResetAt, sqlMonthlyCycleStart } from "./quotaCycle";

export type UserQuotaUsage = {
    dailyUsage: bigint;
    monthlyUsage: bigint;
    activeTopupBytes: bigint;
    monthlyCycleStart: string | null;
    monthlyCycleResetAt: string | null;
    quotaResetDay: number | null;
    quotaCycleStartDate: string | null;
    isMonthlyExceeded: boolean;
};

export async function getQuotaUsageForUsers(usernames: string[]): Promise<Record<string, UserQuotaUsage>> {
    if (!Array.isArray(usernames) || usernames.length === 0) return {};

    const placeholders = usernames.map(() => "?").join(",");
    const cycleStart = sqlMonthlyCycleStart("up");
    const cycleReset = sqlMonthlyCycleResetAt("up");
    const sql = `
      SELECT
        up.username AS username,
        COALESCE(SUM(CASE WHEN s.day = CURDATE() THEN s.data_usage ELSE 0 END), 0) AS daily_usage,
        COALESCE(SUM(CASE WHEN s.day >= ${cycleStart} THEN s.data_usage ELSE 0 END), 0) AS monthly_usage,
        DATE_FORMAT(${cycleStart}, '%Y-%m-%d') AS monthly_cycle_start,
        DATE_FORMAT(${cycleReset}, '%Y-%m-%d') AS monthly_cycle_reset_at,
        up.quota_reset_day AS quota_reset_day,
        up.quota_cycle_start_date AS quota_cycle_start_date,
        COALESCE(up.is_monthly_exceeded, 0) AS is_monthly_exceeded
      FROM raduserprofile up
      LEFT JOIN radusagestats s
        ON s.username = up.username
      WHERE up.username IN (${placeholders})
      GROUP BY up.username, up.quota_reset_day, up.quota_cycle_start_date, up.is_monthly_exceeded
    `;

    const rows = await AppDataSource.query(sql, usernames);

    let topupMap: Record<string, bigint> = {};
    try {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const topupRows = await AppDataSource.query(
            `SELECT username, COALESCE(SUM(extra_bytes), 0) AS total_extra
             FROM subscriber_topups
             WHERE username IN (${placeholders})
               AND status = 'active'
               AND billing_month = ?
               AND (expires_at IS NULL OR expires_at > NOW())
             GROUP BY username`,
            [...usernames, currentMonth]
        );
        for (const tr of topupRows) {
            topupMap[String(tr.username)] = BigInt(tr.total_extra || "0");
        }
    } catch {
        // Table may not exist in scratch tests
    }

    return (rows as any[]).reduce((acc, r) => {
        const u = String(r?.username ?? "");
        if (!u) return acc;
        acc[u] = {
            dailyUsage: BigInt(String(r?.daily_usage ?? "0")),
            monthlyUsage: BigInt(String(r?.monthly_usage ?? "0")),
            activeTopupBytes: topupMap[u] ?? BigInt(0),
            monthlyCycleStart: r?.monthly_cycle_start ? String(r.monthly_cycle_start) : null,
            monthlyCycleResetAt: r?.monthly_cycle_reset_at ? String(r.monthly_cycle_reset_at) : null,
            quotaResetDay: r?.quota_reset_day == null ? null : Number(r.quota_reset_day),
            quotaCycleStartDate: r?.quota_cycle_start_date ? String(r.quota_cycle_start_date).slice(0, 10) : null,
            isMonthlyExceeded: Number(r?.is_monthly_exceeded ?? 0) === 1,
        };
        return acc;
    }, {} as Record<string, UserQuotaUsage>);
}

export function monthlyUsagePct(monthlyUsage: bigint, monthlyQuota: bigint): number {
    if (monthlyQuota <= BigInt(0)) return 0;
    return Math.min(100, Number((monthlyUsage * BigInt(100)) / monthlyQuota));
}

/** Attach billing-cycle fields to online-user API rows (same logic as Users list). */
export function enrichOnlineUserRowsWithQuota(rows: any[]): any[] {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    return rows.map((row) => {
        const monthlyUsage = BigInt(String(row?.monthly_usage ?? "0"));
        const monthlyQuota = BigInt(String(row?.profile_monthly_quota ?? "0"));
        return {
            ...row,
            monthly_usage_pct: monthlyUsagePct(monthlyUsage, monthlyQuota),
        };
    });
}

export async function enrichOnlineUserRowsWithQuotaAsync(rows: any[]): Promise<any[]> {
    if (!Array.isArray(rows) || rows.length === 0) return rows;

    const usernames = [...new Set(rows.map((r) => String(r?.session_username ?? "")).filter(Boolean))];
    const usageMap = await getQuotaUsageForUsers(usernames);

    return rows.map((row) => {
        const username = String(row?.session_username ?? "");
        const usage = usageMap[username];
        const monthlyUsage = usage?.monthlyUsage ?? BigInt(String(row?.monthly_usage ?? "0"));
        const baseMonthlyQuota = BigInt(String(row?.profile_monthly_quota ?? "0"));
        const activeTopup = usage?.activeTopupBytes ?? BigInt(0);
        const effectiveMonthlyQuota = baseMonthlyQuota + activeTopup;

        return {
            ...row,
            monthly_usage: monthlyUsage.toString(),
            active_topup_bytes: activeTopup.toString(),
            effective_monthly_quota: effectiveMonthlyQuota.toString(),
            monthly_cycle_start: usage?.monthlyCycleStart ?? row?.monthly_cycle_start ?? null,
            monthly_cycle_reset_at: usage?.monthlyCycleResetAt ?? row?.monthly_cycle_reset_at ?? null,
            quota_reset_day: usage?.quotaResetDay ?? row?.quota_reset_day ?? null,
            quota_cycle_start_date: usage?.quotaCycleStartDate ?? row?.quota_cycle_start_date ?? null,
            is_monthly_exceeded: usage?.isMonthlyExceeded ? 1 : Number(row?.is_monthly_exceeded ?? 0),
            monthly_usage_pct: monthlyUsagePct(monthlyUsage, effectiveMonthlyQuota),
        };
    });
}
