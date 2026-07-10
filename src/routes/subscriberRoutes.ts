import { Router } from "express";
import { authenticateSubscriber } from "../middleware/subscriberAuth";
import { authLoginLimiter, authRefreshLimiter } from "../middleware/rateLimiter";
import {
  subscriberLogin,
  subscriberRefresh,
  subscriberLogout,
  subscriberMe,
  subscriberUsage,
  subscriberSessions,
  subscriberInvoices,
  subscriberInvoiceDetail,
  subscriberPaymentProvider,
  subscriberPaymentIntent,
  subscriberReportWhishPayment,
  subscriberInvoiceClaims,
  subscriberWallet,
  subscriberPayFromWallet,
} from "../controllers/subscriberController";

const authRouter = Router();
authRouter.post("/login", authLoginLimiter, subscriberLogin);
authRouter.post("/refresh", authRefreshLimiter, subscriberRefresh);
authRouter.post("/logout", subscriberLogout);

const apiRouter = Router();
apiRouter.use(authenticateSubscriber);
apiRouter.get("/me", subscriberMe);
apiRouter.get("/wallet", subscriberWallet);
apiRouter.get("/usage", subscriberUsage);
apiRouter.get("/sessions", subscriberSessions);
apiRouter.get("/payment-provider", subscriberPaymentProvider);
apiRouter.get("/invoices", subscriberInvoices);
apiRouter.get("/invoices/:id", subscriberInvoiceDetail);
apiRouter.get("/invoices/:id/payment-claims", subscriberInvoiceClaims);
apiRouter.post("/invoices/:id/payment-intent", subscriberPaymentIntent);
apiRouter.post("/invoices/:id/report-whish-payment", subscriberReportWhishPayment);
apiRouter.post("/invoices/:id/pay-from-wallet", subscriberPayFromWallet);

export const subscriberAuthRoutes = authRouter;
export const subscriberApiRoutes = apiRouter;
