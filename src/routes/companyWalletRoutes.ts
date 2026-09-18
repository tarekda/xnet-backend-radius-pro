import { Router } from "express";
import { authenticateToken } from "../middleware/authMiddleware";
import {
  companyWalletBalance,
  companyWalletCredit,
  companyWalletDebit,
  companyWalletGet,
} from "../controllers/companyWalletController";

const router = Router();

router.get("/admin/company-wallet", authenticateToken, ...companyWalletGet);
router.get("/admin/company-wallet/balance", authenticateToken, ...companyWalletBalance);
router.post("/admin/company-wallet/credit", authenticateToken, ...companyWalletCredit);
router.post("/admin/company-wallet/debit", authenticateToken, ...companyWalletDebit);

export default router;
