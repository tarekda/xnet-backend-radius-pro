import cron from "node-cron";
import { cleanupOldBackups, runDbBackup, runMikrotikBackup } from "../controllers/backupController";

/**
 * Scheduler:
 * - BACKUP_DB_CRON: cron expression to run DB backup (e.g. "0 2 * * *")
 * - BACKUP_MIKROTIK_CRON: cron expression to run MikroTik export backup (e.g. "30 2 * * *")
 * - MIKROTIK_IP: default router IP for MikroTik backup
 * - BACKUP_RETENTION_DAYS: retention window (default 14)
 */
export function startBackupScheduler(_app: any) {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const configuredDbCron = String(process.env.BACKUP_DB_CRON ?? "").trim();
  const dbCron = configuredDbCron || (isProduction ? "0 2 * * *" : "");
  if (isProduction && !configuredDbCron) {
    console.warn("[backup] BACKUP_DB_CRON unset in production; defaulting to 0 2 * * * (02:00 local)");
  }
  if (isProduction && !String(process.env.BACKUP_OFFSITE_DIR || "").trim()) {
    console.warn("[backup] BACKUP_OFFSITE_DIR is unset. Local backups stay on this disk until you set an off-site copy path.");
  }
  const mkCron = String(process.env.BACKUP_MIKROTIK_CRON ?? "").trim();

  // Daily cleanup at 03:15 by default (can be overridden)
  const cleanupCron = String(process.env.BACKUP_CLEANUP_CRON ?? "15 3 * * *").trim();

  try {
    cron.schedule(cleanupCron, async () => {
      try {
        await cleanupOldBackups();
        // eslint-disable-next-line no-console
        console.log("[backup] cleanup completed");
      } catch (e) {
        console.error("[backup] cleanup failed", e);
      }
    });
  } catch (e) {
    console.error("[backup] invalid BACKUP_CLEANUP_CRON", e);
  }

  if (dbCron) {
    try {
      cron.schedule(dbCron, async () => {
        try {
          // call controller without auth by synthesizing req/res
          const req: any = { body: {}, query: {}, params: {}, user: { id: -1, username: "scheduler", role: "admin" } };
          const res: any = {
            status: () => res,
            json: () => null,
          };
          await runDbBackup(req, res);
          console.log("[backup] db backup completed");
        } catch (e) {
          console.error("[backup] db backup failed", e);
        }
      });
      console.log(`[backup] DB scheduler enabled: ${dbCron}`);
    } catch (e) {
      console.error("[backup] invalid BACKUP_DB_CRON", e);
    }
  }

  if (mkCron) {
    try {
      cron.schedule(mkCron, async () => {
        try {
          const req: any = {
            body: { host: process.env.MIKROTIK_IP },
            query: {},
            params: {},
            user: { id: -1, username: "scheduler", role: "admin" },
          };
          const res: any = {
            status: () => res,
            json: () => null,
          };
          await runMikrotikBackup(req, res);
          console.log("[backup] mikrotik backup completed");
        } catch (e) {
          console.error("[backup] mikrotik backup failed", e);
        }
      });
      console.log(`[backup] MikroTik scheduler enabled: ${mkCron}`);
    } catch (e) {
      console.error("[backup] invalid BACKUP_MIKROTIK_CRON", e);
    }
  }
}

