import { NextFunction, Request, Response } from "express";
import { registerDeviceToken, unregisterDeviceToken } from "../services/pushNotificationService";

/** Stores (or re-points) the push token of the device that just signed in. */
export const registerDeviceHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const username = req.user?.username;
    if (!username) {
      res.status(401).json({ success: false, message: "Not authenticated", data: null });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = String(body.token ?? "").trim();
    if (!token) {
      res.status(400).json({ success: false, message: "token is required", data: null });
      return;
    }

    const device = await registerDeviceToken({
      username,
      token,
      platform: body.platform === undefined ? null : String(body.platform),
      deviceName: body.deviceName === undefined ? null : String(body.deviceName),
    });

    res.status(201).json({
      success: true,
      message: "Device registered",
      data: { id: device.id, platform: device.platform },
    });
  } catch (err) {
    if (err instanceof Error) {
      res.status(400).json({ success: false, message: err.message, data: null });
      return;
    }
    next(err);
  }
};

/** Called on sign-out so the device stops receiving another user's alerts. */
export const unregisterDeviceHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const username = req.user?.username;
    if (!username) {
      res.status(401).json({ success: false, message: "Not authenticated", data: null });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const removed = await unregisterDeviceToken({
      username,
      token: body.token === undefined ? null : String(body.token),
    });

    res.status(200).json({ success: true, message: `${removed} device(s) removed`, data: { removed } });
  } catch (err) {
    next(err);
  }
};
