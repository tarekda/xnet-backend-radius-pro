import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { Radcheck } from "../db/entities/Radcheck";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { UserDetails } from "../db/entities/UserDetails";
import { Radusagestats } from "../db/entities/Radusagestats";
import { Radprofile } from "../db/entities/Radprofile";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { Radacct } from "../db/entities/Radacct";
import { SubscriberRefreshTokens } from "../db/entities/SubscriberRefreshTokens";
import { getJwtSecret, getRefreshTokenSecret } from "../config/requireSecrets";
import { createPaymentIntent, getPaymentProviderStatus } from "../services/paymentGatewayService";
import {
  createWhishPaymentClaim,
  listClaimsForInvoice,
} from "../services/whishPaymentClaimService";
import { getWalletBalance, payInvoiceFromWallet } from "../services/subscriberWalletService";

const jwtSecret = getJwtSecret();
const refreshTokenSecret = getRefreshTokenSecret();
const ACCESS_EXPIRES = process.env.SUBSCRIBER_ACCESS_EXPIRES_IN || "1h";
const REFRESH_EXPIRES = process.env.SUBSCRIBER_REFRESH_EXPIRES_IN || "30d";

async function verifyRadiusPassword(username: string, password: string): Promise<boolean> {
  const row = await AppDataSource.getRepository(Radcheck).findOne({
    where: { username: Equal(username), attribute: Equal("Cleartext-Password") },
  });
  if (!row) return false;
  return row.value === password;
}

export const subscriberLogin = async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ success: false, message: "username and password are required" });
    return;
  }
  const lookup = username.trim();
  if (!(await verifyRadiusPassword(lookup, password))) {
    res.status(401).json({ success: false, message: "Invalid credentials" });
    return;
  }

  const accessToken = jwt.sign({ type: "subscriber", username: lookup }, jwtSecret, {
    expiresIn: ACCESS_EXPIRES as jwt.SignOptions["expiresIn"],
  });
  const refreshToken = jwt.sign({ type: "subscriber", username: lookup }, refreshTokenSecret, {
    expiresIn: REFRESH_EXPIRES as jwt.SignOptions["expiresIn"],
  });
  const repo = AppDataSource.getRepository(SubscriberRefreshTokens);
  await repo.save(repo.create({ token: refreshToken, username: lookup }));

  res.status(200).json({
    success: true,
    data: { accessToken, refreshToken, username: lookup },
  });
};

export const subscriberRefresh = async (req: Request, res: Response) => {
  const token = (req.body?.refreshToken ?? req.body?.token) as string | undefined;
  if (!token) {
    res.status(401).json({ success: false, message: "refreshToken is required" });
    return;
  }
  const repo = AppDataSource.getRepository(SubscriberRefreshTokens);
  const stored = await repo.findOne({ where: { token: Equal(token) } });
  if (!stored || stored.revokedAt) {
    res.status(403).json({ success: false, message: "Invalid refresh token" });
    return;
  }
  try {
    const decoded = jwt.verify(token, refreshTokenSecret) as any;
    if (decoded?.type !== "subscriber") {
      res.status(403).json({ success: false, message: "Invalid refresh token" });
      return;
    }
    const accessToken = jwt.sign(
      { type: "subscriber", username: decoded.username },
      jwtSecret,
      { expiresIn: ACCESS_EXPIRES as jwt.SignOptions["expiresIn"] }
    );
    res.status(200).json({ success: true, data: { accessToken } });
  } catch {
    res.status(403).json({ success: false, message: "Invalid refresh token" });
  }
};

export const subscriberLogout = async (req: Request, res: Response) => {
  const token = (req.body?.refreshToken ?? req.body?.token) as string | undefined;
  if (token) {
    const repo = AppDataSource.getRepository(SubscriberRefreshTokens);
    const stored = await repo.findOne({ where: { token: Equal(token) } });
    if (stored) {
      stored.revokedAt = new Date();
      await repo.save(stored);
    }
  }
  res.status(200).json({ success: true, message: "Logged out" });
};

export const subscriberMe = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const profile = await AppDataSource.getRepository(Raduserprofile).findOne({
    where: { username: Equal(username) },
  });
  const details = await AppDataSource.getRepository(UserDetails).findOne({
    where: { username: Equal(username) },
  });
  let planName: string | null = null;
  if (profile?.profileId) {
    const plan = await AppDataSource.getRepository(Radprofile).findOne({
      where: { id: Equal(profile.profileId) },
    });
    planName = (plan as any)?.profileName ?? (plan as any)?.profile_name ?? null;
  }
  const walletBalance = await getWalletBalance(username);
  const now = Date.now();
  const expired =
    String(profile?.accountStatus || "").toLowerCase() === "expired" ||
    (profile?.expiresAt != null && new Date(profile.expiresAt).getTime() < now);

  res.status(200).json({
    success: true,
    data: {
      username,
      fullName: details?.fullName ?? null,
      email: details?.email ?? null,
      phone: details?.phoneNumber ?? null,
      accountStatus: profile?.accountStatus ?? null,
      expiresAt: profile?.expiresAt ?? null,
      planName,
      walletBalance,
      isExpired: expired,
    },
  });
};

