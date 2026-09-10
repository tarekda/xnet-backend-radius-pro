import {
  getTopupPlans,
  getSubscriberActiveTopupBytes,
  getSubscriberWalletBalance,
  purchaseTopupPack,
  DEFAULT_TOPUP_PLANS,
} from "../topupService";
import { AppDataSource } from "../../db/config";
import { TopupPlan } from "../../db/entities/TopupPlan";
import { SubscriberTopup } from "../../db/entities/SubscriberTopup";
import { Raduserprofile } from "../../db/entities/Raduserprofile";
import { SubscriberWalletEntry } from "../../db/entities/SubscriberWalletEntry";
import { ExternalInvoice } from "../../db/entities/ExternalInvoice";
import * as invoiceService from "../invoiceService";
import * as subscriberReactivationService from "../subscriberReactivationService";

jest.mock("../../db/config", () => ({
  AppDataSource: {
    query: jest.fn(),
    getRepository: jest.fn(),
  },
}));

jest.mock("../invoiceService", () => ({
  createExternalInvoiceDebit: jest.fn(),
}));

jest.mock("../subscriberReactivationService", () => ({
  restoreSubscriberLine: jest.fn(),
}));

describe("topupService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getTopupPlans", () => {
    it("returns formatted active top-up plans sorted by order", async () => {
      (AppDataSource.query as jest.Mock).mockResolvedValue([{ cnt: 4 }]);
      const mockFind = jest.fn().mockResolvedValue([
        {
          id: 1,
          name: "Turbo Boost 20GB",
          extraBytes: (BigInt(20) * BigInt(1024 ** 3)).toString(),
          price: "3.00",
          currency: "USD",
          isActive: true,
          sortOrder: 1,
        },
        {
          id: 2,
          name: "Turbo Boost 50GB",
          extraBytes: (BigInt(50) * BigInt(1024 ** 3)).toString(),
          price: "6.00",
          currency: "USD",
          isActive: true,
          sortOrder: 2,
        },
      ]);

      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === TopupPlan) return { find: mockFind };
        return {};
      });

      const plans = await getTopupPlans();
      expect(plans).toHaveLength(2);
      expect(plans[0].gb).toBe(20);
      expect(plans[0].formattedPrice).toBe("$3.00");
      expect(plans[0].formattedQuota).toBe("20 GB");
      expect(plans[1].gb).toBe(50);
      expect(plans[1].formattedPrice).toBe("$6.00");
    });
  });

  describe("getSubscriberActiveTopupBytes", () => {
    it("sums active top-up bytes for subscriber in the current billing month", async () => {
      const extraBytesExpected = BigInt(50) * BigInt(1024 ** 3);
      (AppDataSource.query as jest.Mock).mockResolvedValue([
        { total_extra: extraBytesExpected.toString() },
      ]);

      const total = await getSubscriberActiveTopupBytes("testuser", "2026-09");
      expect(total).toBe(extraBytesExpected);
    });

    it("returns 0 if subscriber has no active top-ups or query fails", async () => {
      (AppDataSource.query as jest.Mock).mockRejectedValue(new Error("DB error"));
      const total = await getSubscriberActiveTopupBytes("nonexistent");
      expect(total).toBe(BigInt(0));
    });
  });

  describe("getSubscriberWalletBalance", () => {
    it("calculates net balance from credits and debits", async () => {
      const mockFind = jest.fn().mockResolvedValue([
        { amount: "20.00", entryType: "credit" },
        { amount: "5.00", entryType: "debit" },
        { amount: "10.00", entryType: "credit" },
      ]);

      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === SubscriberWalletEntry) return { find: mockFind };
        return {};
      });

      const balance = await getSubscriberWalletBalance("testuser");
      expect(balance).toBe(25.0);
    });
  });

  describe("purchaseTopupPack", () => {
    it("fails if username is missing", async () => {
      await expect(
        purchaseTopupPack({ username: "", planId: 1 })
      ).rejects.toThrow("Subscriber username is required");
    });

    it("fails if plan is not found", async () => {
      (AppDataSource.query as jest.Mock).mockResolvedValue([{ cnt: 4 }]);
      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === TopupPlan) return { findOne: jest.fn().mockResolvedValue(null) };
        return {};
      });

      await expect(
        purchaseTopupPack({ username: "testuser", planId: 999 })
      ).rejects.toThrow("Top-up plan #999 not found");
    });

    it("purchases with wallet debit when balance is sufficient", async () => {
      (AppDataSource.query as jest.Mock).mockResolvedValue([{ cnt: 4 }]);
      const mockPlan = {
        id: 1,
        name: "Turbo Boost 20GB",
        extraBytes: (BigInt(20) * BigInt(1024 ** 3)).toString(),
        price: "3.00",
        currency: "USD",
        isActive: true,
      };

      const mockWalletSave = jest.fn().mockResolvedValue({});
      const mockTopupSave = jest.fn().mockImplementation((item) => ({ ...item, id: "1001" }));

      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === TopupPlan) return { findOne: jest.fn().mockResolvedValue(mockPlan) };
        if (entity === SubscriberWalletEntry) {
          return {
            find: jest.fn().mockResolvedValue([{ amount: "15.00", entryType: "credit" }]),
            create: jest.fn().mockImplementation((data) => data),
            save: mockWalletSave,
          };
        }
        if (entity === SubscriberTopup) {
          return {
            create: jest.fn().mockImplementation((data) => data),
            save: mockTopupSave,
          };
        }
        if (entity === Raduserprofile) {
          return {
            findOne: jest.fn().mockResolvedValue({ username: "testuser", isMonthlyExceeded: false }),
          };
        }
        return {};
      });

      const res = await purchaseTopupPack({
        username: "testuser",
        planId: 1,
        paymentMethod: "wallet",
      });

      expect(res.success).toBe(true);
      expect(mockWalletSave).toHaveBeenCalled();
      expect(mockTopupSave).toHaveBeenCalled();
      expect(res.topup.planName).toBe("Turbo Boost 20GB");
    });

    it("fails with wallet payment if balance is insufficient", async () => {
      (AppDataSource.query as jest.Mock).mockResolvedValue([{ cnt: 4 }]);
      const mockPlan = {
        id: 2,
        name: "Turbo Boost 50GB",
        extraBytes: (BigInt(50) * BigInt(1024 ** 3)).toString(),
        price: "6.00",
        currency: "USD",
        isActive: true,
      };

      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === TopupPlan) return { findOne: jest.fn().mockResolvedValue(mockPlan) };
        if (entity === SubscriberWalletEntry) {
          return {
            find: jest.fn().mockResolvedValue([{ amount: "2.00", entryType: "credit" }]),
          };
        }
        return {};
      });

      await expect(
        purchaseTopupPack({
          username: "testuser",
          planId: 2,
          paymentMethod: "wallet",
        })
      ).rejects.toThrow("Insufficient wallet balance");
    });

    it("automatically unthrottles and restores line if user was monthly exceeded", async () => {
      (AppDataSource.query as jest.Mock).mockResolvedValue([{ cnt: 4 }]);
      const mockPlan = {
        id: 1,
        name: "Turbo Boost 20GB",
        extraBytes: (BigInt(20) * BigInt(1024 ** 3)).toString(),
        price: "3.00",
        currency: "USD",
        isActive: true,
      };

      const mockUpdate = jest.fn().mockResolvedValue({});
      (subscriberReactivationService.restoreSubscriberLine as jest.Mock).mockResolvedValue({
        ok: true,
        restored: true,
        username: "throttled_user",
      });

      (invoiceService.createExternalInvoiceDebit as jest.Mock).mockResolvedValue({ id: 555 });

      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === TopupPlan) return { findOne: jest.fn().mockResolvedValue(mockPlan) };
        if (entity === ExternalInvoice) return { findOne: jest.fn().mockResolvedValue({ provider: "XNet" }) };
        if (entity === SubscriberTopup) {
          return {
            create: jest.fn().mockImplementation((d) => d),
            save: jest.fn().mockImplementation((d) => ({ ...d, id: "2001" })),
          };
        }
        if (entity === Raduserprofile) {
          return {
            findOne: jest.fn().mockResolvedValue({
              username: "throttled_user",
              isMonthlyExceeded: true,
            }),
            update: mockUpdate,
          };
        }
        return {};
      });

      const res = await purchaseTopupPack({
        username: "throttled_user",
        planId: 1,
        paymentMethod: "invoice_debit",
      });

      expect(res.success).toBe(true);
      expect(res.unthrottled).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(
        { username: "throttled_user" },
        { isMonthlyExceeded: false, isFallback: false }
      );
      expect(subscriberReactivationService.restoreSubscriberLine).toHaveBeenCalledWith(
        "throttled_user",
        expect.objectContaining({ force: true, trigger: "quota_restore" })
      );
    });
  });
});
