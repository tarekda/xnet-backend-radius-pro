import { Router } from "express";
import { authenticateToken, authorizeAnyPermissions } from "../middleware/authMiddleware";
import {
  usageHandler,
  metricsHandler,
  authDistributionHandler,
  geographicHandler,
  peakHoursHandler,
} from "../controllers/analyticsController";

const router = Router();

router.use(authenticateToken);
router.use(authorizeAnyPermissions("admin.analytics.view"));

router.get("/usage", usageHandler);
router.get("/metrics", metricsHandler);
router.get("/auth-distribution", authDistributionHandler);
router.get("/geographic", geographicHandler);
router.get("/peak-hours", peakHoursHandler);

export default router;
