import { Router } from "express";
import {
  whatsappWebhookCloudHandler,
  whatsappWebhookTwilioHandler,
  whatsappWebhookVerifyHandler,
  simulateInboundAgentMessageHandler,
} from "../controllers/whatsappWebhookController";

const router = Router();

router.get("/", whatsappWebhookVerifyHandler);
router.post("/", whatsappWebhookCloudHandler);
router.post("/simulate", simulateInboundAgentMessageHandler);

export const whatsappTwilioWebhookRouter = Router();
whatsappTwilioWebhookRouter.post("/", whatsappWebhookTwilioHandler);

export default router;
