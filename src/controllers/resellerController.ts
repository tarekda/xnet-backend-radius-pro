import { Request, Response } from "express";
import { DataSource, EntityManager } from "typeorm";
import { AppDataSource } from "../db/config";
import { Reseller } from "../db/entities/Reseller";
import { ResellerLedgerEntry } from "../db/entities/ResellerLedgerEntry";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { Radcheck } from "../db/entities/Radcheck";
import { UserDetails } from "../db/entities/UserDetails";
import { Radprofile } from "../db/entities/Radprofile";
import { authorizePermissions } from "../middleware/authMiddleware";
import { SystemUsers } from "../db/entities/SystemUsers";
import * as bcrypt from "bcryptjs";
import { creditCompanyWallet, debitCompanyWallet } from "../services/companyWalletService";

function send(res: Response, success: boolean, status: number, message: string, data?: any) {
  res.status(status).json({ success, message, data });
}

async function resellerBalance(resellerId: number, manager: EntityManager | DataSource = AppDataSource): Promise<number> {
  const ledgerRepo = manager.getRepository(ResellerLedgerEntry);
  const credit = await ledgerRepo
    .createQueryBuilder("l")
    .select("COALESCE(SUM(l.amount),0)", "sum")
    .where("l.reseller_id = :rid", { rid: resellerId })
    .andWhere("l.entry_type = 'credit'")
    .getRawOne<{ sum: string }>();
  const debit = await ledgerRepo
    .createQueryBuilder("l")
    .select("COALESCE(SUM(l.amount),0)", "sum")
    .where("l.reseller_id = :rid", { rid: resellerId })
    .andWhere("l.entry_type = 'debit'")
    .getRawOne<{ sum: string }>();
  return Number(credit?.sum || 0) - Number(debit?.sum || 0);
}

async function resellerBalancesById(): Promise<Map<number, number>> {
  const rows = await AppDataSource.getRepository(ResellerLedgerEntry)
    .createQueryBuilder("l")
    .select("l.reseller_id", "resellerId")
    .addSelect(
      "COALESCE(SUM(CASE WHEN l.entry_type = 'credit' THEN l.amount ELSE -l.amount END), 0)",
      "balance"
    )
    .groupBy("l.reseller_id")
    .getRawMany<{ resellerId: string; balance: string }>();
  const map = new Map<number, number>();
  for (const row of rows) {
    map.set(Number(row.resellerId), Number(row.balance || 0));
  }
  return map;
}

function requireResellerContext(req: Request): number {
  const rid = (req.user as any)?.resellerId;
  if (!rid || !Number.isFinite(rid)) {
    throw new Error("Reseller context missing");
  }
  return Number(rid);
}

export const resellerAdminList = [
  authorizePermissions("admin.resellers.manage"),
  async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(Reseller);
    const rows = await repo.find({ order: { id: "DESC" } });
    const balances = await resellerBalancesById();
    send(
      res,
      true,
      200,
      "Resellers fetched",
      rows.map((r) => ({ ...r, balance: balances.get(r.id) ?? 0 }))
    );
  },
];

export const resellerAdminCreate = [
  authorizePermissions("admin.resellers.manage"),
  async (req: Request, res: Response) => {
    const { name, code } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "") return send(res, false, 400, "name is required");
    if (typeof code !== "string" || code.trim() === "") return send(res, false, 400, "code is required");

    const repo = AppDataSource.getRepository(Reseller);
    const exists = await repo.findOne({ where: { code: code.trim() } as any });
    if (exists) return send(res, false, 409, "Reseller code already exists");

    const r = repo.create({ name: name.trim(), code: code.trim(), isActive: true });
    await repo.save(r);
    send(res, true, 201, "Reseller created", r);
  },
];

