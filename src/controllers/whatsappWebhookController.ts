import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import { Request, RequestHandler } from "express";
import twilio from "twilio";
import {
  isWhatsAppGroupAutoPayEnabled,
  payExternalInvoiceFromWhatsAppGroupMessage,
} from "../services/whatsappPaymentGroupService";
import {
  logInboundWhatsAppMessage,
  updateInboundWhatsAppMessageResult,
} from "../services/whatsappInboundMessageService";
import {
  performOcrOnImage,
  parseReceiptOcrText,
  matchReceiptWithInvoices,
} from "../services/whatsappReceiptOcrService";
import { processInboundAgentMessage } from "../services/whatsappAgentService";

async function downloadAndProcessMedia(mediaUrl: string, messageSid: string): Promise<{ localUrl: string; rawOcrText: string; extracted: any } | null> {
  try {
    const dir = path.join(process.cwd(), "uploads", "receipts");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const localFileName = `receipt-inbound-${messageSid || Date.now()}.jpg`;
    const localFilePath = path.join(dir, localFileName);

    const twilioSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
    const twilioAuth = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
    const authHeader = (twilioSid && twilioAuth && mediaUrl.includes("api.twilio.com"))
      ? { Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64")}` }
      : {};

    const resp = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: authHeader,
      timeout: 15000,
    });
    fs.writeFileSync(localFilePath, Buffer.from(resp.data));

    const rawOcrText = await performOcrOnImage(localFilePath);
    const extracted = parseReceiptOcrText(rawOcrText);
    return {
      localUrl: `/uploads/receipts/${localFileName}`,
      rawOcrText,
      extracted,
    };
  } catch (err: any) {
    console.warn("[whatsapp-webhook] Failed to download or OCR inbound media:", err?.message || err);
    return null;
  }
}

function verifyMetaSignature(req: Request, rawBody: Buffer): boolean {
  const secret = String(process.env.WHATSAPP_APP_SECRET || "").trim();
  if (!secret) return true;

  const header = String(req.header("x-hub-signature-256") || "");
  if (!header.startsWith("sha256=")) return false;
  const expected = header.slice("sha256=".length);
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(digest, "hex"));
  } catch {
    return false;
  }
}

function parseMetaCloudPayload(body: any): Array<{ text: string; groupId?: string; from?: string; messageId?: string }> {
  const out: Array<{ text: string; groupId?: string; from?: string; messageId?: string }> = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;
      const value = change?.value;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const msg of messages) {
        if (msg?.type !== "text" || !msg?.text?.body) continue;
        const groupId =
          msg?.group_id ||
          msg?.context?.group_id ||
          value?.metadata?.group_id ||
          undefined;
        out.push({
          text: String(msg.text.body),
          groupId: groupId ? String(groupId) : undefined,
          from: msg?.from ? String(msg.from) : undefined,
          messageId: msg?.id ? String(msg.id) : undefined,
        });
      }
    }
  }
  return out;
}

export const whatsappWebhookVerifyHandler: RequestHandler = (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  const verifyToken = String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "").trim();

  if (mode === "subscribe" && verifyToken && token === verifyToken) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
};

export const whatsappWebhookCloudHandler: RequestHandler = async (req, res) => {
  try {
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));

    if (!verifyMetaSignature(req, rawBody)) {
      res.sendStatus(403);
      return;
    }

    const body = JSON.parse(rawBody.toString("utf8"));
    if (body?.object !== "whatsapp_business_account") {
      res.sendStatus(200);
      return;
    }

    res.sendStatus(200);

    if (!isWhatsAppGroupAutoPayEnabled()) return;

    const messages = parseMetaCloudPayload(body);
    for (const msg of messages) {
      const record = await logInboundWhatsAppMessage({
        fromNumber: msg.from || "unknown",
        rawText: msg.text,
        messageSid: msg.messageId,
      });

      const agentResult = await processInboundAgentMessage({
        fromNumber: msg.from || "unknown",
        rawText: msg.text,
        messageSid: msg.messageId,
        groupId: msg.groupId,
      });

      await updateInboundWhatsAppMessageResult(record?.id, {
        ...(agentResult.paymentResult || {}),
        intent: agentResult.intent,
        replyText: agentResult.replyText,
        matchedUsername: agentResult.subscriber?.username ?? null,
      });

      console.log("[whatsapp-webhook] cloud message processed by AI agent", {
        from: msg.from,
        intent: agentResult.intent,
        delivered: agentResult.delivered,
        preview: msg.text.slice(0, 80),
      });
    }
  } catch (err) {
    console.error("[whatsapp-webhook] cloud handler error", err);
    if (!res.headersSent) res.sendStatus(500);
  }
};

