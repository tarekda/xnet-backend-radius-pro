import { Router } from "express";
import { authenticateToken, authorizePermissions } from "../middleware/authMiddleware";
import {
  resellerAdminCreate,
  resellerAdminCreateLogin,
  resellerAdminDebit,
  resellerAdminFund,
  resellerAdminLedger,
  resellerAdminList,
  resellerMe,
  resellerUsersCreate,
  resellerUsersList,
  resellerAdminGetCommission,
  resellerAdminPayoutCommission,
  resellerGetMyCommission,
} from "../controllers/resellerController";

const router = Router();

// Admin endpoints
router.get("/admin/resellers", authenticateToken, ...resellerAdminList);
router.post("/admin/resellers", authenticateToken, ...resellerAdminCreate);
router.post("/admin/resellers/:id/login", authenticateToken, ...resellerAdminCreateLogin);
router.post("/admin/resellers/:id/fund", authenticateToken, ...resellerAdminFund);
router.post("/admin/resellers/:id/debit", authenticateToken, ...resellerAdminDebit);
router.get("/admin/resellers/:id/ledger", authenticateToken, ...resellerAdminLedger);
router.get("/admin/resellers/:id/commission", authenticateToken, ...resellerAdminGetCommission);
router.post("/admin/resellers/:id/commission/payout", authenticateToken, ...resellerAdminPayoutCommission);

// Reseller portal endpoints
router.get("/reseller/me", authenticateToken, authorizePermissions("reseller.portal.access"), ...resellerMe);
router.get("/reseller/commission", authenticateToken, authorizePermissions("reseller.portal.access"), ...resellerGetMyCommission);
router.get("/reseller/users", authenticateToken, authorizePermissions("reseller.users.view"), ...resellerUsersList);
router.post("/reseller/users", authenticateToken, authorizePermissions("reseller.users.manage"), ...resellerUsersCreate);

export default router;

