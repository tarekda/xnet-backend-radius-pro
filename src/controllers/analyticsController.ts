import { Request, Response, NextFunction } from "express";
import {
  getUsageSeries,
  getAnalyticsMetrics,
  getAuthDistribution,
  getGeographicByNas,
  getPeakHours,
  getRevenueInsights,
} from "../services/analyticsService";
import { apiSuccess } from "../utils/responseBuilder";

export async function usageHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getUsageSeries(String(req.query.range || "24h"));
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function metricsHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getAnalyticsMetrics();
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function authDistributionHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getAuthDistribution();
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function geographicHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getGeographicByNas();
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function peakHoursHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getPeakHours();
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function revenueInsightsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const months = parseInt(String(req.query.months || "6"), 10);
    const data = await getRevenueInsights(Number.isFinite(months) && months > 0 ? months : 6);
    apiSuccess(res, data, { req, message: "Revenue insights retrieved successfully" });
  } catch (err) {
    next(err);
  }
}