export const whatsappWebhookTwilioHandler: RequestHandler = async (req, res) => {
  try {
    const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
    const shouldValidateSignature = String(process.env.TWILIO_VALIDATE_SIGNATURE || "").toLowerCase() === "true";
    if (authToken && shouldValidateSignature) {
      const signature = String(req.header("x-twilio-signature") || "");
      const proto = String(req.header("x-forwarded-proto") || req.protocol);
      const host = String(req.header("x-forwarded-host") || req.get("host"));
      const url = `${proto}://${host}${req.originalUrl}`;
      const valid = twilio.validateRequest(authToken, signature, url, req.body);
      if (!valid) {
        console.warn("[whatsapp-webhook] Twilio signature validation failed for URL:", url);
        res.sendStatus(403);
        return;
      }
    }

    let body = String(req.body?.Body || "").trim();
    const from = String(req.body?.From || req.body?.from || "");
    const messageSid = String(req.body?.MessageSid || "");
    const numMedia = parseInt(String(req.body?.NumMedia || "0"), 10);
    const mediaUrl0 = req.body?.MediaUrl0 ? String(req.body?.MediaUrl0) : null;
    const mediaContentType0 = req.body?.MediaContentType0 ? String(req.body?.MediaContentType0) : null;

    res.type("text/xml").send("<Response></Response>");

    let mediaOcrResult: { localUrl: string; rawOcrText: string; extracted: any } | null = null;
    if (numMedia > 0 && mediaUrl0) {
      mediaOcrResult = await downloadAndProcessMedia(mediaUrl0, messageSid);
      if (!body && mediaOcrResult?.extracted?.senderName) {
        body = `${mediaOcrResult.extracted.senderName} ${mediaOcrResult.extracted.amount ?? ""}`.trim();
      } else if (!body && mediaOcrResult?.rawOcrText) {
        body = mediaOcrResult.rawOcrText.slice(0, 120).trim();
      }
    }

    if (!body && !mediaOcrResult) return;

    const record = await logInboundWhatsAppMessage({
      fromNumber: from,
      rawText: body || "(media receipt)",
      messageSid,
      mediaUrl: mediaOcrResult?.localUrl,
      mediaType: mediaContentType0 || (mediaOcrResult ? "image/jpeg" : null),
      ocrRawText: mediaOcrResult?.rawOcrText,
      ocrExtractedData: mediaOcrResult?.extracted,
    });

    const agentResult = await processInboundAgentMessage({
      fromNumber: from,
      rawText: body || "(media receipt)",
      messageSid,
      mediaUrl: mediaOcrResult?.localUrl,
      mediaType: mediaContentType0 || (mediaOcrResult ? "image/jpeg" : null),
      ocrRawText: mediaOcrResult?.rawOcrText,
      ocrExtractedData: mediaOcrResult?.extracted,
      groupId: from.includes("@g.us") ? from : undefined,
    });

    await updateInboundWhatsAppMessageResult(record?.id, {
      ...(agentResult.paymentResult || {}),
      intent: agentResult.intent,
      replyText: agentResult.replyText,
      matchedUsername: agentResult.subscriber?.username ?? null,
    });

    console.log(
      "[whatsapp-webhook] twilio message processed by AI agent",
      JSON.stringify({
        from,
        intent: agentResult.intent,
        hasMedia: !!mediaOcrResult,
        delivered: agentResult.delivered,
        preview: (body || "").slice(0, 80),
      })
    );
  } catch (err) {
    console.error("[whatsapp-webhook] twilio handler error", err);
    if (!res.headersSent) res.sendStatus(500);
  }
};

export const simulateInboundAgentMessageHandler: RequestHandler = async (req, res) => {
  try {
    const fromNumber = String(req.body?.fromNumber || req.body?.phone || "+96170000000").trim();
    const message = String(req.body?.message || req.body?.text || "").trim();
    const mediaUrl = req.body?.mediaUrl ? String(req.body?.mediaUrl) : null;
    const ocrRawText = req.body?.ocrRawText ? String(req.body?.ocrRawText) : null;

    const result = await processInboundAgentMessage({
      fromNumber,
      rawText: message,
      mediaUrl,
      ocrRawText,
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    console.error("[whatsapp-webhook] Simulation error:", err);
    res.status(500).json({ success: false, message: err?.message || "Simulation failed" });
  }
};
