import { Router } from "express";
import {
  getVoucherBatches,
  getVoucherBatchDetail,
  createVoucherBatch,
  redeemVoucher,
  revokeVoucherCard,
  getVoucherMetrics,
} from "../controllers/voucherController";
import { authenticateToken, authorizeAnyPermissions } from "../middleware/authMiddleware";

const router = Router();

router.get(
  "/batches",
  authenticateToken,
  authorizeAnyPermissions("radius.profiles.view", "billing.externalInvoices.view", "users.view"),
  getVoucherBatches
);

router.post(
  "/batches",
  authenticateToken,
  authorizeAnyPermissions("radius.profiles.manage", "billing.externalInvoices.pay", "admin.access.manage"),
  createVoucherBatch
);

router.get(
  "/batches/:batchId",
  authenticateToken,
  authorizeAnyPermissions("radius.profiles.view", "billing.externalInvoices.view", "users.view"),
  getVoucherBatchDetail
);

router.post(
  "/redeem",
  authenticateToken,
  authorizeAnyPermissions("users.manage", "users.view", "billing.externalInvoices.pay"),
  redeemVoucher
);

router.post(
  "/cards/:cardId/revoke",
  authenticateToken,
  authorizeAnyPermissions("radius.profiles.manage", "admin.access.manage"),
  revokeVoucherCard
);

router.get(
  "/metrics",
  authenticateToken,
  authorizeAnyPermissions("radius.profiles.view", "billing.externalInvoices.view", "admin.analytics.view"),
  getVoucherMetrics
);

export default router;
