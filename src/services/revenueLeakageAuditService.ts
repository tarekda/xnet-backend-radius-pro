import { AppDataSource } from "../db/config";
import { RevenueLeakageAudit, LeakageType, RemediationAction, AuditStatus } from "../db/entities/RevenueLeakageAudit";
import { Radacct } from "../db/entities/Radacct";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { bandwidthService } from "./bandwidthService";
import { UserController } from "../controllers/userController";
import { broadcastToClients } from "../realtime/wsHub";

export interface AuditRunOptions {
  autoRemediate?: boolean;
  targetUsername?: string;
  maxAuditRecords?: number;
  actor?: string;
}

export interface AuditRunResult {
  totalInspected: number;
  leaksDetected: number;
  totalEstimatedLossUsd: number;
  remediatedCount: number;
  leaks: Array<{
    username: string;
    leakType: LeakageType;
    estimatedLossUsd: number;
    remediationAction: RemediationAction;
    reason: string;
  }>;
  durationMs: number;
}

export interface RevenueLeakageSummary {
  activeGhostCount: number;
  unpaidOnlineCount: number;
  speedMisalignmentCount: number;
  totalActiveLeaks: number;
  totalEstimatedLossUsd: number;
  remediatedCount: number;
  lastAuditAt: Date | null;
}

/**
 * Calculates estimated revenue loss ($ USD) based on unbilled days and leaked gigabytes.
 */
export function calculateEstimatedRevenueLoss(opts: {
  monthlyAmount?: number | null;
  unpaidDays?: number;
  bytesTotal?: bigint | number;
}): number {
  const baseMonthly = opts.monthlyAmount && opts.monthlyAmount > 0 ? opts.monthlyAmount : 25; // average $25/mo
  const days = Math.max(opts.unpaidDays || 0, 1);
  const dailyRate = baseMonthly / 30;
  const timeLoss = Math.min(days * dailyRate, baseMonthly * 2);

  // Bandwidth cost for leaked traffic: $0.15 per GB
  const bytes = BigInt(opts.bytesTotal || 0);
  const gb = Number(bytes) / (1024 * 1024 * 1024);
  const bandwidthLoss = gb * 0.15;

  const total = timeLoss + bandwidthLoss;
  return Math.round(total * 100) / 100;
}

/**
 * Runs a cross-layer audit comparing MikroTik active hardware sessions against
 * FreeRADIUS radacct and External Invoice billing statuses.
 */
