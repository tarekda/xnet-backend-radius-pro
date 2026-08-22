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
} from "../controllers/resellerController";

const router = Router();

// Admin endpoints
router.get("/admin/resellers", authenticateToken, ...resellerAdminList);
router.post("/admin/resellers", authenticateToken, ...resellerAdminCreate);
router.post("/admin/resellers/:id/login", authenticateToken, ...resellerAdminCreateLogin);
router.post("/admin/resellers/:id/fund", authenticateToken, ...resellerAdminFund);
router.post("/admin/resellers/:id/debit", authenticateToken, ...resellerAdminDebit);
router.get("/admin/resellers/:id/ledger", authenticateToken, ...resellerAdminLedger);

// Reseller portal endpoints
router.get("/reseller/me", authenticateToken, authorizePermissions("reseller.portal.access"), ...resellerMe);
router.get("/reseller/users", authenticateToken, authorizePermissions("reseller.users.view"), ...resellerUsersList);
router.post("/reseller/users", authenticateToken, authorizePermissions("reseller.users.manage"), ...resellerUsersCreate);

export default router;

