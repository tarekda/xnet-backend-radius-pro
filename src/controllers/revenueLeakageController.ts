import { Request, Response } from "express";
import { AppDataSource } from "../db/config";
import { RevenueLeakageAudit, AuditStatus, LeakageType } from "../db/entities/RevenueLeakageAudit";
import {
  runRevenueLeakageAudit,
  getRevenueLeakageSummary,
  remediateLeakageRecord,
  remediateAllDetectedLeakages,
} from "../services/revenueLeakageAuditService";

export const getRevenueLeakageSummaryHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const summary = await getRevenueLeakageSummary();
    res.json({ success: true, data: summary });
  } catch (error: any) {
    console.error("[revenueLeakageController] getSummary error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to fetch summary" });
  }
};

export const listRevenueLeakageAuditsHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));
    const status = req.query.status ? String(req.query.status) : undefined;
    const leakType = req.query.leakType ? String(req.query.leakType) : undefined;
    const search = req.query.search ? String(req.query.search).trim() : undefined;

    const repo = AppDataSource.getRepository(RevenueLeakageAudit);
    let qb = repo.createQueryBuilder("a").orderBy("a.detectedAt", "DESC");

    if (status && status.toLowerCase() !== "all") {
      qb = qb.andWhere("a.status = :status", { status: status as AuditStatus });
    }

    if (leakType && leakType.toLowerCase() !== "all") {
      qb = qb.andWhere("a.leakType = :leakType", { leakType: leakType as LeakageType });
    }

    if (search) {
      qb = qb.andWhere(
        "(LOWER(a.username) LIKE :search OR LOWER(a.fullName) LIKE :search OR a.framedIp LIKE :search)",
        { search: `%${search.toLowerCase()}%` }
      );
    }

    const total = await qb.getCount();
    const items = await qb.skip((page - 1) * limit).take(limit).getMany();

    res.json({
      success: true,
      data: items,
      records: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error("[revenueLeakageController] listAudits error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to list audits" });
  }
};

export const runRevenueLeakageAuditHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const autoRemediate = Boolean(req.body?.autoRemediate);
    const targetUsername = req.body?.targetUsername ? String(req.body.targetUsername).trim() : undefined;
    const actor = (req as any)?.user?.username || "admin";

    const result = await runRevenueLeakageAudit({
      autoRemediate,
      targetUsername,
      actor,
    });

    res.json({
      success: true,
      data: result,
      message: `Audit completed: inspected ${result.totalInspected} users, detected ${result.leaksDetected} leaks ($${result.totalEstimatedLossUsd} estimated loss).`,
    });
  } catch (error: any) {
    console.error("[revenueLeakageController] runAudit error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to run audit" });
  }
};

export const remediateRevenueLeakageHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, message: "Invalid audit ID" });
      return;
    }

    const actor = (req as any)?.user?.username || "admin";
    const updated = await remediateLeakageRecord(id, actor);

    if (!updated) {
      res.status(404).json({ success: false, message: "Audit record not found" });
      return;
    }

    res.json({
      success: true,
      data: updated,
      message: `Successfully disconnected user ${updated.username} and remediated session leakage.`,
    });
  } catch (error: any) {
    console.error(`[revenueLeakageController] remediate error:`, error);
    res.status(500).json({ success: false, message: error?.message || "Failed to remediate leak" });
  }
};

export const remediateAllRevenueLeakagesHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as any)?.user?.username || "admin";
    const result = await remediateAllDetectedLeakages(actor);

    res.json({
      success: true,
      data: result,
      message: `Remediation completed: attempted ${result.attempted}, successfully remediated ${result.remediated}, failed ${result.failed}.`,
    });
  } catch (error: any) {
    console.error("[revenueLeakageController] remediateAll error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to remediate all leaks" });
  }
};
