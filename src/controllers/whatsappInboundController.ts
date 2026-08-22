import { RequestHandler } from "express";
import {
  fetchInboundWhatsAppMessages,
  retryInboundWhatsAppMessage,
} from "../services/whatsappInboundMessageService";

export const getInboundWhatsAppMessagesHandler: RequestHandler = async (req, res) => {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const search = req.query.search ? String(req.query.search) : undefined;
    const fromNumber = req.query.fromNumber ? String(req.query.fromNumber) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;

    const data = await fetchInboundWhatsAppMessages({ page, limit, search, fromNumber, status });
    res.json({ status: "success", data });
  } catch (err: any) {
    res.status(500).json({ status: "error", message: err?.message || "Failed to fetch inbound messages" });
  }
};

export const retryInboundWhatsAppMessageHandler: RequestHandler = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ status: "error", message: "Invalid message ID" });
      return;
    }

    const result = await retryInboundWhatsAppMessage(id);
    res.json({ status: "success", data: result });
  } catch (err: any) {
    res.status(500).json({ status: "error", message: err?.message || "Failed to retry message" });
  }
};
