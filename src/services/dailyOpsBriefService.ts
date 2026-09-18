import { AppDataSource } from '../db/config';
import { Nas } from '../db/entities/Nas';
import { readOnlineSessionConfig } from '../utils/onlineSessionPolicy';
import axios from 'axios';

export type OpsBriefSeverity = 'ok' | 'warning' | 'critical';

export type DailyOpsBriefResult = {
  generatedAt: string;
  severity: OpsBriefSeverity;
  summary: string;
  aiEnhanced: boolean;
  metrics: {
    usersWithRecentRejects: number;
    offlineWithRecentRejects: number;
    quotaExceeded: number;
    accountIssues: number;
    overdueInvoices: number;
    overdueInvoiceAmount: number;
    missingPayDueInvoices: number;
    authAttempts24h: number;
    authRejected24h: number;
    authRejectRate24h: number;
  };
  highlights: Array<{ code: string; severity: 'info' | 'warning' | 'critical'; message: string; count?: number }>;
  usersWithRecentRejects: Array<{ username: string; rejectCount: number; lastRejectAt: string | null; isOnline: boolean }>;
  topNasAuthFailures: Array<{ nasIp: string; nasLabel: string; failures: number }>;
  recentRejectUsernames: Record<string, number>;
};

type BriefScope = { isReseller: boolean; resellerId: number | null; includeBilling?: boolean };

function resellerClause(alias: string, scope?: BriefScope): { sql: string; params: unknown[] } {
  if (scope?.isReseller && scope.resellerId) {
    return { sql: ` AND ${alias}.owner_reseller_id = ?`, params: [scope.resellerId] };
  }
  return { sql: '', params: [] };
}

async function maybeEnhanceBriefSummary(base: {
  summary: string;
  severity: OpsBriefSeverity;
  highlights: DailyOpsBriefResult['highlights'];
  metrics: DailyOpsBriefResult['metrics'];
}): Promise<{ summary: string; aiEnhanced: boolean }> {
  const apiKey = String(process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey || String(process.env.AI_OPS_BRIEF_ENABLED ?? 'true').toLowerCase() === 'false') {
    return { summary: base.summary, aiEnhanced: false };
  }

  const model = String(process.env.OPENAI_MODEL ?? 'gpt-4o-mini').trim();
  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        temperature: 0.2,
        max_tokens: 280,
        messages: [
          {
            role: 'system',
            content:
              'You are an ISP NOC lead writing a morning ops brief for support staff. Use only the JSON facts provided. 3-4 short sentences. Prioritize connectivity and billing issues. English only.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              severity: base.severity,
              summary: base.summary,
              highlights: base.highlights,
              metrics: base.metrics,
            }),
          },
        ],
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    const text = resp.data?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text.trim()) {
      return { summary: text.trim(), aiEnhanced: true };
    }
  } catch (e) {
    console.warn('[ai] daily ops brief summary skipped:', (e as Error)?.message ?? e);
  }
  return { summary: base.summary, aiEnhanced: false };
}