export async function runRevenueLeakageAudit(options: AuditRunOptions = {}): Promise<AuditRunResult> {
  const startTime = Date.now();
  const repo = AppDataSource.getRepository(RevenueLeakageAudit);
  const autoRemediate = options.autoRemediate ?? (process.env.REVENUE_LEAKAGE_AUTO_REMEDIATE === "true");

  // 1. Fetch live router sessions from MikroTik
  let pppActive: any[] = [];
  try {
    const activeConns = await bandwidthService.getActiveConnections();
    pppActive = Array.isArray(activeConns?.pppConnections) ? activeConns.pppConnections : [];
  } catch (err: any) {
    console.warn("[revenue-leakage-audit] MikroTik active connections query warning:", err?.message || err);
  }

  // 2. Fetch open radacct sessions
  const radacctRows = await AppDataSource.getRepository(Radacct)
    .createQueryBuilder("ra")
    .select([
      "ra.username AS username",
      "ra.nasipaddress AS nasipaddress",
      "ra.framedipaddress AS framedipaddress",
      "ra.callingstationid AS callingstationid",
      "ra.acctsessionid AS acctsessionid",
      "ra.acctinputoctets AS acctinputoctets",
      "ra.acctoutputoctets AS acctoutputoctets",
      "ra.acctstarttime AS acctstarttime",
    ])
    .where("ra.acctstoptime IS NULL")
    .getRawMany();

  const radacctMap = new Map<string, any>();
  for (const r of radacctRows) {
    const u = String(r.username || "").trim().toLowerCase();
    if (u) radacctMap.set(u, r);
  }

  // 3. Fetch user profiles (expiry & throttling state)
  const profiles = await AppDataSource.getRepository(Raduserprofile)
    .createQueryBuilder("up")
    .leftJoinAndSelect("up.profile", "rp")
    .select([
      "up.username",
      "up.accountStatus",
      "up.expiresAt",
      "up.isMonthlyExceeded",
      "rp.profileName",
    ])
    .getMany();

  const profileMap = new Map<string, Raduserprofile>();
  for (const p of profiles) {
    profileMap.set(p.username.toLowerCase(), p);
  }

  // 4. Fetch overdue / unpaid external invoices
  const unpaidInvoices = await AppDataSource.getRepository(ExternalInvoice)
    .createQueryBuilder("i")
    .select([
      "i.id",
      "i.username",
      "i.fullName",
      "i.status",
      "i.billingMonth",
      "i.payDueDate",
      "i.amount",
      "i.totalAmount",
      "i.amountPaid",
    ])
    .where("LOWER(i.status) IN (:...statuses)", { statuses: ["unpaid", "pending"] })
    .andWhere("i.voidedAt IS NULL")
    .getMany();

  const unpaidInvoiceMap = new Map<string, ExternalInvoice>();
  for (const inv of unpaidInvoices) {
    const u = String(inv.username || "").trim().toLowerCase();
    if (u && !unpaidInvoiceMap.has(u)) {
      unpaidInvoiceMap.set(u, inv);
    }
  }

  // 5. Cross-reconcile all active usernames across MikroTik and radacct
  const allActiveUsernames = new Set<string>();
  for (const p of pppActive) {
    const u = String(p.name || "").trim().toLowerCase();
    if (u) allActiveUsernames.add(u);
  }
  for (const [u] of radacctMap) {
    allActiveUsernames.add(u);
  }

  if (options.targetUsername) {
    const t = options.targetUsername.trim().toLowerCase();
    allActiveUsernames.clear();
    allActiveUsernames.add(t);
  }

  const detectedLeaks: Array<{
    username: string;
    fullName: string | null;
    nasIp: string | null;
    nasIdentifier: string | null;
    callerId: string | null;
    framedIp: string | null;
    leakType: LeakageType;
    leakReason: string;
    bytesIn: bigint;
    bytesOut: bigint;
    unpaidInvoiceId: number | null;
    unpaidAmount: number;
    estimatedLossUsd: number;
  }> = [];

  const now = new Date();

  for (const username of allActiveUsernames) {
    const profile = profileMap.get(username);
    const invoice = unpaidInvoiceMap.get(username);
    const radacct = radacctMap.get(username);
    const routerSession = pppActive.find((p) => String(p.name || "").trim().toLowerCase() === username);

    const isOnlineOnRouter = Boolean(routerSession);
    const isOnlineInRadius = Boolean(radacct);

    const callerId = routerSession?.["caller-id"] || radacct?.callingstationid || null;
    const framedIp = routerSession?.address || radacct?.framedipaddress || null;
    const nasIp = radacct?.nasipaddress || process.env.MIKROTIK_IP || "172.9.16.2";

    const bytesIn = BigInt(routerSession?.["bytes-in"] || radacct?.acctinputoctets || 0);
    const bytesOut = BigInt(routerSession?.["bytes-out"] || radacct?.acctoutputoctets || 0);
    const totalBytes = bytesIn + bytesOut;

    // Discrepancy 1: Expired / Overdue Invoiced User Online at full speed
    const isExpired =
      profile?.accountStatus === "expired" ||
      (profile?.expiresAt && new Date(profile.expiresAt) < now);

    const isOverdue =
      invoice &&
      invoice.payDueDate &&
      new Date(invoice.payDueDate) < now;

    const profileName = (profile?.profile as any)?.profileName || "";
    const isWalledGarden = /walled|quarantine|expired|block/i.test(profileName);

    if ((isOnlineOnRouter || isOnlineInRadius) && (isExpired || isOverdue) && !isWalledGarden) {
      const daysOverdue = isOverdue
        ? Math.max(1, Math.ceil((now.getTime() - new Date(invoice!.payDueDate!).getTime()) / (1000 * 60 * 60 * 24)))
        : isExpired && profile?.expiresAt
        ? Math.max(1, Math.ceil((now.getTime() - new Date(profile.expiresAt).getTime()) / (1000 * 60 * 60 * 24)))
        : 1;

      const invoiceAmount = invoice ? Number(invoice.totalAmount || invoice.amount || 0) : 25;
      const estimatedLoss = calculateEstimatedRevenueLoss({
        monthlyAmount: invoiceAmount,
        unpaidDays: daysOverdue,
        bytesTotal: totalBytes,
      });

      detectedLeaks.push({
        username,
        fullName: invoice?.fullName || null,
        nasIp,
        nasIdentifier: "mikrotik-main",
        callerId,
        framedIp,
        leakType: "EXPIRED_UNPAID_ONLINE",
        leakReason: isOverdue
          ? `Subscriber has overdue unpaid invoice #${invoice!.id} ($${invoiceAmount}) due ${invoice!.payDueDate}, but is browsing online`
          : `Subscriber account expired on ${profile?.expiresAt?.toISOString?.() || "past cycle"}, but active session remains unthrottled`,
        bytesIn,
        bytesOut,
        unpaidInvoiceId: invoice?.id ?? null,
        unpaidAmount: invoiceAmount,
        estimatedLossUsd: estimatedLoss,
      });
      continue;
    }

    // Discrepancy 2: Ghost Stale Session (Connected on MikroTik but missing in RADIUS accounting)
    if (isOnlineOnRouter && !isOnlineInRadius) {
      const estimatedLoss = calculateEstimatedRevenueLoss({
        monthlyAmount: 20,
        unpaidDays: 2,
        bytesTotal: totalBytes,
      });

      detectedLeaks.push({
        username,
        fullName: invoice?.fullName || null,
        nasIp,
        nasIdentifier: "mikrotik-main",
        callerId,
        framedIp,
        leakType: "GHOST_STALE_SESSION",
        leakReason: `Active PPPoE/Hotspot session exists on MikroTik, but accounting is missing/terminated in FreeRADIUS radacct`,
        bytesIn,
        bytesOut,
        unpaidInvoiceId: invoice?.id ?? null,
        unpaidAmount: invoice ? Number(invoice.totalAmount || invoice.amount || 0) : 0,
        estimatedLossUsd: estimatedLoss,
      });
      continue;
    }

    // Discrepancy 3: Speed Profile Misalignment (Database profile says throttled, but running normal speed)
    const isProfileThrottled =
      Boolean(profile?.isMonthlyExceeded) ||
      /throttle|dunning|fup_slow|256k|512k|1m/i.test(profileName);
    const isRouterNormalSpeed = routerSession && !/throttle|walled|slow/i.test(String(routerSession.profile || ""));
    if (isOnlineOnRouter && isProfileThrottled && isRouterNormalSpeed) {
      detectedLeaks.push({
        username,
        fullName: invoice?.fullName || null,
        nasIp,
        nasIdentifier: "mikrotik-main",
        callerId,
        framedIp,
        leakType: "PROFILE_SPEED_MISALIGNMENT",
        leakReason: `Subscriber profile in DB is throttled (${profileName || "exceeded"}), but MikroTik router session is running profile '${routerSession?.profile || "default"}'`,
        bytesIn,
        bytesOut,
        unpaidInvoiceId: invoice?.id ?? null,
        unpaidAmount: invoice ? Number(invoice.totalAmount || invoice.amount || 0) : 0,
        estimatedLossUsd: 5.0,
      });
    }
  }

  // 6. Record in Database & Remediate
  let remediatedCount = 0;
  let totalLoss = 0;
  const recordedResults: AuditRunResult["leaks"] = [];

  for (const leak of detectedLeaks) {
    totalLoss += leak.estimatedLossUsd;
    let action: RemediationAction = "none";
    let status: AuditStatus = "detected";

    if (autoRemediate) {
      try {
        await bandwidthService.disconnectUser(leak.username);
        await UserController.disconnectUser(leak.username);
        action = "mikrotik_disconnect";
        status = "remediated";
        remediatedCount++;
      } catch (err: any) {
        console.warn(`[revenue-leakage-audit] Failed to auto-remediate ${leak.username}:`, err?.message || err);
      }
    }

    const auditRecord = repo.create({
      username: leak.username,
      fullName: leak.fullName,
      nasIp: leak.nasIp,
      nasIdentifier: leak.nasIdentifier,
      callerId: leak.callerId,
      framedIp: leak.framedIp,
      leakType: leak.leakType,
      leakReason: leak.leakReason,
      bytesIn: leak.bytesIn.toString(),
      bytesOut: leak.bytesOut.toString(),
      unpaidInvoiceId: leak.unpaidInvoiceId,
      unpaidAmount: leak.unpaidAmount,
      estimatedLossUsd: leak.estimatedLossUsd,
      remediationAction: action,
      status,
      detectedAt: now,
      resolvedAt: status === "remediated" ? now : null,
      resolvedBy: status === "remediated" ? (options.actor || "autonomous_audit_engine") : null,
      metadata: {
        autoRemediate,
        durationMs: Date.now() - startTime,
      },
    });

    await repo.save(auditRecord);

    recordedResults.push({
      username: leak.username,
      leakType: leak.leakType,
      estimatedLossUsd: leak.estimatedLossUsd,
      remediationAction: action,
      reason: leak.leakReason,
    });
  }

  // 7. Broadcast WebSocket event if new leaks detected
  if (detectedLeaks.length > 0) {
    broadcastToClients({
      type: "REVENUE_LEAKAGE_AUDIT_DETECTED",
      leaksDetected: detectedLeaks.length,
      estimatedLossUsd: Math.round(totalLoss * 100) / 100,
      remediatedCount,
      timestamp: now.toISOString(),
    });
  }

  return {
    totalInspected: allActiveUsernames.size,
    leaksDetected: detectedLeaks.length,
    totalEstimatedLossUsd: Math.round(totalLoss * 100) / 100,
    remediatedCount,
    leaks: recordedResults,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Returns executive metrics summarizing detected leaks and financial exposure.
 */
export async function getRevenueLeakageSummary(): Promise<RevenueLeakageSummary> {
  const repo = AppDataSource.getRepository(RevenueLeakageAudit);

  const activeAudits = await repo
    .createQueryBuilder("a")
    .where("a.status = :status", { status: "detected" })
    .getMany();

  const remediatedCount = await repo
    .createQueryBuilder("a")
    .where("a.status = :status", { status: "remediated" })
    .getCount();

  const lastRecord = await repo
    .createQueryBuilder("a")
    .orderBy("a.detectedAt", "DESC")
    .getOne();

  let activeGhost = 0;
  let unpaidOnline = 0;
  let speedMisalignment = 0;
  let totalLoss = 0;

  for (const a of activeAudits) {
    totalLoss += Number(a.estimatedLossUsd || 0);
    if (a.leakType === "GHOST_STALE_SESSION") activeGhost++;
    else if (a.leakType === "EXPIRED_UNPAID_ONLINE") unpaidOnline++;
    else if (a.leakType === "PROFILE_SPEED_MISALIGNMENT") speedMisalignment++;
  }

  return {
    activeGhostCount: activeGhost,
    unpaidOnlineCount: unpaidOnline,
    speedMisalignmentCount: speedMisalignment,
    totalActiveLeaks: activeAudits.length,
    totalEstimatedLossUsd: Math.round(totalLoss * 100) / 100,
    remediatedCount,
    lastAuditAt: lastRecord?.detectedAt ?? null,
  };
}

/**
 * Remediate a specific leakage record by terminating the active session on MikroTik and CoA.
 */
export async function remediateLeakageRecord(
  id: number,
  resolvedBy = "admin"
): Promise<RevenueLeakageAudit | null> {
  const repo = AppDataSource.getRepository(RevenueLeakageAudit);
  const record = await repo.findOne({ where: { id } });
  if (!record) return null;

  try {
    await bandwidthService.disconnectUser(record.username);
    await UserController.disconnectUser(record.username);
    record.remediationAction = "mikrotik_disconnect";
    record.status = "remediated";
    record.resolvedAt = new Date();
    record.resolvedBy = resolvedBy;
    return await repo.save(record);
  } catch (err: any) {
    console.error(`[revenue-leakage] Failed to remediate record #${id}:`, err);
    throw err;
  }
}

/**
 * 1-Click "Plug All Leaks": Remediate all active detected ghost/unpaid sessions.
 */
export async function remediateAllDetectedLeakages(resolvedBy = "admin"): Promise<{
  attempted: number;
  remediated: number;
  failed: number;
}> {
  const repo = AppDataSource.getRepository(RevenueLeakageAudit);
  const detected = await repo.find({ where: { status: "detected" } });

  let remediated = 0;
  let failed = 0;

  for (const r of detected) {
    try {
      await remediateLeakageRecord(r.id, resolvedBy);
      remediated++;
    } catch {
      failed++;
    }
  }

  return {
    attempted: detected.length,
    remediated,
    failed,
  };
}
