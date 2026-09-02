import { Logger } from "../logging/logging";
import { AppDataSource } from "../db/config";
import { WhishPaymentClaim } from "../db/entities/WhishPaymentClaim";
import { checkWhishTransactionStatus } from "../services/whishGateway";
import { confirmWhishPaymentClaim, rejectWhishPaymentClaim } from "../services/whishPaymentClaimService";

const logger = Logger.getInstance();

export async function runWhishClaimReconciliationJob() {
  logger.info("[whish-reconciliation] Starting pending claims reconciliation");

  try {
    const repo = AppDataSource.getRepository(WhishPaymentClaim);
    
    // Find all pending claims
    const pendingClaims = await repo.find({
      where: { status: "pending" as any },
      take: 50, // Batch limit
    });

    if (!pendingClaims.length) {
      logger.debug("[whish-reconciliation] No pending claims found");
      return;
    }

    let confirmed = 0;
    let rejected = 0;

    for (const claim of pendingClaims) {
      try {
        const result = await checkWhishTransactionStatus(claim.whishReference);

        if (result.status === "paid") {
          await confirmWhishPaymentClaim(claim.id!, "system_job", {
            amount: result.amount || claim.amount,
          });
          confirmed++;
          logger.info(`[whish-reconciliation] Auto-confirmed claim #${claim.id} (ref: ${claim.whishReference})`);
        } else if (result.status === "failed") {
          await rejectWhishPaymentClaim(claim.id!, "system_job", "Rejected by payment gateway reconciliation");
          rejected++;
          logger.info(`[whish-reconciliation] Auto-rejected claim #${claim.id} (ref: ${claim.whishReference})`);
        }
      } catch (err: any) {
        logger.warn(`[whish-reconciliation] Error processing claim #${claim.id}: ${err.message}`);
      }
    }

    logger.info(`[whish-reconciliation] Job complete. Confirmed: ${confirmed}, Rejected: ${rejected}`);
  } catch (err: any) {
    logger.error(`[whish-reconciliation] Job failed: ${err.message}`);
  }
}
