import { Request, Response, NextFunction } from "express";

/**
 * Parses client IP address from express request, honoring reverse proxy headers.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket?.remoteAddress || req.ip || "127.0.0.1";
}

/**
 * Normalizes IPv4-mapped IPv6 addresses (e.g. ::ffff:192.168.1.1 -> 192.168.1.1).
 */
export function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    return ip.substring(7);
  }
  if (ip === "::1") {
    return "127.0.0.1";
  }
  return ip;
}

/**
 * Checks whether an IP matches a single address or a CIDR subnet block.
 */
export function isIpMatch(clientIp: string, allowedPattern: string): boolean {
  const normClient = normalizeIp(clientIp.trim());
  const normAllowed = normalizeIp(allowedPattern.trim());

  if (normAllowed === "*" || normAllowed === "0.0.0.0/0") return true;
  if (normClient === normAllowed) return true;

  // Check simple CIDR matching for IPv4 (e.g. 192.168.1.0/24)
  if (normAllowed.includes("/")) {
    const [subnet, maskStr] = normAllowed.split("/");
    const maskBits = parseInt(maskStr, 10);
    if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) return false;

    const ipToLong = (ipStr: string): number => {
      const parts = ipStr.split(".").map((p) => parseInt(p, 10));
      if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return 0;
      return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    };

    const clientLong = ipToLong(normClient);
    const subnetLong = ipToLong(subnet);
    if (!clientLong || !subnetLong) return false;

    const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
    return (clientLong & mask) === (subnetLong & mask);
  }

  return false;
}

export interface IpWhitelistOptions {
  allowedIps?: string[];
  exemptPaths?: string[];
  customMessage?: string;
}

/**
 * Express middleware to restrict incoming requests to trusted enterprise IP addresses and subnets.
 * Configured via ADMIN_IP_WHITELIST environment variable or explicit allowed list.
 */
export function ipWhitelistMiddleware(options: IpWhitelistOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Check if whitelisting is disabled in environment
    const isDisabled = String(process.env.ADMIN_IP_WHITELIST_DISABLED ?? "false").trim().toLowerCase() === "true";
    if (isDisabled) {
      next();
      return;
    }

    // Exempt paths (health checks, webhooks)
    const path = req.path || "";
    if (options.exemptPaths?.some((p) => path.startsWith(p)) || path === "/health" || path.startsWith("/api/webhooks/")) {
      next();
      return;
    }

    const envList = (process.env.ADMIN_IP_WHITELIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const allowed = options.allowedIps && options.allowedIps.length > 0 ? options.allowedIps : envList;

    // If no whitelist is configured, allow all traffic (opt-in protection)
    if (allowed.length === 0) {
      next();
      return;
    }

    // Always permit local loopback in development
    const clientIp = getClientIp(req);
    const normClient = normalizeIp(clientIp);
    if (normClient === "127.0.0.1" || normClient === "localhost") {
      next();
      return;
    }

    const isAllowed = allowed.some((rule) => isIpMatch(normClient, rule));

    if (!isAllowed) {
      console.warn(`[security] Blocked unauthorized request to ${req.method} ${path} from IP: ${clientIp}`);
      res.status(403).json({
        success: false,
        message: options.customMessage || "Forbidden: Your IP address is not permitted to access this resource.",
        clientIp,
      });
      return;
    }

    next();
  };
}
