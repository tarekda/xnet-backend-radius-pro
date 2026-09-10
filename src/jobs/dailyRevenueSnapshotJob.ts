import cron from "node-cron";
import { AppDataSource } from "../db/config";

/**
 * Aggregates paid invoice amounts into a `daily_revenue_snapshot` table
 * for fast analytics queries without scanning the full invoices table.
 *
 * The snapshot is idempotent — re-running for the same day overwrites
 * with fresh totals, so this is safe to run multiple times per day.
 *
 * Gated by DAILY_REVENUE_SNAPSHOT_CRON in server.ts.
 */
export async function runDailyRevenueSnapshotJob(daysBack = 1): Promise<{
  snapshotDays: number;
  totalSnapshotRevenue: number;
}> {
  if (!AppDataSource.isInitialized) {
    console.warn("[daily-revenue-snapshot] skipped: database not initialized");
    return { snapshotDays: 0, totalSnapshotRevenue: 0 };
  }

  // Ensure the summary table exists (safe DDL — runs only if missing)
  await AppDataSource.query(`
    CREATE TABLE IF NOT EXISTS daily_revenue_snapshot (
      snapshot_date DATE NOT NULL,
      total_paid     DECIMAL(14,2) NOT NULL DEFAULT 0,
      invoice_count  INT           NOT NULL DEFAULT 0,
      updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (snapshot_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, daysBack));
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const result: Array<{ snapshot_date: string; total_paid: string; invoice_count: string }> =
    await AppDataSource.query(
      `
      SELECT
        DATE(COALESCE(paid_at, collected_at, reconciled_at)) AS snapshot_date,
        SUM(amount)                                           AS total_paid,
        COUNT(*)                                             AS invoice_count
      FROM invoices
      WHERE status IN ('paid', 'collected', 'partial')
        AND COALESCE(paid_at, collected_at, reconciled_at) >= ?
      GROUP BY snapshot_date
      `,
      [cutoffDate]
    );

  if (result.length === 0) {
    console.log("[daily-revenue-snapshot] no new data in window");
    return { snapshotDays: 0, totalSnapshotRevenue: 0 };
  }

  let totalSnapshotRevenue = 0;

  for (const row of result) {
    const total = Number(row.total_paid ?? 0);
    const count = Number(row.invoice_count ?? 0);
    totalSnapshotRevenue += total;

    await AppDataSource.query(
      `
      INSERT INTO daily_revenue_snapshot (snapshot_date, total_paid, invoice_count)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        total_paid    = VALUES(total_paid),
        invoice_count = VALUES(invoice_count),
        updated_at    = CURRENT_TIMESTAMP
      `,
      [row.snapshot_date, total, count]
    );
  }

  console.log("[daily-revenue-snapshot] completed", {
    snapshotDays: result.length,
    totalSnapshotRevenue: totalSnapshotRevenue.toFixed(2),
    daysBack,
  });

  return { snapshotDays: result.length, totalSnapshotRevenue };
}

export function startDailyRevenueSnapshotScheduler(): void {
  const cronExpr = String(process.env.DAILY_REVENUE_SNAPSHOT_CRON ?? "0 1 * * *").trim();

  if (!cronExpr || cronExpr === "off" || cronExpr === "0") {
    console.log("[daily-revenue-snapshot] scheduler disabled (DAILY_REVENUE_SNAPSHOT_CRON=off)");
    return;
  }

  try {
    cron.schedule(cronExpr, async () => {
      try {
        const daysBack = parseInt(String(process.env.DAILY_REVENUE_SNAPSHOT_DAYS_BACK ?? "1"), 10);
        await runDailyRevenueSnapshotJob(Number.isFinite(daysBack) && daysBack > 0 ? daysBack : 1);
      } catch (e) {
        console.error("[daily-revenue-snapshot] job failed:", e);
      }
    });
    console.log(`[daily-revenue-snapshot] scheduler enabled: ${cronExpr}`);
  } catch (e) {
    console.error("[daily-revenue-snapshot] invalid DAILY_REVENUE_SNAPSHOT_CRON:", e);
  }

  // Run once shortly after startup to backfill the last 7 days
  setTimeout(() => {
    runDailyRevenueSnapshotJob(7).catch((e) =>
      console.error("[daily-revenue-snapshot] startup backfill failed:", e)
    );
  }, 15_000);
}