export const subscriberUsage = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const profile = await AppDataSource.getRepository(Raduserprofile).findOne({
    where: { username: Equal(username) },
  });
  const plan = profile?.profileId
    ? await AppDataSource.getRepository(Radprofile).findOne({ where: { id: Equal(profile.profileId) } })
    : null;

  const today = new Date();
  const ymd = today.toISOString().slice(0, 10);
  const daily = await AppDataSource.getRepository(Radusagestats)
    .createQueryBuilder("r")
    .select("COALESCE(SUM(r.dataUsage), 0)", "bytes")
    .where("r.username = :username", { username })
    .andWhere("r.day = :day", { day: ymd })
    .getRawOne<{ bytes: string }>();

  const monthStart = `${ymd.slice(0, 8)}01`;
  const monthly = await AppDataSource.getRepository(Radusagestats)
    .createQueryBuilder("r")
    .select("COALESCE(SUM(r.dataUsage), 0)", "bytes")
    .where("r.username = :username", { username })
    .andWhere("r.day >= :start", { start: monthStart })
    .getRawOne<{ bytes: string }>();

  const dailyUsed = Number(daily?.bytes ?? 0);
  const monthlyUsed = Number(monthly?.bytes ?? 0);
  const dailyQuota = Number(plan?.dailyQuota ?? 0);
  const monthlyQuota = Number(plan?.monthlyQuota ?? 0);

  res.status(200).json({
    success: true,
    data: {
      dailyUsed,
      dailyQuota,
      dailyRemaining: Math.max(0, dailyQuota - dailyUsed),
      monthlyUsed,
      monthlyQuota,
      monthlyRemaining: Math.max(0, monthlyQuota - monthlyUsed),
      isFallback: Boolean(profile?.isFallback),
    },
  });
};

export const subscriberSessions = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
  const repo = AppDataSource.getRepository(Radacct);
  const [rows, total] = await repo.findAndCount({
    where: { username: Equal(username) },
    order: { acctstarttime: "DESC" } as any,
    skip: (page - 1) * limit,
    take: limit,
  });
  res.status(200).json({
    success: true,
    data: {
      sessions: rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    },
  });
};

export const subscriberInvoices = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const invoices = await AppDataSource.getRepository(ExternalInvoice).find({
    where: { username: Equal(username) },
    order: { billingMonth: "DESC" } as any,
    take: 100,
  });
  res.status(200).json({ success: true, data: invoices });
};

export const subscriberInvoiceDetail = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const id = parseInt(String(req.params.id), 10);
  const invoice = await AppDataSource.getRepository(ExternalInvoice).findOne({
    where: { id: Equal(id), username: Equal(username) },
  });
  if (!invoice) {
    res.status(404).json({ success: false, message: "Invoice not found" });
    return;
  }
  res.status(200).json({ success: true, data: invoice });
};

export const subscriberPaymentProvider = async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: getPaymentProviderStatus() });
};

export const subscriberPaymentIntent = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const id = parseInt(String(req.params.id), 10);
  const invoice = await AppDataSource.getRepository(ExternalInvoice).findOne({
    where: { id: Equal(id), username: Equal(username) },
  });
  if (!invoice) {
    res.status(404).json({ success: false, message: "Invoice not found" });
    return;
  }
  if (invoice.status === "paid") {
    res.status(400).json({ success: false, message: "Invoice already paid" });
    return;
  }
  const intent = await createPaymentIntent(invoice.id!);
  res.status(200).json({
    success: true,
    data: {
      ...intent,
      provider: intent.gatewayProvider,
      payHint:
        intent.gatewayProvider === "whish"
          ? "Open the Whish payment link and approve in the Whish Money app (wallet or card)."
          : "Payment link ready. Real Whish links appear after WHISH_WEBSITE and WHISH_SECRET are configured.",
    },
  });
};

/** Subscriber reports a Whish QR payment with transaction/reference number. */
export const subscriberReportWhishPayment = async (req: Request, res: Response) => {
  try {
    const username = req.subscriber!.username;
    const id = parseInt(String(req.params.id), 10);
    const amount = Number(req.body?.amount);
    const whishReference = String(req.body?.whishReference || req.body?.reference || "").trim();
    const note = req.body?.note ? String(req.body.note) : null;
    const currency = req.body?.currency ? String(req.body.currency) : undefined;

    const claim = await createWhishPaymentClaim({
      externalInvoiceId: id,
      username,
      amount,
      currency,
      whishReference,
      note,
    });
    res.status(201).json({
      success: true,
      message: "Payment reported. Staff will confirm after checking Whish.",
      data: claim,
    });
  } catch (e: any) {
    const status = e?.status && Number.isFinite(e.status) ? e.status : 400;
    res.status(status).json({ success: false, message: e?.message || "Failed to report payment" });
  }
};

export const subscriberInvoiceClaims = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const id = parseInt(String(req.params.id), 10);
  const invoice = await AppDataSource.getRepository(ExternalInvoice).findOne({
    where: { id: Equal(id), username: Equal(username) },
  });
  if (!invoice) {
    res.status(404).json({ success: false, message: "Invoice not found" });
    return;
  }
  const claims = await listClaimsForInvoice(id);
  res.status(200).json({ success: true, data: claims });
};

export const subscriberWallet = async (req: Request, res: Response) => {
  const username = req.subscriber!.username;
  const balance = await getWalletBalance(username);
  res.status(200).json({ success: true, data: { username, balance, currency: "USD" } });
};

/** Pay unpaid invoice from wallet balance; renews account if expired. */
export const subscriberPayFromWallet = async (req: Request, res: Response) => {
  try {
    const username = req.subscriber!.username;
    const id = parseInt(String(req.params.id), 10);
    const result = await payInvoiceFromWallet({
      externalInvoiceId: id,
      username,
      actorUsername: username,
      renewMonths: req.body?.months != null ? Number(req.body.months) : 1,
    });
    res.status(200).json({
      success: true,
      message: result.alreadyPaid
        ? "Invoice already paid"
        : result.renewed
          ? "Paid from wallet and account renewed"
          : "Paid from wallet",
      data: result,
    });
  } catch (e: any) {
    const status = e?.status && Number.isFinite(e.status) ? e.status : 400;
    res.status(status).json({ success: false, message: e?.message || "Wallet payment failed" });
  }
};
