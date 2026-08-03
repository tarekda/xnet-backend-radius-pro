import crypto from "crypto";
import { Request, RequestHandler } from "express";
import twilio from "twilio";
import {
  isWhatsAppGroupAutoPayEnabled,
  payExternalInvoiceFromWhatsAppGroupMessage,
} from "../services/whatsappPaymentGroupService";

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
      const result = await payExternalInvoiceFromWhatsAppGroupMessage(msg.text, {
        groupId: msg.groupId,
        from: msg.from,
        messageId: msg.messageId,
      });
      console.log("[whatsapp-webhook] cloud message processed", { result, preview: msg.text.slice(0, 80) });
    }
  } catch (err) {
    console.error("[whatsapp-webhook] cloud handler error", err);
    if (!res.headersSent) res.sendStatus(500);
  }
};

export const whatsappWebhookTwilioHandler: RequestHandler = async (req, res) => {
  try {
    const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
    if (authToken) {
      const signature = String(req.header("x-twilio-signature") || "");
      const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
      const valid = twilio.validateRequest(authToken, signature, url, req.body);
      if (!valid) {
        res.sendStatus(403);
        return;
      }
    }

    const body = String(req.body?.Body || "").trim();
    const from = String(req.body?.From || req.body?.from || "");

    res.type("text/xml").send("<Response></Response>");

    if (!body) return;

    const result = await payExternalInvoiceFromWhatsAppGroupMessage(body, {
      from,
      groupId: from.includes("@g.us") ? from : undefined,
      messageId: String(req.body?.MessageSid || ""),
    });
    console.log(
      "[whatsapp-webhook] twilio message processed",
      JSON.stringify({
        from,
        preview: body.slice(0, 80),
        result,
      })
    );
  } catch (err) {
    console.error("[whatsapp-webhook] twilio handler error", err);
    if (!res.headersSent) res.sendStatus(500);
  }
};
