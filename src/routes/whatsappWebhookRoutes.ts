import { Router } from "express";
import {
  whatsappWebhookCloudHandler,
  whatsappWebhookTwilioHandler,
  whatsappWebhookVerifyHandler,
} from "../controllers/whatsappWebhookController";

const router = Router();

router.get("/", whatsappWebhookVerifyHandler);
router.post("/", whatsappWebhookCloudHandler);

export const whatsappTwilioWebhookRouter = Router();
whatsappTwilioWebhookRouter.post("/", whatsappWebhookTwilioHandler);

export default router;
