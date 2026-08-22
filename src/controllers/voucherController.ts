import { Request, Response } from "express";
import { voucherService } from "../services/voucherService";

export const getVoucherBatches = async (req: Request, res: Response): Promise<void> => {
  try {
    const batches = await voucherService.listBatches();
    res.status(200).json({ success: true, data: batches });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || "Failed to fetch batches" });
  }
};

export const getVoucherBatchDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { batchId } = req.params;
    const batch = await voucherService.getBatchById(batchId);
    if (!batch) {
      res.status(404).json({ success: false, message: "Batch not found" });
      return;
    }
    const search = String(req.query.search || "");
    const status = String(req.query.status || "all");
    const cards = await voucherService.getBatchCards(batchId, search, status);
    res.status(200).json({ success: true, data: { batch, cards } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || "Failed to fetch batch details" });
  }
};

export const createVoucherBatch = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const { name, profileId, profileName, quantity, durationDays, price, currency, prefix } = req.body;

    if (!profileId) {
      res.status(400).json({ success: false, message: "Profile ID is required" });
      return;
    }

    const result = await voucherService.createBatch({
      name,
      profileId: Number(profileId),
      profileName,
      quantity: Number(quantity) || 20,
      durationDays: Number(durationDays) || 30,
      price: Number(price) || 0,
      currency: currency || "USD",
      prefix: prefix || "XNET",
      createdBy: user?.username || "admin",
    });

    res.status(201).json({ success: true, message: "Voucher batch generated successfully", data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || "Failed to create voucher batch" });
  }
};

export const redeemVoucher = async (req: Request, res: Response): Promise<void> => {
  try {
    const { pinCode, username } = req.body;
    if (!pinCode || !username) {
      res.status(400).json({ success: false, message: "PIN code and subscriber username are required" });
      return;
    }

    const result = await voucherService.redeemVoucher(pinCode, username);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || "Redemption failed" });
  }
};

export const revokeVoucherCard = async (req: Request, res: Response): Promise<void> => {
  try {
    const { cardId } = req.params;
    const success = await voucherService.revokeCard(cardId);
    if (!success) {
      res.status(400).json({ success: false, message: "Cannot revoke card (already used or not found)" });
      return;
    }
    res.status(200).json({ success: true, message: "Card revoked successfully" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || "Failed to revoke card" });
  }
};

export const getVoucherMetrics = async (req: Request, res: Response): Promise<void> => {
  try {
    const metrics = await voucherService.getMetrics();
    res.status(200).json({ success: true, data: metrics });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || "Failed to get voucher metrics" });
  }
};
