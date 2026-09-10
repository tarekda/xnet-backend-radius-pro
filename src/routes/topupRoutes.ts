import { Router } from "express";
import { authenticateToken, authorizeAnyPermissions } from "../middleware/authMiddleware";
import {
  listTopupPlansHandler,
  getSubscriberTopupsHandler,
  purchaseTopupHandler,
} from "../controllers/topupController";

const router = Router();

router.get(
  "/plans",
  authenticateToken,
  listTopupPlansHandler
);

router.get(
  "/subscribers/:username",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "subscribers.view",
    "subscribers.manage"
  ),
  getSubscriberTopupsHandler
);

router.post(
  "/purchase",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.pay",
    "subscribers.manage"
  ),
  purchaseTopupHandler
);

export default router;
