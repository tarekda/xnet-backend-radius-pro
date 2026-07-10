import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import * as bcrypt from "bcryptjs";
import { Equal } from "typeorm";
import { AppDataSource } from "../db/config";
import { SystemUsers } from "../db/entities/SystemUsers";
import { RefreshTokens } from "../db/entities/RefreshTokens";
import { getEffectivePermissionsForUser } from "../access/permissionService";
import { getJwtSecret, getRefreshTokenSecret } from "../config/requireSecrets";
import {
  consumeBackupCode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  mfaRequiredForRole,
  totpKeyUri,
  verifyTotpCode,
} from "../services/mfaService";

const jwtSecret = getJwtSecret();
const refreshTokenSecret = getRefreshTokenSecret();
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || "30d";
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || "1d";
const MFA_TOKEN_EXPIRES_IN = "5m";

type MfaTokenPayload = { userId: number; purpose: "mfa" };

async function buildSafeUser(user: SystemUsers) {
  const permissions = await getEffectivePermissionsForUser({
    userId: user.id,
    username: user.username,
    roleKey: user.role ?? undefined,
  });
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    resellerId: user.resellerId ?? null,
    mustChangePassword: Boolean(user.mustChangePassword),
    mfaEnabled: Boolean(user.mfaEnabled),
    mfaRequired: mfaRequiredForRole(user.role) && !user.mfaEnabled,
    permissions,
  };
}

export async function issueStaffTokens(user: SystemUsers) {
  const refreshTokenRepository = AppDataSource.getRepository(RefreshTokens);
  const accessToken = jwt.sign(
    { id: user.id, username: user.username, role: user.role, resellerId: user.resellerId ?? null },
    jwtSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN as jwt.SignOptions["expiresIn"] }
  );
  const refreshToken = jwt.sign(
    { id: user.id, username: user.username, role: user.role, resellerId: user.resellerId ?? null },
    refreshTokenSecret,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN as jwt.SignOptions["expiresIn"] }
  );
  await refreshTokenRepository.save(refreshTokenRepository.create({ token: refreshToken, user }));
  const safeUser = await buildSafeUser(user);
  return { user: safeUser, accessToken, refreshToken };
}

function signMfaToken(userId: number): string {
  const payload: MfaTokenPayload = { userId, purpose: "mfa" };
  return jwt.sign(payload, jwtSecret, {
    expiresIn: MFA_TOKEN_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

function verifyMfaToken(token: string): number | null {
  try {
    const decoded = jwt.verify(token, jwtSecret) as MfaTokenPayload;
    if (decoded?.purpose !== "mfa" || !decoded.userId) return null;
    return decoded.userId;
  } catch {
    return null;
  }
}

export async function completeLoginAfterPassword(user: SystemUsers, res: Response, envelope: "web" | "mobile") {
  if (user.mfaEnabled && user.totpSecretEncrypted) {
    const mfaToken = signMfaToken(user.id);
    if (envelope === "mobile") {
      res.status(200).json({ mfaRequired: true, mfaToken });
      return;
    }
    res.status(200).json({
      success: true,
      message: "MFA required",
      data: { mfaRequired: true, mfaToken },
    });
    return;
  }

  const session = await issueStaffTokens(user);
  if (envelope === "mobile") {
    res.status(200).json(session);
    return;
  }
  res.status(200).json({ success: true, message: "Login successful", data: session });
}

export const verifyMfaLogin = async (req: Request, res: Response) => {
  const { mfaToken, code } = req.body ?? {};
  if (typeof mfaToken !== "string" || typeof code !== "string") {
    res.status(400).json({ success: false, message: "mfaToken and code are required" });
    return;
  }
  const userId = verifyMfaToken(mfaToken);
  if (!userId) {
    res.status(401).json({ success: false, message: "Invalid or expired MFA token" });
    return;
  }

  const userRepo = AppDataSource.getRepository(SystemUsers);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user?.mfaEnabled || !user.totpSecretEncrypted) {
    res.status(400).json({ success: false, message: "MFA is not enabled for this user" });
    return;
  }

  let ok = false;
  try {
    const secret = decryptTotpSecret(user.totpSecretEncrypted);
    ok = verifyTotpCode(secret, code);
  } catch {
    ok = false;
  }

  if (!ok) {
    const consumed = consumeBackupCode(user.mfaBackupCodesHash, code);
    if (consumed.ok) {
      user.mfaBackupCodesHash = consumed.remainingJson;
      await userRepo.save(user);
      ok = true;
    }
  }

  if (!ok) {
    res.status(401).json({ success: false, message: "Invalid MFA code" });
    return;
  }

  const session = await issueStaffTokens(user);
  res.status(200).json({ success: true, message: "Login successful", data: session });
};

export const mobileVerifyMfaLogin = async (req: Request, res: Response) => {
  const { mfaToken, code } = req.body ?? {};
  if (typeof mfaToken !== "string" || typeof code !== "string") {
    res.status(400).json({ message: "mfaToken and code are required" });
    return;
  }
  const userId = verifyMfaToken(mfaToken);
  if (!userId) {
    res.status(401).json({ message: "Invalid or expired MFA token" });
    return;
  }
  const userRepo = AppDataSource.getRepository(SystemUsers);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user?.mfaEnabled || !user.totpSecretEncrypted) {
    res.status(400).json({ message: "MFA is not enabled for this user" });
    return;
  }
  let ok = false;
  try {
    ok = verifyTotpCode(decryptTotpSecret(user.totpSecretEncrypted), code);
  } catch {
    ok = false;
  }
  if (!ok) {
    const consumed = consumeBackupCode(user.mfaBackupCodesHash, code);
    if (consumed.ok) {
      user.mfaBackupCodesHash = consumed.remainingJson;
      await userRepo.save(user);
      ok = true;
    }
  }
  if (!ok) {
    res.status(401).json({ message: "Invalid MFA code" });
    return;
  }
  res.status(200).json(await issueStaffTokens(user));
};

export const mfaSetup = async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id as number | undefined;
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  const userRepo = AppDataSource.getRepository(SystemUsers);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const secret = generateTotpSecret();
  user.totpSecretEncrypted = encryptTotpSecret(secret);
  // Not enabled until confirm
  user.mfaEnabled = false;
  await userRepo.save(user);
  res.status(200).json({
    success: true,
    data: {
      secret,
      otpauthUrl: totpKeyUri(user.username, secret),
    },
  });
};