export const resellerAdminFund = [
  authorizePermissions("admin.resellers.fund"),
  async (req: Request, res: Response) => {
    const resellerId = Number(req.params.id);
    const { amount, currency = "USD", note } = req.body ?? {};
    const amt = Number(amount);
    if (!Number.isFinite(resellerId)) return send(res, false, 400, "Invalid reseller id");
    if (!Number.isFinite(amt) || amt <= 0) return send(res, false, 400, "amount must be > 0");

    try {
      const result = await AppDataSource.transaction(async (manager) => {
        const resellerRepo = manager.getRepository(Reseller);
        const ledgerRepo = manager.getRepository(ResellerLedgerEntry);
        const reseller = await resellerRepo.findOne({ where: { id: resellerId } });
        if (!reseller) {
          throw Object.assign(new Error("Reseller not found"), { status: 404 });
        }

        const refId = `${resellerId}:${Date.now()}`;
        await debitCompanyWallet({
          amount: amt,
          currency: String(currency || "USD"),
          referenceType: "reseller_fund",
          referenceId: refId,
          note: typeof note === "string" && note.trim() ? note : `Fund reseller ${reseller.code}`,
          createdBy: (req.user as any)?.username || "system",
          manager,
        });

        const entry = ledgerRepo.create({
          resellerId,
          amount: amt.toFixed(2),
          currency: String(currency || "USD"),
          entryType: "credit",
          referenceType: "admin_fund",
          referenceId: refId,
          note: typeof note === "string" ? note : null,
          createdBy: (req.user as any)?.id ?? null,
        });
        await ledgerRepo.save(entry);
        const balance = await resellerBalance(resellerId, manager);
        return { entry, balance };
      });
      send(res, true, 201, "Reseller funded", result);
    } catch (e: any) {
      send(res, false, e?.status && Number.isFinite(e.status) ? e.status : 400, e?.message || "Failed to fund reseller");
    }
  },
];

export const resellerAdminDebit = [
  authorizePermissions("admin.resellers.fund"),
  async (req: Request, res: Response) => {
    const resellerId = Number(req.params.id);
    const { amount, currency = "USD", note } = req.body ?? {};
    const amt = Number(amount);
    if (!Number.isFinite(resellerId)) return send(res, false, 400, "Invalid reseller id");
    if (!Number.isFinite(amt) || amt <= 0) return send(res, false, 400, "amount must be > 0");

    try {
      const result = await AppDataSource.transaction(async (manager) => {
        const resellerRepo = manager.getRepository(Reseller);
        const ledgerRepo = manager.getRepository(ResellerLedgerEntry);
        const reseller = await resellerRepo.findOne({ where: { id: resellerId } });
        if (!reseller) {
          throw Object.assign(new Error("Reseller not found"), { status: 404 });
        }
        const balance = await resellerBalance(resellerId, manager);
        if (balance + 1e-9 < amt) {
          throw Object.assign(
            new Error(`Insufficient reseller balance (have ${balance.toFixed(2)}, need ${amt.toFixed(2)})`),
            { status: 400 }
          );
        }
        const refId = `${resellerId}:${Date.now()}`;
        const entry = ledgerRepo.create({
          resellerId,
          amount: amt.toFixed(2),
          currency: String(currency || "USD"),
          entryType: "debit",
          referenceType: "admin_debit",
          referenceId: refId,
          note: typeof note === "string" ? note : null,
          createdBy: (req.user as any)?.id ?? null,
        });
        await ledgerRepo.save(entry);
        await creditCompanyWallet({
          amount: amt,
          currency: String(currency || "USD"),
          referenceType: "reseller_debit",
          referenceId: refId,
          note: typeof note === "string" && note.trim() ? note : `Debit reseller ${reseller.code}`,
          createdBy: (req.user as any)?.username || "system",
          manager,
        });
        const nextBalance = await resellerBalance(resellerId, manager);
        return { entry, balance: nextBalance };
      });
      send(res, true, 201, "Reseller wallet debited", result);
    } catch (e: any) {
      send(res, false, e?.status && Number.isFinite(e.status) ? e.status : 400, e?.message || "Failed to debit reseller");
    }
  },
];

export const resellerAdminLedger = [
  authorizePermissions("admin.resellers.manage"),
  async (req: Request, res: Response) => {
    const resellerId = Number(req.params.id);
    if (!Number.isFinite(resellerId)) return send(res, false, 400, "Invalid reseller id");

    const ledgerRepo = AppDataSource.getRepository(ResellerLedgerEntry);
    const rows = await ledgerRepo.find({ where: { resellerId } as any, order: { createdAt: "DESC" } });

    const balanceRow = await ledgerRepo
      .createQueryBuilder("l")
      .select("COALESCE(SUM(l.amount),0)", "balance")
      .where("l.reseller_id = :rid", { rid: resellerId })
      .andWhere("l.entry_type = 'credit'")
      .getRawOne<{ balance: string }>();

    const debitRow = await ledgerRepo
      .createQueryBuilder("l")
      .select("COALESCE(SUM(l.amount),0)", "debits")
      .where("l.reseller_id = :rid", { rid: resellerId })
      .andWhere("l.entry_type = 'debit'")
      .getRawOne<{ debits: string }>();

    const credits = Number(balanceRow?.balance || 0);
    const debits = Number(debitRow?.debits || 0);
    send(res, true, 200, "Reseller ledger fetched", { entries: rows, balance: credits - debits });
  },
];

