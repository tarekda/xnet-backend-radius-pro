import { Router } from "express";
import {
  getRevenueLeakageSummaryHandler,
  listRevenueLeakageAuditsHandler,
  runRevenueLeakageAuditHandler,
  remediateRevenueLeakageHandler,
  remediateAllRevenueLeakagesHandler,
} from "../controllers/revenueLeakageController";
import { authenticateToken, authorizeAnyPermissions } from "../middleware/authMiddleware";

const router = Router();

// Require authentication for all revenue leakage endpoints
router.use(authenticateToken);

// View summary metrics and audit records
router.get(
  "/summary",
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "admin.dashboard.view",
    "admin.revenue.view",
    "admin.alerts.view"
  ),
  getRevenueLeakageSummaryHandler
);

router.get(
  "/audits",
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "admin.dashboard.view",
    "admin.revenue.view"
  ),
  listRevenueLeakageAuditsHandler
);

// Run on-demand network audit
router.post(
  "/run-audit",
  authorizeAnyPermissions(
    "billing.externalInvoices.edit",
    "billing.externalInvoices.pay",
    "admin.dashboard.view"
  ),
  runRevenueLeakageAuditHandler
);

// Remediate a single detected leak
router.post(
  "/remediate/:id",
  authorizeAnyPermissions(
    "billing.externalInvoices.edit",
    "billing.externalInvoices.pay",
    "admin.dashboard.view"
  ),
  remediateRevenueLeakageHandler
);

// 1-Click bulk remediation
router.post(
  "/remediate-all",
  authorizeAnyPermissions(
    "billing.externalInvoices.edit",
    "billing.externalInvoices.pay",
    "admin.dashboard.view"
  ),
  remediateAllRevenueLeakagesHandler
);

export default router;
