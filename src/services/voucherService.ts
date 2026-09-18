import { randomBytes } from "crypto";
import { redisClient } from "../redisClient";
import { AppDataSource } from "../db/config";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { radiusAuthCacheService } from "./radiusAuthCacheService";

export interface VoucherCard {
  id: string;
  batchId: string;
  serialNumber: string;
  pinCode: string;
  profileId: number;
  profileName: string;
  durationDays: number;
  price: number;
  currency: string;
  status: "unused" | "used" | "revoked" | "expired";
  usedByUsername?: string;
  usedAt?: string;
  createdAt: string;
}

export interface VoucherBatch {
  id: string;
  name: string;
  profileId: number;
  profileName: string;
  quantity: number;
  durationDays: number;
  price: number;
  currency: string;
  prefix: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  totalCount: number;
  usedCount: number;
  status: "active" | "expired" | "depleted";
}

// In-memory store initialized with Redis cache persistence
let batchesStore: VoucherBatch[] = [];
let cardsStore: VoucherCard[] = [];

const REDIS_BATCHES_KEY = "vouchers:batches:all";
const REDIS_CARDS_KEY = "vouchers:cards:all";

async function persistToRedis() {
  try {
    if (redisClient && redisClient.isReady) {
      await redisClient.set(REDIS_BATCHES_KEY, JSON.stringify(batchesStore));
      await redisClient.set(REDIS_CARDS_KEY, JSON.stringify(cardsStore));
    }
  } catch (err) {
    console.error("Failed to persist vouchers to Redis:", err);
  }
}

async function loadFromRedis() {
  try {
    if (redisClient && redisClient.isReady) {
      const bData = await redisClient.get(REDIS_BATCHES_KEY);
      const cData = await redisClient.get(REDIS_CARDS_KEY);
      if (bData) batchesStore = JSON.parse(bData);
      if (cData) cardsStore = JSON.parse(cData);
    }
  } catch (err) {
    console.error("Failed to load vouchers from Redis:", err);
  }
}