function generateTempPassword(): string {
  // Avoid ambiguous characters; keep it short for admin sharing
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export const resellerAdminCreateLogin = [
  authorizePermissions("admin.resellers.manage"),
  async (req: Request, res: Response) => {
    const resellerId = Number(req.params.id);
    const { username, email, password } = req.body ?? {};
    if (!Number.isFinite(resellerId)) return send(res, false, 400, "Invalid reseller id");
    if (typeof username !== "string" || username.trim() === "") return send(res, false, 400, "username is required");
    if (typeof email !== "string" || email.trim() === "") return send(res, false, 400, "email is required");

    const resellerRepo = AppDataSource.getRepository(Reseller);
    const reseller = await resellerRepo.findOne({ where: { id: resellerId } });
    if (!reseller) return send(res, false, 404, "Reseller not found");
    if (!(reseller as any).isActive) return send(res, false, 409, "Reseller is not active");

    const userRepo = AppDataSource.getRepository(SystemUsers);

    const uname = username.trim().toLowerCase();
    const mail = email.trim().toLowerCase();
    const existing = await userRepo.findOne({ where: [{ username: uname }, { email: mail }] as any });
    if (existing) return send(res, false, 409, "Username or email already exists");

    const tempPassword = typeof password === "string" && password.trim().length > 0 ? password : generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);

    const u = userRepo.create({
      username: uname,
      email: mail,
      password: hashed,
      role: "reseller",
      resellerId,
      isActive: true,
      mustChangePassword: true,
      lastLogin: null,
    } as any);
    await userRepo.save(u as any);

    return send(res, true, 201, "Reseller login created", {
      id: (u as any).id,
      username: (u as any).username,
      email: (u as any).email,
      resellerId,
      mustChangePassword: true,
      tempPassword: typeof password === "string" && password.trim().length > 0 ? null : tempPassword,
    });
  },
];

export const resellerMe = [
  authorizePermissions("reseller.portal.access"),
  async (req: Request, res: Response) => {
    try {
      const resellerId = requireResellerContext(req);
      const resellerRepo = AppDataSource.getRepository(Reseller);
      const ledgerRepo = AppDataSource.getRepository(ResellerLedgerEntry);
      const reseller = await resellerRepo.findOne({ where: { id: resellerId } });
      if (!reseller) return send(res, false, 404, "Reseller not found");

      const credit = await ledgerRepo
        .createQueryBuilder("l")
        .select("COALESCE(SUM(l.amount),0)", "sum")
        .where("l.reseller_id = :rid", { rid: resellerId })
        .andWhere("l.entry_type = 'credit'")
        .getRawOne<{ sum: string }>();
      const debit = await ledgerRepo
        .createQueryBuilder("l")
        .select("COALESCE(SUM(l.amount),0)", "sum")
        .where("l.reseller_id = :rid", { rid: resellerId })
        .andWhere("l.entry_type = 'debit'")
        .getRawOne<{ sum: string }>();

      const balance = Number(credit?.sum || 0) - Number(debit?.sum || 0);
      send(res, true, 200, "Reseller profile", { reseller, balance });
    } catch (e: any) {
      send(res, false, 403, e?.message || "Forbidden");
    }
  },
];

export const resellerUsersList = [
  authorizePermissions("reseller.users.view"),
  async (req: Request, res: Response) => {
    try {
      const resellerId = requireResellerContext(req);
      const repo = AppDataSource.getRepository(Raduserprofile);
      const users = await repo.find({
        where: { ownerResellerId: resellerId } as any,
        relations: ["profile"],
        order: { id: "DESC" },
        take: 500,
      });
      send(res, true, 200, "Reseller users fetched", users);
    } catch (e: any) {
      send(res, false, 403, e?.message || "Forbidden");
    }
  },
];

