import { Request, Response } from "express";
import { authorizeAnyPermissions } from "../middleware/authMiddleware";
import {
  creditCompanyWallet,
  debitCompanyWallet,
  getCompanyWalletBalance,
  listCompanyWalletLedger,
} from "../services/companyWalletService";

function send(res: Response, success: boolean, status: number, message: string, data?: unknown) {
  res.status(status).json({ success, message, data });
}

export const companyWalletGet = [
  authorizeAnyPermissions(
    "billing.companyWallet.view",
    "admin.resellers.manage",
    "admin.access.manage",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.view"
  ),
  async (req: Request, res: Response) => {
    try {
      const entryTypeRaw = String(req.query.entryType || "").toLowerCase();
      const entryType =
        entryTypeRaw === "credit" || entryTypeRaw === "debit" ? entryTypeRaw : undefined;
      const page = parseInt(String(req.query.page || "1"), 10);
      const limit = parseInt(String(req.query.limit || "50"), 10);
      const result = await listCompanyWalletLedger({ entryType, page, limit });
      send(res, true, 200, "Company wallet fetched", result);
    } catch (e: any) {
      send(res, false, e?.status && Number.isFinite(e.status) ? e.status : 400, e?.message || "Failed to load company wallet");
    }
  },
];

export const companyWalletBalance = [
  authorizeAnyPermissions(
    "billing.companyWallet.view",
    "admin.resellers.manage",
    "admin.access.manage",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.view"
  ),
  async (_req: Request, res: Response) => {
    try {
      const balance = await getCompanyWalletBalance();
      send(res, true, 200, "Company wallet balance", { balance });
    } catch (e: any) {
      send(res, false, 400, e?.message || "Failed to load company wallet balance");
    }
  },
];

export const companyWalletCredit = [
  authorizeAnyPermissions(
    "billing.companyWallet.manage",
    "admin.resellers.fund",
    "admin.access.manage",
    "billing.externalInvoices.pay"
  ),
  async (req: Request, res: Response) => {
    try {
      const amount = Number(req.body?.amount);
      const note = req.body?.note ? String(req.body.note) : null;
      const actor = (req.user as any)?.username || "system";
      const entry = await creditCompanyWallet({
        amount,
        referenceType: "admin_credit",
        referenceId: `admin_${Date.now()}`,
        note: note || "Manual company wallet credit",
        createdBy: actor,
      });
      const balance = await getCompanyWalletBalance();
      send(res, true, 201, "Company wallet credited", { entry, balance });
    } catch (e: any) {
      send(res, false, e?.status && Number.isFinite(e.status) ? e.status : 400, e?.message || "Failed to credit company wallet");
    }
  },
];

export const companyWalletDebit = [
  authorizeAnyPermissions(
    "billing.companyWallet.manage",
    "admin.resellers.fund",
    "admin.access.manage",
    "billing.externalInvoices.pay"
  ),
  async (req: Request, res: Response) => {
    try {
      const amount = Number(req.body?.amount);
      const note = req.body?.note ? String(req.body.note) : null;
      const actor = (req.user as any)?.username || "system";
      const entry = await debitCompanyWallet({
        amount,
        referenceType: "admin_debit",
        referenceId: `admin_debit_${Date.now()}`,
        note: note || "Manual company wallet debit",
        createdBy: actor,
      });
      const balance = await getCompanyWalletBalance();
      send(res, true, 201, "Company wallet debited", { entry, balance });
    } catch (e: any) {
      send(res, false, e?.status && Number.isFinite(e.status) ? e.status : 400, e?.message || "Failed to debit company wallet");
    }
  },
];