export async function buildDailyOpsBrief(scope?: BriefScope): Promise<DailyOpsBriefResult> {
  const now = new Date();
  const start24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { staleCutoff } = readOnlineSessionConfig();
  const rs = resellerClause('up', scope);
  const rsInv = scope?.isReseller && scope.resellerId ? ' AND ei.username IN (SELECT username FROM raduserprofile WHERE owner_reseller_id = ?)' : '';
  const invParams = scope?.isReseller && scope.resellerId ? [scope.resellerId] : [];

  const trendRows = (await AppDataSource.query(
    `
      SELECT COALESCE(SUM(attempts), 0) AS attempts, COALESCE(SUM(rejected), 0) AS rejected
      FROM connection_log_hourly_stats
      WHERE bucket >= ? AND bucket <= ?
    `,
    [start24h, now]
  )) as Array<{ attempts: string; rejected: string }>;

  const authAttempts24h = Number(trendRows[0]?.attempts ?? 0);
  const authRejected24h = Number(trendRows[0]?.rejected ?? 0);
  const authRejectRate24h =
    authAttempts24h > 0 ? Number(((authRejected24h / authAttempts24h) * 100).toFixed(1)) : 0;

  const staleSql = staleCutoff.toISOString().slice(0, 19).replace('T', ' ');

  const rejectUserRows = (await AppDataSource.query(
    `
      SELECT
        cl.username AS username,
        COUNT(*) AS rejectCount,
        MAX(cl.timestamp) AS lastRejectAt,
        MAX(CASE WHEN online.is_online = 1 THEN 1 ELSE 0 END) AS isOnline
      FROM connection_logs cl
      INNER JOIN raduserprofile up ON up.username = cl.username
      LEFT JOIN (
        SELECT st.username AS username, 1 AS is_online
        FROM session_tracking st
        INNER JOIN radacct ra ON ra.acctsessionid = st.session_id
          AND ra.acctstoptime IS NULL
          AND (
            (ra.acctupdatetime IS NOT NULL AND ra.acctupdatetime >= ?)
            OR (ra.acctupdatetime IS NULL AND ra.acctstarttime >= ?)
            OR (ra.acctupdatetime IS NULL)
          )
        WHERE st.status = 'active'
        GROUP BY st.username
      ) online ON online.username = cl.username
      WHERE cl.username IS NOT NULL
        AND cl.status IN ('rejected', 'timeout', 'error')
        AND cl.timestamp >= ?
        ${rs.sql}
      GROUP BY cl.username
      ORDER BY rejectCount DESC, lastRejectAt DESC
      LIMIT 20
    `,
    [staleSql, staleSql, start24h, ...rs.params]
  )) as Array<{ username: string; rejectCount: string; lastRejectAt: Date | null; isOnline: string }>;

  const quotaExceededRow = (await AppDataSource.query(
    `SELECT COUNT(*) AS cnt FROM raduserprofile up WHERE up.is_monthly_exceeded = 1 ${rs.sql}`,
    rs.params
  )) as Array<{ cnt: string }>;

  const accountIssuesRow = (await AppDataSource.query(
    `
      SELECT COUNT(*) AS cnt
      FROM raduserprofile up
      WHERE (
        up.account_status IN ('suspended', 'expired', 'terminated')
        OR (up.expires_at IS NOT NULL AND up.expires_at < NOW())
      )
      ${rs.sql}
    `,
    rs.params
  )) as Array<{ cnt: string }>;

  let overdueInvoices = 0;
  let overdueInvoiceAmount = 0;
  let missingPayDueInvoices = 0;

  if (scope?.includeBilling !== false) {
    const overdueRows = (await AppDataSource.query(
      `
        SELECT COUNT(*) AS cnt, COALESCE(SUM(ei.amount), 0) AS total
        FROM external_invoices ei
        WHERE ei.deletedAt IS NULL
          AND ei.status IN ('unpaid', 'pending')
          AND ei.payDueDate IS NOT NULL
          AND ei.payDueDate < CURDATE()
          ${rsInv}
      `,
      invParams
    )) as Array<{ cnt: string; total: string }>;
    overdueInvoices = Number(overdueRows[0]?.cnt ?? 0);
    overdueInvoiceAmount = Number(overdueRows[0]?.total ?? 0);

    const missingRows = (await AppDataSource.query(
      `
        SELECT COUNT(*) AS cnt
        FROM external_invoices ei
        WHERE ei.deletedAt IS NULL
          AND ei.status IN ('unpaid', 'pending')
          AND (ei.payDueDate IS NULL)
          ${rsInv}
      `,
      invParams
    )) as Array<{ cnt: string }>;
    missingPayDueInvoices = Number(missingRows[0]?.cnt ?? 0);
  }

  const nasFailureRows = (await AppDataSource.query(
    `
      SELECT
        COALESCE(cl.nas_ip, 'Unknown') AS nasIp,
        COUNT(*) AS failures
      FROM connection_logs cl
      WHERE cl.status IN ('rejected', 'timeout', 'error')
        AND cl.timestamp >= ?
      GROUP BY cl.nas_ip
      ORDER BY failures DESC
      LIMIT 5
    `,
    [start24h]
  )) as Array<{ nasIp: string; failures: string }>;

  const nasIps = nasFailureRows.map((r) => r.nasIp).filter((ip) => ip && ip !== 'Unknown');
  const nasLabelMap = new Map<string, string>();
  if (nasIps.length) {
    const nasEntities = await AppDataSource.getRepository(Nas)
      .createQueryBuilder('n')
      .where('n.nasname IN (:...ips)', { ips: nasIps })
      .getMany();
    for (const n of nasEntities) {
      nasLabelMap.set(n.nasname, n.shortname || n.nasname);
    }
  }

  const rejectMapRows = (await AppDataSource.query(
    `
      SELECT cl.username AS username, COUNT(*) AS rejectCount
      FROM connection_logs cl
      INNER JOIN raduserprofile up ON up.username = cl.username
      WHERE cl.username IS NOT NULL
        AND cl.status IN ('rejected', 'timeout', 'error')
        AND cl.timestamp >= ?
        ${rs.sql}
      GROUP BY cl.username
      LIMIT 500
    `,
    [start24h, ...rs.params]
  )) as Array<{ username: string; rejectCount: string }>;

  const recentRejectUsernames: Record<string, number> = {};
  for (const row of rejectMapRows) {
    if (row.username) recentRejectUsernames[row.username] = Number(row.rejectCount ?? 0);
  }

  const usersWithRecentRejects = rejectUserRows.map((row) => ({
    username: row.username,
    rejectCount: Number(row.rejectCount ?? 0),
    lastRejectAt: row.lastRejectAt ? new Date(row.lastRejectAt).toISOString() : null,
    isOnline: Number(row.isOnline ?? 0) === 1,
  }));

  const offlineWithRecentRejects = usersWithRecentRejects.filter((u) => !u.isOnline).length;
  const quotaExceeded = Number(quotaExceededRow[0]?.cnt ?? 0);
  const accountIssues = Number(accountIssuesRow[0]?.cnt ?? 0);

  const highlights: DailyOpsBriefResult['highlights'] = [];

  if (offlineWithRecentRejects > 0) {
    highlights.push({
      code: 'offline_rejects',
      severity: 'critical',
      message: `${offlineWithRecentRejects} user(s) offline with auth failures in the last 24h`,
      count: offlineWithRecentRejects,
    });
  }
  if (authRejectRate24h >= 15 && authAttempts24h >= 20) {
    highlights.push({
      code: 'high_reject_rate',
      severity: 'warning',
      message: `Auth reject rate is ${authRejectRate24h}% over the last 24h`,
      count: authRejected24h,
    });
  }
  if (quotaExceeded > 0) {
    highlights.push({
      code: 'quota_exceeded',
      severity: 'warning',
      message: `${quotaExceeded} user(s) flagged monthly quota exceeded`,
      count: quotaExceeded,
    });
  }
  if (accountIssues > 0) {
    highlights.push({
      code: 'account_issues',
      severity: 'warning',
      message: `${accountIssues} account(s) suspended, expired, or past expiry date`,
      count: accountIssues,
    });
  }
  if (overdueInvoices > 0) {
    highlights.push({
      code: 'overdue_invoices',
      severity: 'warning',
      message: `${overdueInvoices} external invoice line(s) past pay-due date`,
      count: overdueInvoices,
    });
  }
  if (missingPayDueInvoices > 0) {
    highlights.push({
      code: 'missing_pay_due',
      severity: 'info',
      message: `${missingPayDueInvoices} unpaid invoice line(s) missing pay-due date`,
      count: missingPayDueInvoices,
    });
  }

  const topNas = nasFailureRows[0];
  if (topNas && Number(topNas.failures) >= 10) {
    highlights.push({
      code: 'nas_failures',
      severity: 'warning',
      message: `NAS ${topNas.nasIp} had ${topNas.failures} auth failures in 24h`,
      count: Number(topNas.failures),
    });
  }

  const hasCritical = highlights.some((h) => h.severity === 'critical');
  const hasWarning = highlights.some((h) => h.severity === 'warning');
  const severity: OpsBriefSeverity = hasCritical ? 'critical' : hasWarning ? 'warning' : 'ok';

  const topHighlight = highlights.find((h) => h.severity === 'critical') ?? highlights[0];
  const ruleSummary = topHighlight
    ? topHighlight.message
    : authAttempts24h > 0
      ? `Operations look calm — ${authAttempts24h} auth attempts in 24h with ${authRejectRate24h}% reject rate.`
      : 'No significant issues detected in the last 24 hours.';

  const ai = await maybeEnhanceBriefSummary({
    summary: ruleSummary,
    severity,
    highlights,
    metrics: {
      usersWithRecentRejects: usersWithRecentRejects.length,
      offlineWithRecentRejects,
      quotaExceeded,
      accountIssues,
      overdueInvoices,
      overdueInvoiceAmount,
      missingPayDueInvoices,
      authAttempts24h,
      authRejected24h,
      authRejectRate24h,
    },
  });

  return {
    generatedAt: now.toISOString(),
    severity,
    summary: ai.summary,
    aiEnhanced: ai.aiEnhanced,
    metrics: {
      usersWithRecentRejects: usersWithRecentRejects.length,
      offlineWithRecentRejects,
      quotaExceeded,
      accountIssues,
      overdueInvoices,
      overdueInvoiceAmount,
      missingPayDueInvoices,
      authAttempts24h,
      authRejected24h,
      authRejectRate24h,
    },
    highlights,
    usersWithRecentRejects,
    topNasAuthFailures: nasFailureRows.map((row) => ({
      nasIp: row.nasIp,
      nasLabel: nasLabelMap.get(row.nasIp) ?? row.nasIp,
      failures: Number(row.failures ?? 0),
    })),
    recentRejectUsernames,
  };
}

export async function getRecentRejectUsernames(
  scope?: BriefScope,
  hours = 24
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rs = resellerClause('up', scope);
  const rows = (await AppDataSource.query(
    `
      SELECT cl.username AS username, COUNT(*) AS rejectCount
      FROM connection_logs cl
      INNER JOIN raduserprofile up ON up.username = cl.username
      WHERE cl.username IS NOT NULL
        AND cl.status IN ('rejected', 'timeout', 'error')
        AND cl.timestamp >= ?
        ${rs.sql}
      GROUP BY cl.username
      LIMIT 500
    `,
    [since, ...rs.params]
  )) as Array<{ username: string; rejectCount: string }>;

  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.username) out[row.username] = Number(row.rejectCount ?? 0);
  }
  return out;
}
