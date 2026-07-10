import { Request, Response, NextFunction } from "express";
import {
  getUsageSeries,
  getAnalyticsMetrics,
  getAuthDistribution,
  getGeographicByNas,
  getPeakHours,
} from "../services/analyticsService";

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
