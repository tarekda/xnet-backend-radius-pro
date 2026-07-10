import { Router } from 'express';
import { register, login, refreshToken, logout, profile, getAllUsers, updateUser, deleteUser, changePassword, adminResetUserPassword } from '../controllers/authController';
import { mobileLogin, mobileRefresh, mobileLogout } from '../controllers/mobileAuthController';
import {
  verifyMfaLogin,
  mobileVerifyMfaLogin,
  mfaSetup,
  mfaConfirm,
  mfaDisable,
  mfaStatus,
} from '../controllers/mfaController';
import { authenticateToken, authorizeAnyPermissions } from '../middleware/authMiddleware';
import { authLoginLimiter, authRefreshLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/register', authenticateToken, authorizeAnyPermissions("admin.authUsers.manage"), register);
router.get('/users', authenticateToken, authorizeAnyPermissions("admin.authUsers.manage"), getAllUsers);
router.put('/users/:id', authenticateToken, authorizeAnyPermissions("admin.authUsers.manage"), updateUser);
router.post('/users/:id/reset-password', authenticateToken, authorizeAnyPermissions("admin.authUsers.manage"), adminResetUserPassword);
router.delete('/users/:username', authenticateToken, authorizeAnyPermissions("admin.authUsers.manage"), deleteUser);

router.post('/login', authLoginLimiter, login);
router.post('/mfa/verify-login', authLoginLimiter, verifyMfaLogin);
router.get('/mfa/status', authenticateToken, mfaStatus);
router.post('/mfa/setup', authenticateToken, mfaSetup);
router.post('/mfa/confirm', authenticateToken, mfaConfirm);
router.post('/mfa/disable', authenticateToken, mfaDisable);
router.post('/refresh-token', authRefreshLimiter, refreshToken);
router.post('/logout', logout);
router.get('/profile', authenticateToken, profile);
router.post('/change-password', authenticateToken, changePassword);

router.post('/mobile/login', authLoginLimiter, mobileLogin);
router.post('/mobile/mfa/verify-login', authLoginLimiter, mobileVerifyMfaLogin);
router.post('/mobile/refresh', authRefreshLimiter, mobileRefresh);
router.post('/mobile/logout', mobileLogout);

export default router;
