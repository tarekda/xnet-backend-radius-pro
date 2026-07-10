import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { bandwidthController } from '../controllers/bandwidthController';
import { authenticateToken, authorizeAnyPermissions } from '../middleware/authMiddleware';

const router = Router();

// Auth + permission: MikroTik metrics are admin/ops only
router.use(authenticateToken);
router.use(authorizeAnyPermissions('admin.analytics.view', 'users.online.view'));

// Helper function to handle async route handlers
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

// Get bandwidth summary (total traffic across all interfaces)
router.get('/summary', asyncHandler(bandwidthController.getBandwidthSummary.bind(bandwidthController)));

// Get traffic data for all interfaces
router.get('/interfaces', asyncHandler(bandwidthController.getInterfaceTraffic.bind(bandwidthController)));

// Get historical traffic data for a specific interface
router.get('/historical', asyncHandler(bandwidthController.getHistoricalTraffic.bind(bandwidthController)));

// Get system resources (CPU, memory, etc.)
router.get('/system', asyncHandler(bandwidthController.getSystemResources.bind(bandwidthController)));

// Test connection to MikroTik router
router.get('/test', asyncHandler(bandwidthController.testConnection.bind(bandwidthController)));

// Get comprehensive bandwidth metrics (combines summary and system data)
router.get('/metrics', asyncHandler(bandwidthController.getBandwidthMetrics.bind(bandwidthController)));

export default router;
