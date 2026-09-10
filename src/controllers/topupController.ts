import { Request, Response } from "express";
import {
  getTopupPlans,
  getSubscriberTopupHistory,
  purchaseTopupPack,
  getSubscriberActiveTopupBytes,
  getSubscriberWalletBalance,
} from "../services/topupService";

export const listTopupPlansHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await getTopupPlans();
    res.json({ success: true, data: plans });
  } catch (err: any) {
    console.error("[topupController] listTopupPlansHandler error:", err);
    res.status(500).json({ success: false, message: err?.message || "Failed to load topup plans" });
  }
};

export const getSubscriberTopupsHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) {
      res.status(400).json({ success: false, message: "Username is required" });
      return;
    }

    const history = await getSubscriberTopupHistory(username);
    const activeBytes = await getSubscriberActiveTopupBytes(username);
    const walletBalance = await getSubscriberWalletBalance(username);

    res.json({
      success: true,
      data: {
        username,
        activeTopupBytes: activeBytes.toString(),
        walletBalance,
        history,
      },
    });
  } catch (err: any) {
    console.error("[topupController] getSubscriberTopupsHandler error:", err);
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch subscriber topups" });
  }
};

export const purchaseTopupHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.body?.username || "").trim();
    const planId = Number(req.body?.planId);
    const paymentMethod = req.body?.paymentMethod || "invoice_debit";
    const actorUsername = (req as any).user?.username || "system";

    if (!username || !planId) {
      res.status(400).json({ success: false, message: "username and planId are required" });
      return;
    }

    const result = await purchaseTopupPack({
      username,
      planId,
      paymentMethod,
      actorUsername,
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    console.error("[topupController] purchaseTopupHandler error:", err);
    res.status(400).json({ success: false, message: err?.message || "Failed to purchase topup" });
  }
};

/** Subscriber Portal Self-Service Handlers */
export const subscriberGetTopupPlansHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = (req as any).subscriber?.username;
    const plans = await getTopupPlans();
    let walletBalance = 0;
    let activeExtraBytes = "0";

    if (username) {
      walletBalance = await getSubscriberWalletBalance(username);
      const active = await getSubscriberActiveTopupBytes(username);
      activeExtraBytes = active.toString();
    }

    res.json({
      success: true,
      data: {
        plans,
        walletBalance,
        activeExtraBytes,
      },
    });
  } catch (err: any) {
    console.error("[topupController] subscriberGetTopupPlansHandler error:", err);
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch topup options" });
  }
};

export const subscriberBuyTopupHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = (req as any).subscriber?.username;
    if (!username) {
      res.status(401).json({ success: false, message: "Unauthorized subscriber" });
      return;
    }

    const planId = Number(req.body?.planId);
    const paymentMethod = req.body?.paymentMethod === "wallet" ? "wallet" : "invoice_debit";

    if (!planId) {
      res.status(400).json({ success: false, message: "planId is required" });
      return;
    }

    const result = await purchaseTopupPack({
      username,
      planId,
      paymentMethod,
      actorUsername: `subscriber:${username}`,
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    console.error("[topupController] subscriberBuyTopupHandler error:", err);
    res.status(400).json({ success: false, message: err?.message || "Failed to purchase topup pack" });
  }
};
