import { AppDataSource } from "../db/config";
import { TopupPlan } from "../db/entities/TopupPlan";
import { SubscriberTopup } from "../db/entities/SubscriberTopup";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { SubscriberWalletEntry } from "../db/entities/SubscriberWalletEntry";
import { createExternalInvoiceDebit } from "./invoiceService";
import { restoreSubscriberLine } from "./subscriberReactivationService";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";

export interface FormattedTopupPlan {
  id: number;
  name: string;
  extraBytes: string;
  gb: number;
  price: number;
  currency: string;
  formattedPrice: string;
  formattedQuota: string;
}

export const DEFAULT_TOPUP_PLANS = [
  { name: "Turbo Boost 20GB", gb: 20, price: 3.0, sortOrder: 1 },
  { name: "Turbo Boost 50GB", gb: 50, price: 6.0, sortOrder: 2 },
  { name: "Turbo Boost 120GB", gb: 120, price: 12.0, sortOrder: 3 },
  { name: "Turbo Boost 300GB", gb: 300, price: 25.0, sortOrder: 4 },
];

export async function ensureTopupTablesAndDefaults(): Promise<void> {
  try {
    await AppDataSource.query(`
      CREATE TABLE IF NOT EXISTS topup_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        extra_bytes BIGINT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        currency VARCHAR(8) DEFAULT 'USD',
        is_active TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await AppDataSource.query(`
      CREATE TABLE IF NOT EXISTS subscriber_topups (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL,
        plan_id INT NULL,
        plan_name VARCHAR(64) NOT NULL,
        extra_bytes BIGINT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        currency VARCHAR(8) DEFAULT 'USD',
        billing_month VARCHAR(7) NOT NULL,
        payment_method ENUM('wallet', 'invoice_debit', 'cash', 'whish', 'admin_grant') DEFAULT 'invoice_debit',
        invoice_id INT NULL,
        status ENUM('active', 'consumed', 'expired', 'cancelled') DEFAULT 'active',
        expires_at DATETIME NULL,
        created_by VARCHAR(64) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_subscriber_topup_user (username),
        INDEX idx_subscriber_topup_status (status),
        INDEX idx_subscriber_topup_month (billing_month)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const countRows = await AppDataSource.query(`SELECT COUNT(*) as cnt FROM topup_plans`);
    const count = Number(countRows?.[0]?.cnt ?? 0);
    if (count === 0) {
      for (const p of DEFAULT_TOPUP_PLANS) {
        const extraBytes = BigInt(p.gb) * BigInt(1024) * BigInt(1024) * BigInt(1024);
        await AppDataSource.query(
          `INSERT INTO topup_plans (name, extra_bytes, price, currency, is_active, sort_order)
           VALUES (?, ?, ?, 'USD', 1, ?)`,
          [p.name, extraBytes.toString(), p.price, p.sortOrder]
        );
      }
      console.log("[topupService] Seeded default Turbo Boost top-up plans");
    }
  } catch (err: any) {
    console.warn("[topupService] ensureTopupTablesAndDefaults warning:", err?.message || err);
  }
}

export async function getTopupPlans(): Promise<FormattedTopupPlan[]> {
  await ensureTopupTablesAndDefaults();
  const repo = AppDataSource.getRepository(TopupPlan);
  const rows = await repo.find({
    where: { isActive: true },
    order: { sortOrder: "ASC", id: "ASC" },
  });

  return rows.map((r) => {
    const bytes = BigInt(r.extraBytes || "0");
    const gb = Number(bytes / (BigInt(1024) * BigInt(1024) * BigInt(1024)));
    const priceNum = Number(r.price || 0);
    return {
      id: r.id,
      name: r.name,
      extraBytes: r.extraBytes,
      gb,
      price: priceNum,
      currency: r.currency || "USD",
      formattedPrice: `$${priceNum.toFixed(2)}`,
      formattedQuota: `${gb} GB`,
    };
  });
}

export async function getSubscriberActiveTopupBytes(
  username: string,
  billingMonth?: string
): Promise<bigint> {
  if (!username) return BigInt(0);
  try {
    const currentMonth = billingMonth || new Date().toISOString().slice(0, 7);
    const result = await AppDataSource.query(
      `SELECT COALESCE(SUM(extra_bytes), 0) AS total_extra
       FROM subscriber_topups
       WHERE username = ?
         AND status = 'active'
         AND billing_month = ?
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [username, currentMonth]
    );
    return BigInt(result?.[0]?.total_extra || "0");
  } catch {
    return BigInt(0);
  }
}

export async function getSubscriberTopupHistory(username: string): Promise<SubscriberTopup[]> {
  if (!username) return [];
  const repo = AppDataSource.getRepository(SubscriberTopup);
  return repo.find({
    where: { username },
    order: { createdAt: "DESC" },
  });
}

export async function getSubscriberWalletBalance(username: string): Promise<number> {
  const ledgerRepo = AppDataSource.getRepository(SubscriberWalletEntry);
  const rows = await ledgerRepo.find({ where: { username } });
  let balance = 0;
  for (const r of rows) {
    const val = Number(r.amount || 0);
    if (r.entryType === "credit") balance += val;
    else if (r.entryType === "debit") balance -= val;
  }
  return Math.max(0, balance);
}

export interface PurchaseTopupInput {
  username: string;
  planId: number;
  paymentMethod?: "wallet" | "invoice_debit" | "cash" | "whish" | "admin_grant";
  actorUsername?: string;
}

export interface PurchaseTopupResult {
  success: boolean;
  topup: SubscriberTopup;
  unthrottled: boolean;
  message: string;
  newTotalExtraBytes: string;
}

export async function purchaseTopupPack(input: PurchaseTopupInput): Promise<PurchaseTopupResult> {
  const username = String(input.username || "").trim();
  if (!username) throw new Error("Subscriber username is required");

  await ensureTopupTablesAndDefaults();

  const planRepo = AppDataSource.getRepository(TopupPlan);
  const plan = await planRepo.findOne({ where: { id: input.planId, isActive: true } });
  if (!plan) {
    throw new Error(`Top-up plan #${input.planId} not found or inactive`);
  }

  const paymentMethod = input.paymentMethod || "invoice_debit";
  const actor = input.actorUsername || username;
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  const priceNum = Number(plan.price || 0);

  // Calculate default expiration: end of current calendar month or 30 days
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  let linkedInvoiceId: number | null = null;

  // Handle Payment Settle
  if (paymentMethod === "wallet") {
    const balance = await getSubscriberWalletBalance(username);
    if (balance < priceNum) {
      throw new Error(`Insufficient wallet balance ($${balance.toFixed(2)}). Plan price is $${priceNum.toFixed(2)}.`);
    }

    const walletRepo = AppDataSource.getRepository(SubscriberWalletEntry);
    const entry = walletRepo.create({
      username,
      amount: priceNum.toFixed(2),
      currency: plan.currency || "USD",
      entryType: "debit",
      referenceType: "topup_purchase",
      referenceId: String(plan.id),
      note: `Purchased ${plan.name} (+${Number(BigInt(plan.extraBytes) / BigInt(1024**3))}GB)`,
      createdBy: actor,
    });
    await walletRepo.save(entry);
  } else if (paymentMethod === "invoice_debit") {
    try {
      // Find provider from existing invoices or default to XNet
      const extRepo = AppDataSource.getRepository(ExternalInvoice);
      const existing = await extRepo.findOne({
        where: { username },
        order: { id: "DESC" },
      });
      const provider = existing?.provider || "XNet";

      const debitInvoice = await createExternalInvoiceDebit({
        username,
        provider,
        billingMonth: currentMonth,
        debitLabel: `turbo-${plan.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        amount: priceNum,
        actorUsername: actor,
      });
      linkedInvoiceId = debitInvoice?.id != null ? Number(debitInvoice.id) : null;
    } catch (invErr: any) {
      console.warn("[topupService] Notice on creating invoice debit:", invErr?.message || invErr);
      // If already exists or cannot create, continue recording top-up with note
    }
  }

  // Record Top-Up in subscriber_topups
  const topupRepo = AppDataSource.getRepository(SubscriberTopup);
  const newTopup = topupRepo.create({
    username,
    planId: plan.id,
    planName: plan.name,
    extraBytes: plan.extraBytes,
    price: plan.price,
    currency: plan.currency || "USD",
    billingMonth: currentMonth,
    paymentMethod,
    invoiceId: linkedInvoiceId ?? null,
    status: "active",
    expiresAt: endOfMonth,
    createdBy: actor,
  });
  const savedTopup = await topupRepo.save(newTopup);

  // Check if subscriber was throttled or marked monthly exceeded
  let unthrottled = false;
  const userProfileRepo = AppDataSource.getRepository(Raduserprofile);
  const userProfile = await userProfileRepo.findOne({ where: { username } });

  if (userProfile && (userProfile.isMonthlyExceeded || userProfile.isFallback)) {
    try {
      await userProfileRepo.update({ username }, { isMonthlyExceeded: false, isFallback: false });
      const restoreResult = await restoreSubscriberLine(username, {
        force: true,
        trigger: "quota_restore",
      });
      unthrottled = Boolean(restoreResult.ok && restoreResult.restored);
    } catch (restoreErr: any) {
      console.warn("[topupService] Unthrottling restore line notice:", restoreErr?.message || restoreErr);
    }
  }

  const totalExtra = await getSubscriberActiveTopupBytes(username, currentMonth);

  return {
    success: true,
    topup: savedTopup,
    unthrottled,
    message: `Successfully activated ${plan.name}! ${
      unthrottled
        ? "Line has been automatically unthrottled and restored to full speed."
        : "Extra quota is now active for your current billing cycle."
    }`,
    newTotalExtraBytes: totalExtra.toString(),
  };
}
