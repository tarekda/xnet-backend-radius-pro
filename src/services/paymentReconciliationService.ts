import { AppDataSource } from "../db/config";
import { PaymentIntent } from "../db/entities/PaymentIntent";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { radiusAuthCacheService } from "./radiusAuthCacheService";
import { writeAuditLog } from "../audit/writeAuditLog";
import { invoiceEvents } from "../events/invoiceEvents";

export interface PaymentWebhookPayload {
  paymentIntentId?: string;
  transactionReference: string;
  username: string;
  amountPaid: number;
  currency: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  metadata?: Record<string, any>;
}

export class PaymentReconciliationService {
  /**
   * Idempotent payment webhook processing and subscriber line re-activation
   */
  async processPaymentWebhook(payload: PaymentWebhookPayload, reqContext?: any): Promise<{ success: boolean; message: string; reactivated: boolean }> {
    const { transactionReference, username, amountPaid, status } = payload;
    if (!username || !transactionReference) {
      return { success: false, message: "Missing username or transaction reference", reactivated: false };
    }

    if (status !== "SUCCESS") {
      return { success: true, message: `Payment status '${status}' recorded. No line action taken.`, reactivated: false };
    }

    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Idempotency check using PaymentIntent record
      let intentRepo = queryRunner.manager.getRepository(PaymentIntent);
      let intent = await intentRepo.findOne({
        where: { gatewayIntentId: transactionReference },
      });

      if (intent && intent.status === "succeeded") {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
        return { success: true, message: "Transaction already processed", reactivated: false };
      }

      if (!intent) {
        intent = intentRepo.create({
          gatewayIntentId: transactionReference,
          gatewayProvider: "webhook",
          externalInvoiceId: 0,
          amount: amountPaid,
          currency: payload.currency || "USD",
          status: "succeeded",
          createdAt: new Date(),
        });
      } else {
        intent.status = "succeeded";
      }
      await intentRepo.save(intent);

      // Re-activate subscriber line in Raduserprofile
      const userProfileRepo = queryRunner.manager.getRepository(Raduserprofile);
      const profile = await userProfileRepo.findOne({
        where: { username: username.trim() },
      });

      let reactivated = false;
      if (profile) {
        profile.accountStatus = "active";
        profile.isMonthlyExceeded = false;
        profile.isFallback = false;
        // Extend expiration by 30 days if expired or blank
        const now = new Date();
        const currentExp = profile.expiresAt ? new Date(profile.expiresAt) : now;
        const baseDate = currentExp > now ? currentExp : now;
        const newExp = new Date(baseDate);
        newExp.setDate(newExp.getDate() + 30);
        profile.expiresAt = newExp;

        await userProfileRepo.save(profile);
        reactivated = true;
      }

      await queryRunner.commitTransaction();

      // Clear RADIUS auth cache for subscriber
      await radiusAuthCacheService.invalidateUserCache(username);

      // Fire invoice events
      invoiceEvents.emit("invoice:paid", {
        username: username.trim(),
        transactionReference,
        amount: amountPaid,
        timestamp: new Date().toISOString(),
      });

      if (reqContext) {
        await writeAuditLog({
          req: reqContext,
          action: "payment.reconciliation.auto_activate",
          targetUsernames: [username.trim()],
          meta: { transactionReference, amountPaid, reactivated },
        }).catch(() => {});
      }

      return {
        success: true,
        message: `Payment reconciled successfully. Line for subscriber '${username}' activated until ${profile?.expiresAt?.toISOString() || 'N/A'}.`,
        reactivated,
      };
    } catch (err: any) {
      await queryRunner.rollbackTransaction();
      console.error("[PaymentReconciliation] Error during payment processing:", err);
      return { success: false, message: `Reconciliation error: ${err?.message || err}`, reactivated: false };
    } finally {
      await queryRunner.release();
    }
  }
}

export const paymentReconciliationService = new PaymentReconciliationService();
