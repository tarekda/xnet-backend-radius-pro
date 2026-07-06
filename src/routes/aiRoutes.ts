import { Router } from 'express';
import { diagnoseConnectivity, getDailyOpsBrief, getRecentRejectUsers } from '../controllers/aiController';
import { authenticateToken, authorizeAnyPermissions } from '../middleware/authMiddleware';

const router = Router();

const opsPerms = ['users.view', 'users.online.view', 'reseller.users.view'] as const;

router.post(
  '/ai/ops/diagnose/:username',
  authenticateToken,
  authorizeAnyPermissions(...opsPerms),
  diagnoseConnectivity
);

router.get(
  '/ai/ops/daily-brief',
  authenticateToken,
  authorizeAnyPermissions(...opsPerms),
  getDailyOpsBrief
);

router.get(
  '/ai/ops/recent-reject-users',
  authenticateToken,
  authorizeAnyPermissions(...opsPerms),
  getRecentRejectUsers
);

export default router;
