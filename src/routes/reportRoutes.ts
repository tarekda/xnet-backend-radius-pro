import { Router } from "express";
import {
  createReportScheduleHandler,
  deleteReportScheduleHandler,
  generateReportHandler,
  listReportSchedulesHandler,
  listReportsHandler,
  runReportScheduleHandler,
  updateReportScheduleHandler,
} from "../controllers/reportController";
import {
  authenticateToken,
  authorizePermissions,
  authorizeRoles,
} from "../middleware/authMiddleware";

const router = Router();

// Catalog of available reports.
router.get(
  "/",
  authenticateToken,
  authorizePermissions("admin.reports.view"),
  authorizeRoles("admin", "manager", "support", "collector"),
  listReportsHandler
);

// ── Scheduled delivery ──────────────────────────────────────────────────────
// Declared before "/:key" so "schedules" is never treated as a report key.
router.get(
  "/schedules",
  authenticateToken,
  authorizePermissions("admin.reports.manage"),
  authorizeRoles("admin", "manager"),
  listReportSchedulesHandler
);

router.post(
  "/schedules",
  authenticateToken,
  authorizePermissions("admin.reports.manage"),
  authorizeRoles("admin", "manager"),
  createReportScheduleHandler
);

router.put(
  "/schedules/:id",
  authenticateToken,
  authorizePermissions("admin.reports.manage"),
  authorizeRoles("admin", "manager"),
  updateReportScheduleHandler
);

router.delete(
  "/schedules/:id",
  authenticateToken,
  authorizePermissions("admin.reports.manage"),
  authorizeRoles("admin", "manager"),
  deleteReportScheduleHandler
);

router.post(
  "/schedules/:id/run",
  authenticateToken,
  authorizePermissions("admin.reports.manage"),
  authorizeRoles("admin", "manager"),
  runReportScheduleHandler
);

// Generate / export a single report.
router.get(
  "/:key",
  authenticateToken,
  authorizePermissions("admin.reports.view"),
  authorizeRoles("admin", "manager", "support", "collector"),
  generateReportHandler
);

export default router;
