import { Request, Response } from 'express';
import { diagnoseUserConnectivity } from '../services/connectivityDiagnosisService';
import { buildDailyOpsBrief, getRecentRejectUsernames } from '../services/dailyOpsBriefService';

function getResellerScope(req: Request): { isReseller: boolean; resellerId: number | null } {
  const role = (req.user as any)?.role as string | undefined;
  const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
  const resellerId = typeof resellerIdRaw === 'number' && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
  return { isReseller: role === 'reseller' && !!resellerId, resellerId };
}

function userCanSeeBilling(req: Request): boolean {
  const perms: string[] = (req.user as any)?.permissions ?? [];
  if (!Array.isArray(perms)) return false;
  return perms.some((p) =>
    [
      'billing.externalInvoices.view',
      'billing.externalInvoices.viewTotals',
      'billing.externalInvoices.pay',
    ].includes(String(p))
  );
}

export const diagnoseConnectivity = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username ?? '').trim();
    if (!username) {
      res.status(400).json({ success: false, message: 'username is required' });
      return;
    }

    const scope = getResellerScope(req);
    const result = await diagnoseUserConnectivity(username, scope);
    if (!result) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('[ai] diagnose connectivity failed:', error);
    res.status(500).json({ success: false, message: 'Failed to diagnose connectivity' });
  }
};

export const getDailyOpsBrief = async (req: Request, res: Response) => {
  try {
    const scope = getResellerScope(req);
    const includeBilling = userCanSeeBilling(req);
    const result = await buildDailyOpsBrief({ ...scope, includeBilling });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('[ai] daily ops brief failed:', error);
    res.status(500).json({ success: false, message: 'Failed to build daily ops brief' });
  }
};

export const getRecentRejectUsers = async (req: Request, res: Response) => {
  try {
    const hoursRaw = Number(req.query.hours ?? 24);
    const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(Math.round(hoursRaw), 1), 168) : 24;
    const scope = getResellerScope(req);
    const recentRejectUsernames = await getRecentRejectUsernames(scope, hours);
    res.status(200).json({ success: true, data: { recentRejectUsernames, hours } });
  } catch (error) {
    console.error('[ai] recent reject users failed:', error);
    res.status(500).json({ success: false, message: 'Failed to load recent auth failures' });
  }
};
