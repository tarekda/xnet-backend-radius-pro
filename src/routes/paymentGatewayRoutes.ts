import { Router, Request, Response } from "express";
import { authenticateToken, authorizeAnyPermissions } from "../middleware/authMiddleware";
import {
  createPaymentIntent,
  createCreditNote,
  getPaymentProviderStatus,
  handlePaymentWebhook,
  parseWhishCallbackPayload,
  signWebhookPayload,
  verifyProviderWebhookAuth,
} from "../services/paymentGatewayService";
import {
  confirmWhishPaymentClaim,
  listWhishPaymentClaims,
  rejectWhishPaymentClaim,
} from "../services/whishPaymentClaimService";

const router = Router();

router.get(
  "/payment-provider",
  authenticateToken,
  authorizeAnyPermissions("billing.externalInvoices.pay", "billing.externalInvoices.view"),
  (_req: Request, res: Response) => {
    res.status(200).json({ success: true, data: getPaymentProviderStatus() });
  }
);

router.get(
  "/whish-claims",
  authenticateToken,
  authorizeAnyPermissions("billing.externalInvoices.pay", "billing.externalInvoices.view"),
  async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status || "pending") as "pending" | "confirmed" | "rejected";
      const claims = await listWhishPaymentClaims({
        status: ["pending", "confirmed", "rejected"].includes(status) ? status : "pending",
      });
      res.status(200).json({ success: true, data: claims });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e?.message || "Failed to list claims" });
    }
  }
);

router.post(
  "/whish-claims/:claimId/confirm",
  authenticateToken,
  authorizeAnyPermissions("billing.externalInvoices.pay"),
  async (req: Request, res: Response) => {
    try {
      const claimId = parseInt(String(req.params.claimId), 10);
      const actor = (req.user as any)?.username || "system";
      const result = await confirmWhishPaymentClaim(claimId, actor, {
        paymentReference: req.body?.paymentReference || req.body?.whishReference,
        amount: req.body?.amount != null ? Number(req.body.amount) : undefined,
      });
      res.status(200).json({ success: true, data: result });
    } catch (e: any) {
      const status = e?.status && Number.isFinite(e.status) ? e.status : 400;
      res.status(status).json({ success: false, message: e?.message || "Failed to confirm claim" });
    }
  }
);

router.post(
  "/whish-claims/:claimId/reject",
  authenticateToken,
  authorizeAnyPermissions("billing.externalInvoices.pay", "billing.externalInvoices.unpay"),
  async (req: Request, res: Response) => {
    try {
      const claimId = parseInt(String(req.params.claimId), 10);
      const actor = (req.user as any)?.username || "system";
      const claim = await rejectWhishPaymentClaim(claimId, actor, req.body?.reason);
      res.status(200).json({ success: true, data: claim });
    } catch (e: any) {
      const status = e?.status && Number.isFinite(e.status) ? e.status : 400;
      res.status(status).json({ success: false, message: e?.message || "Failed to reject claim" });
    }
  }
);

router.post(
  "/external/:invoiceId/payment-intent",
  authenticateToken,
  authorizeAnyPermissions("billing.externalInvoices.pay"),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.invoiceId), 10);
      const intent = await createPaymentIntent(id);
      res.status(200).json({ success: true, data: intent });
    } catch (e: any) {
      const status = e?.status && Number.isFinite(e.status) ? e.status : 400;
      res.status(status).json({ success: false, message: e?.message || "Failed to create payment intent" });
    }
  }
);

router.post(
  "/external/:invoiceId/credit-note",
  authenticateToken,
  authorizeAnyPermissions("billing.externalInvoices.pay", "billing.externalInvoices.unpay"),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.invoiceId), 10);
      const actor = (req.user as any)?.username || "system";
      const note = await createCreditNote(id, actor);
      res.status(201).json({ success: true, data: note });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e?.message || "Failed to create credit note" });
    }
  }
);

export const paymentWebhookRoutes = Router();

async function processProviderWebhook(req: Request, res: Response, provider: string) {
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  const sig = String(req.headers["x-payment-signature"] || req.headers["x-whish-secret"] || "");
  const secretParam = String(
    (req.query as any)?.secret || (req.body as any)?.secret || req.headers["x-api-secret"] || ""
  );

  if (
    !verifyProviderWebhookAuth({
      provider,
      rawBody: raw,
      signature: sig || undefined,
      secretParam: secretParam || undefined,
    })
  ) {
    res.status(401).json({ success: false, message: "Invalid signature" });
    return;
  }

  const body = typeof req.body === "object" && req.body ? (req.body as Record<string, unknown>) : {};
  const parsed =
    provider === "whish"
      ? parseWhishCallbackPayload(body, req.query as Record<string, unknown>)
      : {
          gatewayIntentId: String((body as any).gatewayIntentId || (body as any).intent || ""),
          status: String((body as any).status || "succeeded"),
        };

  const intent = await handlePaymentWebhook(provider, parsed);
  res.status(200).json({ success: true, data: intent });
}

paymentWebhookRoutes.post("/:provider", async (req: Request, res: Response) => {
  try {
    await processProviderWebhook(req, res, String(req.params.provider).toLowerCase());
  } catch (e: any) {
    res.status(400).json({ success: false, message: e?.message || "Webhook failed" });
  }
});

/**
 * Whish/codnloc may hit a GET callback URL after payment.
 * Configure in merchant portal (if available):
 *   {PUBLIC_API_BASE_URL}/webhooks/payments/whish/callback?secret=WHISH_SECRET
 * Query may include order_id + status.
 */
paymentWebhookRoutes.get("/whish/callback", async (req: Request, res: Response) => {
  try {
    const parsed = parseWhishCallbackPayload(null, req.query as Record<string, unknown>);
    const secretParam = String((req.query as any)?.secret || "");
    const sig = String(req.headers["x-payment-signature"] || req.headers["x-whish-secret"] || "");
    if (
      !verifyProviderWebhookAuth({
        provider: "whish",
        rawBody: JSON.stringify(parsed),
        signature: sig || undefined,
        secretParam: secretParam || undefined,
      })
    ) {
      res.status(401).send("Invalid signature");
      return;
    }
    const intent = await handlePaymentWebhook("whish", parsed);
    const ok = intent.status === "succeeded";
    res
      .status(200)
      .send(
        `<html><body style="font-family:sans-serif;padding:2rem">` +
          `<h1>${ok ? "Payment received" : "Payment update"}</h1>` +
          `<p>Invoice payment is <strong>${intent.status}</strong>.</p>` +
          `<p><a href="/">Continue</a></p></body></html>`
      );
  } catch (e: any) {
    res.status(400).send(String(e?.message || "callback failed"));
  }
});

/** Dev helper: GET simulate marks stub intent succeeded (signed internally). */
paymentWebhookRoutes.get("/stub/simulate", async (req: Request, res: Response) => {
  try {
    const gatewayIntentId = String(req.query.intent || "");
    const payload = { gatewayIntentId, status: "succeeded" };
    const body = JSON.stringify(payload);
    const intent = await handlePaymentWebhook("stub", payload);
    res.status(200).send(
      `<html><body><h1>Payment simulated</h1><p>Intent ${intent.gatewayIntentId} → ${intent.status}</p>` +
        `<p>Signature (for POST): ${signWebhookPayload(body)}</p></body></html>`
    );
  } catch (e: any) {
    res.status(400).send(String(e?.message || "simulate failed"));
  }
});

export default router;
