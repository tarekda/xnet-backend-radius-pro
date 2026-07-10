import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../config/requireSecrets";

export type SubscriberJwt = {
  type: "subscriber";
  username: string;
};

declare global {
  namespace Express {
    interface Request {
      subscriber?: SubscriberJwt;
    }
  }
}

const jwtSecret = getJwtSecret();

export function authenticateSubscriber(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  try {
    const decoded = jwt.verify(header.slice(7), jwtSecret) as any;
    if (decoded?.type !== "subscriber" || !decoded?.username) {
      res.status(403).json({ success: false, message: "Subscriber token required" });
      return;
    }
    req.subscriber = { type: "subscriber", username: String(decoded.username) };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid token" });
  }
}
