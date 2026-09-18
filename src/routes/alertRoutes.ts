import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import {
  getAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getAlerts,
  acknowledgeAlert,
  resolveAlert,
  getAlertSettings,
  updateAlertSettings,
  getAlertChannelConfig,
  testAlert,
  testWebhookEndpoint,
} from '../controllers/alertController';
import { authenticateToken, authorizePermissions } from '../middleware/authMiddleware';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);
router.use(authorizePermissions('admin.alerts.view'));

// Helper function to handle async route handlers
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

// Alert Rules routes
router.get('/rules', asyncHandler(getAlertRules));
router.post('/rules', asyncHandler(createAlertRule));
router.put('/rules/:id', asyncHandler(updateAlertRule));
router.delete('/rules/:id', asyncHandler(deleteAlertRule));

// Alerts routes
router.get('/', asyncHandler(getAlerts));
router.post('/:id/acknowledge', asyncHandler(acknowledgeAlert));
router.post('/:id/resolve', asyncHandler(resolveAlert));

// Alert Settings routes
router.get('/settings', asyncHandler(getAlertSettings));
router.put('/settings', asyncHandler(updateAlertSettings));

// Outbound channel configuration status (email / SMS)
router.get('/channels', asyncHandler(getAlertChannelConfig));

// Test route (for development)
router.post('/test', asyncHandler(testAlert));
router.post('/test-webhook', asyncHandler(testWebhookEndpoint));

export default router; 