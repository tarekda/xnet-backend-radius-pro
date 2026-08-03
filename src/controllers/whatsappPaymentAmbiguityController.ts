import { Request, RequestHandler, Response } from "express";
import {
  dismissWhatsappPaymentAmbiguity,
  listWhatsappPaymentAmbiguities,
  resolveWhatsappPaymentAmbiguity,
} from "../services/whatsappPaymentAmbiguityService";

const sendResponse = (res: Response, success: boolean, status: number, message: string, data: unknown = null) => {
  res.status(status).json({ success, message, data });
};

export const listWhatsappPaymentAmbiguitiesHandler: RequestHandler = async (req, res) => {
  try {
    const statusRaw = String(req.query.status || "pending").toLowerCase();
    const status =
      statusRaw === "resolved" || statusRaw === "dismissed" ? statusRaw : ("pending" as const);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
    const rows = await listWhatsappPaymentAmbiguities({ status, limit });
    sendResponse(res, true, 200, "WhatsApp payment ambiguities fetched", rows);
  } catch (err) {
    console.error("listWhatsappPaymentAmbiguitiesHandler:", err);
    sendResponse(res, false, 500, "Failed to fetch ambiguities");
  }
};

export const resolveWhatsappPaymentAmbiguityHandler: RequestHandler = async (req, res) => {
  try {
    const ambiguityId = parseInt(String(req.params.ambiguityId), 10);
    const invoiceId = parseInt(String(req.body?.invoiceId), 10);
    if (!Number.isFinite(ambiguityId) || ambiguityId <= 0) {
      sendResponse(res, false, 400, "Invalid ambiguity id");
      return;
    }
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      sendResponse(res, false, 400, "invoiceId is required");
      return;
    }
    const actor = String((req as any).user?.username || "staff");
    const result = await resolveWhatsappPaymentAmbiguity(ambiguityId, invoiceId, actor);
    sendResponse(res, true, 200, "Payment applied", result);
  } catch (err: any) {
    const status = err?.status || 500;
    const message = err?.message || "Failed to resolve ambiguity";
    if (status >= 500) console.error("resolveWhatsappPaymentAmbiguityHandler:", err);
    sendResponse(res, false, status, message);
  }
};

export const dismissWhatsappPaymentAmbiguityHandler: RequestHandler = async (req, res) => {
  try {
    const ambiguityId = parseInt(String(req.params.ambiguityId), 10);
    if (!Number.isFinite(ambiguityId) || ambiguityId <= 0) {
      sendResponse(res, false, 400, "Invalid ambiguity id");
      return;
    }
    const actor = String((req as any).user?.username || "staff");
    const row = await dismissWhatsappPaymentAmbiguity(
      ambiguityId,
      actor,
      req.body?.reason ? String(req.body.reason) : undefined
    );
    sendResponse(res, true, 200, "Ambiguity dismissed", row);
  } catch (err: any) {
    const status = err?.status || 500;
    const message = err?.message || "Failed to dismiss ambiguity";
    if (status >= 500) console.error("dismissWhatsappPaymentAmbiguityHandler:", err);
    sendResponse(res, false, status, message);
  }
};
