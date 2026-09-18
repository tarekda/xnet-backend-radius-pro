import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '../db/config';
import { SystemUsers } from '../db/entities/SystemUsers';
import { getEffectivePermissionsForUser } from '../access/permissionService';
import { getJwtSecret } from '../config/requireSecrets';
import { mfaRequiredForRole } from '../services/mfaService';
import { isMfaEnrollmentAllowedPath } from './mfaEnrollment';

import crypto from 'crypto';

const jwtSecret = getJwtSecret();

/**
 * Computes a lightweight client session fingerprint from User-Agent.
 * Used to detect token theft or hijacked bearer credentials.
 */
export function computeClientFingerprint(req: Request): string {
  const ua = String(req.headers['user-agent'] || 'unknown').slice(0, 128);
  return crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16);
}

export const authenticateToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.sendStatus(401);
    return;
  }

  try {
    const decoded: any = jwt.verify(token, jwtSecret);

    // Verify session client fingerprint if present
    if (decoded?.fingerprint) {
      const currentFp = computeClientFingerprint(req);
      if (decoded.fingerprint !== currentFp) {
        const strict = String(process.env.STRICT_SESSION_FINGERPRINT || "false").toLowerCase() === "true";
        if (strict) {
          res.status(401).json({
            success: false,
            code: "SESSION_FINGERPRINT_MISMATCH",
            message: "Session validation failed: client fingerprint mismatch.",
          });
          return;
        }
      }
    }
    let role = decoded?.role as SystemUsers['role'] | undefined;
    let id = decoded?.id as number | undefined;
    let resellerId = decoded?.resellerId as number | null | undefined;

    // Backward compatibility: older tokens may not have role. Fetch from DB.
    if ((!role || typeof resellerId === 'undefined') && decoded?.username) {
      try {
        const userRepo = AppDataSource.getRepository(SystemUsers);
        const dbUser = await userRepo.findOne({ where: { username: decoded.username } });
        role = dbUser?.role ?? undefined;
        id = dbUser?.id ?? id;
        resellerId = dbUser?.resellerId ?? null;
      } catch (e) {
        // ignore DB errors here; will fall back to undefined role
      }
    }

    req.user = { id, username: decoded?.username, role, resellerId } as any;

    if (mfaRequiredForRole(role)) {
      if (!id) {
        res.status(403).json({
          success: false,
          code: "MFA_ENROLLMENT_REQUIRED",
          message: "MFA enrollment required before using the API",
        });
        return;
      }
      try {
        const userRepo = AppDataSource.getRepository(SystemUsers);
        const dbUser = await userRepo.findOne({
          where: { id },
          select: ["id", "mfaEnabled"],
        });
        if (!dbUser?.mfaEnabled) {
          const url = String(req.originalUrl || `${req.baseUrl || ""}${req.path || ""}`);
          if (!isMfaEnrollmentAllowedPath(req.method, url)) {
            res.status(403).json({
              success: false,
              code: "MFA_ENROLLMENT_REQUIRED",
              message: "MFA enrollment required before using the API",
            });
            return;
          }
        }
      } catch {
        res.status(403).json({
          success: false,
          code: "MFA_ENROLLMENT_REQUIRED",
          message: "MFA enrollment required before using the API",
        });
        return;
      }
    }

    next();
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') {
      res.status(401).send('Token expired');
      return;
    }
    res.sendStatus(403);
  }
};

export const authorizeRoles = (...allowedRoles: Array<'admin' | 'manager' | 'support' | 'collector' | 'reseller'>) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.role || !allowedRoles.includes(req.user.role)) {
      res.status(403).send('Forbidden');
      return;
    }
    next();
  };
};

export const authorizePermissions = (...requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user?.username && !req.user?.id) {
        res.status(401).send('Unauthorized');
        return;
      }

      const cached = (req.user as any)?.permissions as string[] | undefined;
      const permsRaw =
        Array.isArray(cached)
          ? cached
          : await getEffectivePermissionsForUser({
              userId: (req.user as any)?.id,
              username: (req.user as any)?.username,
              roleKey: (req.user as any)?.role,
            });

      const perms = (Array.isArray(permsRaw) ? permsRaw : [])
        .map((p) => String(p).trim())
        .filter((p) => p.length > 0);

      (req.user as any).permissions = perms;

      const required = requiredPermissions.map((p) => String(p).trim()).filter((p) => p.length > 0);
      const hasAll = required.every((p) => perms.includes(p));
      if (!hasAll) {
        // Helpful debug without leaking too much to clients
        try {
          const username = (req.user as any)?.username;
          const role = (req.user as any)?.role;
          console.warn("RBAC Forbidden", {
            method: req.method,
            url: req.originalUrl,
            username,
            role,
            required,
            permsCount: perms.length,
          });
        } catch {}
        res.status(403).send('Forbidden');
        return;
      }

      next();
    } catch (e) {
      res.status(500).send('Internal server error');
    }
  };
};

/**
 * Require at least one of the provided permissions.
 * Useful when some permissions logically imply others (e.g. pay implies view).
 */
export const authorizeAnyPermissions = (...anyPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user?.username && !req.user?.id) {
        res.status(401).send('Unauthorized');
        return;
      }

      const cached = (req.user as any)?.permissions as string[] | undefined;
      const permsRaw =
        Array.isArray(cached)
          ? cached
          : await getEffectivePermissionsForUser({
              userId: (req.user as any)?.id,
              username: (req.user as any)?.username,
              roleKey: (req.user as any)?.role,
            });

      const perms = (Array.isArray(permsRaw) ? permsRaw : [])
        .map((p) => String(p).trim())
        .filter((p) => p.length > 0);

      (req.user as any).permissions = perms;

      const any = anyPermissions.map((p) => String(p).trim()).filter((p) => p.length > 0);
      const hasAny = any.some((p) => perms.includes(p));
      if (!hasAny) {
        try {
          const username = (req.user as any)?.username;
          const role = (req.user as any)?.role;
          console.warn("RBAC Forbidden (any)", {
            username,
            role,
            any,
            permsCount: perms.length,
          });
        } catch {}
        res.status(403).send('Forbidden');
        return;
      }

      next();
    } catch (e) {
      res.status(500).send('Internal server error');
    }
  };
};