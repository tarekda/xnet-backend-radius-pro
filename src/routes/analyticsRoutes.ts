import { Router, Request, Response } from "express";
import { authenticateToken, authorizeAnyPermissions } from "../middleware/authMiddleware";
import {
  usageHandler,
  metricsHandler,
  authDistributionHandler,
  geographicHandler,
  peakHoursHandler,
} from "../controllers/analyticsController";
import { clickhouseRollupService } from "../services/clickhouseRollupService";
import { anomalyDetectionService } from "../services/anomalyDetectionService";

const router = Router();

router.use(authenticateToken);
router.use(authorizeAnyPermissions("admin.analytics.view", "users.view", "reseller.users.view"));

router.get("/usage", usageHandler);
router.get("/metrics", metricsHandler);
router.get("/auth-distribution", authDistributionHandler);
router.get("/geographic", geographicHandler);
router.get("/peak-hours", peakHoursHandler);

/**
 * ClickHouse Daily Bandwidth Usage query per subscriber
 */
router.get("/daily-usage/:username", async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const { startDate, endDate } = req.query;
    const data = await clickhouseRollupService.getSubscriberDailyUsage(
      username,
      startDate as string,
      endDate as string
    );
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || err });
  }
});

/**
 * Subscriber Line Flapping & MAC Spoofing anomaly diagnostics
 */
router.get("/anomalies/:username", async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const flapping = await anomalyDetectionService.detectLineFlapping(username);
    const spoofing = await anomalyDetectionService.detectMacSpoofing(username);
    res.json({ success: true, data: { flapping, spoofing } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || err });
  }
});

export default router;