export const mfaConfirm = async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id as number | undefined;
  const { code } = req.body ?? {};
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  if (typeof code !== "string") {
    res.status(400).json({ success: false, message: "code is required" });
    return;
  }
  const userRepo = AppDataSource.getRepository(SystemUsers);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user?.totpSecretEncrypted) {
    res.status(400).json({ success: false, message: "Call /mfa/setup first" });
    return;
  }
  let secret: string;
  try {
    secret = decryptTotpSecret(user.totpSecretEncrypted);
  } catch {
    res.status(400).json({ success: false, message: "Invalid stored secret" });
    return;
  }
  if (!verifyTotpCode(secret, code)) {
    res.status(401).json({ success: false, message: "Invalid MFA code" });
    return;
  }
  const backupCodes = generateBackupCodes();
  user.mfaEnabled = true;
  user.mfaEnrolledAt = new Date();
  user.mfaBackupCodesHash = hashBackupCodes(backupCodes);
  await userRepo.save(user);
  res.status(200).json({
    success: true,
    message: "MFA enabled",
    data: { backupCodes },
  });
};

export const mfaDisable = async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id as number | undefined;
  const { password, code } = req.body ?? {};
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  if (typeof password !== "string" || typeof code !== "string") {
    res.status(400).json({ success: false, message: "password and code are required" });
    return;
  }
  const userRepo = AppDataSource.getRepository(SystemUsers);
  const user = await userRepo.findOne({ where: { id: userId } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(401).json({ success: false, message: "Invalid credentials" });
    return;
  }
  if (user.mfaEnabled && user.totpSecretEncrypted) {
    try {
      if (!verifyTotpCode(decryptTotpSecret(user.totpSecretEncrypted), code)) {
        res.status(401).json({ success: false, message: "Invalid MFA code" });
        return;
      }
    } catch {
      res.status(401).json({ success: false, message: "Invalid MFA code" });
      return;
    }
  }
  user.mfaEnabled = false;
  user.totpSecretEncrypted = null;
  user.mfaEnrolledAt = null;
  user.mfaBackupCodesHash = null;
  await userRepo.save(user);
  res.status(200).json({ success: true, message: "MFA disabled" });
};

export const mfaStatus = async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id as number | undefined;
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }
  const user = await AppDataSource.getRepository(SystemUsers).findOne({ where: { id: Equal(userId) } });
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  res.status(200).json({
    success: true,
    data: {
      mfaEnabled: Boolean(user.mfaEnabled),
      mfaRequired: mfaRequiredForRole(user.role) && !user.mfaEnabled,
      enrolledAt: user.mfaEnrolledAt,
    },
  });
};