export const resellerUsersCreate = [
  authorizePermissions("reseller.users.manage"),
  async (req: Request, res: Response) => {
    try {
      const resellerId = requireResellerContext(req);
      const { username, password, profileId, fullName, email, phoneNumber, address, expiresAt, expiryFramedIp } = req.body ?? {};
      if (typeof username !== "string" || username.trim() === "") return send(res, false, 400, "username is required");
      if (typeof password !== "string" || password.trim() === "") return send(res, false, 400, "password is required");
      const pid = Number(profileId);
      if (!Number.isFinite(pid)) return send(res, false, 400, "profileId is required");

      // Basic pricing: deduct profile.price (if exists) from reseller balance before creation
      const profileRepo = AppDataSource.getRepository(Radprofile);
      const prof = await profileRepo.findOne({ where: { id: pid } });
      if (!prof) return send(res, false, 404, "Profile not found");
      const price = Number((prof as any).price || 0);

      const ledgerRepo = AppDataSource.getRepository(ResellerLedgerEntry);
      const credit = await ledgerRepo
        .createQueryBuilder("l")
        .select("COALESCE(SUM(l.amount),0)", "sum")
        .where("l.reseller_id = :rid", { rid: resellerId })
        .andWhere("l.entry_type = 'credit'")
        .getRawOne<{ sum: string }>();
      const debit = await ledgerRepo
        .createQueryBuilder("l")
        .select("COALESCE(SUM(l.amount),0)", "sum")
        .where("l.reseller_id = :rid", { rid: resellerId })
        .andWhere("l.entry_type = 'debit'")
        .getRawOne<{ sum: string }>();
      const balance = Number(credit?.sum || 0) - Number(debit?.sum || 0);
      if (price > 0 && balance < price) return send(res, false, 402, "Insufficient reseller balance");

      const userRepo = AppDataSource.getRepository(Raduserprofile);
      const existing = await userRepo.findOne({ where: { username: username.trim() } as any });
      if (existing) return send(res, false, 409, "Username already exists");

      const radcheckRepo = AppDataSource.getRepository(Radcheck);
      const existingPass = await radcheckRepo.findOne({ where: { username: username.trim(), attribute: "Cleartext-Password" } as any });
      if (existingPass) return send(res, false, 409, "Username already exists");

      // Create user profile
      const user = userRepo.create({
        username: username.trim(),
        profileId: pid,
        isFallback: false,
        isMonthlyExceeded: false,
        quotaResetDay: new Date().getDate(),
        accountStatus: "active",
        ownerResellerId: resellerId,
        ...(typeof expiresAt === "string" &&
        expiresAt.trim() &&
        !Number.isNaN(new Date(expiresAt).getTime()) && { expiresAt: new Date(expiresAt) }),
        ...(typeof expiryFramedIp === "string" && expiryFramedIp.trim() && {
          expiryFramedIp: expiryFramedIp.trim().slice(0, 45),
        }),
      } as any);
      const createdUser = await userRepo.save(user as any);

      // Create password
      const rc = radcheckRepo.create({
        username: username.trim(),
        attribute: "Cleartext-Password",
        op: ":=",
        value: password,
      } as any);
      await radcheckRepo.save(rc);

      // Create details
      const detailsRepo = AppDataSource.getRepository(UserDetails);
      const details = detailsRepo.create({
        username: username.trim(),
        fullName: typeof fullName === "string" ? fullName : null,
        email: typeof email === "string" ? email : null,
        phoneNumber: typeof phoneNumber === "string" ? phoneNumber : null,
        address: typeof address === "string" ? address : null,
      } as any);
      await detailsRepo.save(details);

      // Debit reseller for price (if any)
      if (price > 0) {
        const entry = ledgerRepo.create({
          resellerId,
          amount: price.toFixed(2),
          currency: "USD",
          entryType: "debit",
          referenceType: "user_create",
          referenceId: String((createdUser as any).id),
          note: `Created user ${username.trim()} (profile ${pid})`,
          createdBy: (req.user as any)?.id ?? null,
        });
        await ledgerRepo.save(entry);
      }

      send(res, true, 201, "User created", { userId: (createdUser as any).id });
    } catch (e: any) {
      send(res, false, 400, e?.message || "Failed");
    }
  },
];