// Generate secure 12-character alphanumeric PIN: e.g. 7482-9381-0293
function generatePin(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // No 0/O/1/I to avoid visual confusion
  const bytes = randomBytes(12);
  let raw = "";
  for (let i = 0; i < 12; i++) {
    raw += chars[bytes[i] % chars.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// Generate serial number: e.g. SN-8392-4912
function generateSerialNumber(prefix: string, index: number): string {
  const p = (prefix || "SN").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const rand = randomBytes(2).toString("hex").toUpperCase();
  const num = String(index + 1).padStart(4, "0");
  return `${p}-${rand}-${num}`;
}

export const voucherService = {
  async init() {
    await loadFromRedis();
    // Seed initial demo batch if empty for instant out-of-the-box readiness
    if (batchesStore.length === 0) {
      await this.createBatch({
        name: "Standard 30-Day Starter Pack",
        profileId: 1,
        profileName: "Standard 10Mbps",
        quantity: 20,
        durationDays: 30,
        price: 15.0,
        currency: "USD",
        prefix: "XNET",
        createdBy: "admin",
      });
    }
  },

  async listBatches(): Promise<VoucherBatch[]> {
    return batchesStore.map((b) => {
      const batchCards = cardsStore.filter((c) => c.batchId === b.id);
      const used = batchCards.filter((c) => c.status === "used").length;
      let status: VoucherBatch["status"] = "active";
      if (used >= b.quantity) status = "depleted";
      return {
        ...b,
        totalCount: b.quantity,
        usedCount: used,
        status,
      };
    });
  },

  async getBatchById(batchId: string): Promise<VoucherBatch | null> {
    const b = batchesStore.find((it) => it.id === batchId);
    if (!b) return null;
    const batchCards = cardsStore.filter((c) => c.batchId === b.id);
    const used = batchCards.filter((c) => c.status === "used").length;
    return {
      ...b,
      totalCount: b.quantity,
      usedCount: used,
      status: used >= b.quantity ? "depleted" : "active",
    };
  },

  async getBatchCards(batchId: string, search = "", statusFilter = "all"): Promise<VoucherCard[]> {
    let cards = cardsStore.filter((c) => c.batchId === batchId);
    if (statusFilter && statusFilter !== "all") {
      cards = cards.filter((c) => c.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      cards = cards.filter(
        (c) =>
          c.serialNumber.toLowerCase().includes(q) ||
          c.pinCode.toLowerCase().includes(q) ||
          (c.usedByUsername && c.usedByUsername.toLowerCase().includes(q))
      );
    }
    return cards;
  },

  async createBatch(params: {
    name: string;
    profileId: number;
    profileName: string;
    quantity: number;
    durationDays: number;
    price: number;
    currency?: string;
    prefix?: string;
    createdBy?: string;
  }): Promise<{ batch: VoucherBatch; cards: VoucherCard[] }> {
    const qty = Math.min(1000, Math.max(1, Number(params.quantity) || 10));
    const batchId = `VB-${Date.now().toString().slice(-6)}-${randomBytes(2).toString("hex").toUpperCase()}`;
    const createdAt = new Date().toISOString();

    const batch: VoucherBatch = {
      id: batchId,
      name: params.name || `Batch #${batchId}`,
      profileId: Number(params.profileId) || 1,
      profileName: params.profileName || "Default Plan",
      quantity: qty,
      durationDays: Number(params.durationDays) || 30,
      price: Number(params.price) || 0,
      currency: params.currency || "USD",
      prefix: (params.prefix || "SN").toUpperCase(),
      createdBy: params.createdBy || "system",
      createdAt,
      totalCount: qty,
      usedCount: 0,
      status: "active",
    };

    const newCards: VoucherCard[] = [];
    for (let i = 0; i < qty; i++) {
      newCards.push({
        id: `VC-${Date.now().toString().slice(-6)}-${i + 1}-${randomBytes(2).toString("hex")}`,
        batchId,
        serialNumber: generateSerialNumber(batch.prefix, i),
        pinCode: generatePin(),
        profileId: batch.profileId,
        profileName: batch.profileName,
        durationDays: batch.durationDays,
        price: batch.price,
        currency: batch.currency,
        status: "unused",
        createdAt,
      });
    }

    batchesStore = [batch, ...batchesStore];
    cardsStore = [...newCards, ...cardsStore];

    await persistToRedis();

    return { batch, cards: newCards };
  },

  async redeemVoucher(pinCode: string, username: string): Promise<{ success: boolean; message: string; card?: VoucherCard }> {
    const cleanPin = String(pinCode || "").trim().toUpperCase().replace(/[\s-]/g, "");
    if (!cleanPin) {
      return { success: false, message: "PIN code is required." };
    }
    if (!username || !username.trim()) {
      return { success: false, message: "Subscriber username is required." };
    }

    // Find card matching PIN (ignoring hyphens)
    const card = cardsStore.find(
      (c) => c.pinCode.replace(/-/g, "") === cleanPin
    );

    if (!card) {
      return { success: false, message: "Invalid voucher PIN code. Please check and try again." };
    }

    if (card.status === "used") {
      return {
        success: false,
        message: `Voucher already redeemed by ${card.usedByUsername || "another user"} on ${card.usedAt ? new Date(card.usedAt).toLocaleString() : "record"}.`,
      };
    }

    if (card.status === "revoked") {
      return { success: false, message: "This voucher has been cancelled or revoked." };
    }

    // Apply subscription renewal/activation on database
    try {
      const userRepo = AppDataSource.getRepository(Raduserprofile);
      const targetUser = await userRepo.findOne({ where: { username: username.trim() } });

      if (targetUser) {
        // Calculate new expiration date (extend from current expiry if in future, else from now)
        let baseDate = new Date();
        if (targetUser.expiresAt && new Date(targetUser.expiresAt).getTime() > Date.now()) {
          baseDate = new Date(targetUser.expiresAt);
        }
        baseDate.setDate(baseDate.getDate() + (card.durationDays || 30));

        targetUser.expiresAt = baseDate;
        targetUser.accountStatus = "active";
        if (card.profileId) {
          targetUser.profileId = card.profileId;
        }
        await userRepo.save(targetUser);

        // Invalidate auth cache so subscriber gets immediate network access
        await radiusAuthCacheService.invalidateUserCache(username.trim()).catch((err) => {
          console.warn("[vouchers] cache invalidation failed:", err);
        });
      }
    } catch (dbErr) {
      console.error("Error updating user subscription on voucher redemption:", dbErr);
    }

    // Mark card as used
    card.status = "used";
    card.usedByUsername = username.trim();
    card.usedAt = new Date().toISOString();

    await persistToRedis();

    return {
      success: true,
      message: `Voucher redeemed successfully! Added ${card.durationDays} days of "${card.profileName}" for ${username}.`,
      card,
    };
  },

  async revokeCard(cardId: string): Promise<boolean> {
    const card = cardsStore.find((c) => c.id === cardId);
    if (!card || card.status === "used") return false;
    card.status = "revoked";
    await persistToRedis();
    return true;
  },

  async getMetrics() {
    const totalBatches = batchesStore.length;
    const totalCards = cardsStore.length;
    const usedCards = cardsStore.filter((c) => c.status === "used").length;
    const unusedCards = cardsStore.filter((c) => c.status === "unused").length;
    const totalGeneratedVal = cardsStore.reduce((acc, c) => acc + (c.price || 0), 0);
    const redeemedVal = cardsStore.filter((c) => c.status === "used").reduce((acc, c) => acc + (c.price || 0), 0);
    const redemptionRate = totalCards > 0 ? ((usedCards / totalCards) * 100).toFixed(1) : "0.0";

    return {
      totalBatches,
      totalCards,
      usedCards,
      unusedCards,
      totalGeneratedVal,
      redeemedVal,
      redemptionRate: `${redemptionRate}%`,
    };
  },
};

// Initialize
voucherService.init().catch(console.error);
