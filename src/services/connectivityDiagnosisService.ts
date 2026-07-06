import { AppDataSource } from '../db/config';
import { ConnectionLogs } from '../db/entities/ConnectionLogs';
import { Raduserprofile } from '../db/entities/Raduserprofile';
import { Radprofile } from '../db/entities/Radprofile';
import { SessionTracking } from '../db/entities/SessionTracking';
import { UserDetails } from '../db/entities/UserDetails';
import { UserMac } from '../db/entities/UserMac';
import { readOnlineSessionConfig, sqlRadacctIsOnline } from '../utils/onlineSessionPolicy';
import { getQuotaUsageForUsers } from '../utils/quotaUsage';
import axios from 'axios';

export type DiagnosisSeverity = 'ok' | 'warning' | 'critical';

export type DiagnosisFinding = {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  evidence?: string;
};

export type DiagnosisAction = {
  action: string;
  description: string;
  priority: number;
  tabHint?: 'actions' | 'sessions' | 'overview';
};

export type ConnectivityDiagnosisResult = {
  username: string;
  generatedAt: string;
  severity: DiagnosisSeverity;
  summary: string;
  findings: DiagnosisFinding[];
  recommendedActions: DiagnosisAction[];
  context: {
    accountStatus: string | null;
    profileName: string | null;
    isOnline: boolean;
    macAddress: string | null;
    expiresAt: string | null;
    isMonthlyExceeded: boolean;
    monthlyUsagePct: number | null;
    recentRejectCount: number;
    lastRejectAt: string | null;
    liveSession: {
      nasIpAddress: string | null;
      framedIpAddress: string | null;
      sessionTimeSeconds: number | null;
    } | null;
  };
  aiEnhanced: boolean;
};

type DiagnosisContext = {
  username: string;
  accountStatus: string | null;
  profileName: string | null;
  isOnline: boolean;
  macAddress: string | null;
  expiresAt: Date | null;
  isMonthlyExceeded: boolean;
  monthlyUsagePct: number | null;
  rejects: Array<{ timestamp: Date | null; status: string | null; nasIp: string | null; macAddress: string | null }>;
  liveSession: Record<string, unknown> | null;
};

async function loadUserContext(
  username: string,
  scope?: { isReseller: boolean; resellerId: number | null }
): Promise<DiagnosisContext | null> {
  const userRepo = AppDataSource.getRepository(Raduserprofile);
  const qb = userRepo
    .createQueryBuilder('user')
    .leftJoinAndMapOne('user.profile', Radprofile, 'profile', 'user.profile_id = profile.id')
    .leftJoinAndMapOne('user.userDetails', UserDetails, 'userDetails', 'user.username = userDetails.username')
    .leftJoinAndMapOne('user.macAddress', UserMac, 'mac', 'user.username = mac.username')
    .where('user.username = :username', { username });

  if (scope?.isReseller && scope.resellerId) {
    qb.andWhere('user.ownerResellerId = :rid', { rid: scope.resellerId });
  }

  const user = await qb.getOne();
  if (!user) return null;

  const profile = (user as any).profile as Radprofile | undefined;
  const mac = (user as any).macAddress as UserMac | undefined;

  const { staleCutoff, activeCutoff } = readOnlineSessionConfig();
  const sessionRepo = AppDataSource.getRepository(SessionTracking);
  const liveQb = sessionRepo
    .createQueryBuilder('session')
    .leftJoin(
      'radacct',
      'ra',
      `ra.acctsessionid = session.session_id AND ${sqlRadacctIsOnline('ra')}`,
      { staleCutoff, activeCutoff }
    )
    .select([
      'session.username AS username',
      'COALESCE(ra.nasipaddress, NULL) AS nasIpAddress',
      'COALESCE(ra.framedipaddress, NULL) AS framedIpAddress',
      'session.sessionTime AS sessionTime',
    ])
    .where('session.status = :status', { status: 'active' })
    .andWhere('session.username = :username', { username })
    .andWhere(
      `EXISTS (
         SELECT 1 FROM radacct ra2
         WHERE ra2.acctsessionid = session.session_id
           AND ${sqlRadacctIsOnline('ra2')}
       )`,
      { staleCutoff, activeCutoff }
    );

  const liveSession = await liveQb.getRawOne<Record<string, unknown>>();

  const rejectRepo = AppDataSource.getRepository(ConnectionLogs);
  const rejects = await rejectRepo
    .createQueryBuilder('cl')
    .select(['cl.timestamp AS timestamp', 'cl.nasIp AS nasIp', 'cl.macAddress AS macAddress', 'cl.status AS status'])
    .where('cl.username = :username', { username })
    .andWhere("cl.status IN ('rejected','timeout','error')")
    .orderBy('cl.timestamp', 'DESC')
    .limit(10)
    .getRawMany<{ timestamp: Date | null; nasIp: string | null; macAddress: string | null; status: string | null }>();

  const onlineCheck = await sessionRepo
    .createQueryBuilder('st')
    .select('COUNT(*)', 'cnt')
    .where('st.username = :username', { username })
    .andWhere("st.status = 'active'")
    .andWhere(
      `EXISTS (
         SELECT 1 FROM radacct ra
         WHERE ra.acctsessionid = st.session_id
           AND ${sqlRadacctIsOnline('ra')}
       )`,
      { staleCutoff, activeCutoff }
    )
    .getRawOne<{ cnt: string }>();

  const isOnline = Number(onlineCheck?.cnt ?? 0) > 0;

  let monthlyUsagePct: number | null = null;
  const monthlyQuota = profile?.monthlyQuota ? BigInt(String(profile.monthlyQuota)) : BigInt(0);
  const usageMap = await getQuotaUsageForUsers([username]);
  const usage = usageMap[username];
  if (monthlyQuota > BigInt(0) && usage?.monthlyUsage != null) {
    monthlyUsagePct = Math.min(
      100,
      Number((usage.monthlyUsage * BigInt(100)) / monthlyQuota)
    );
  }

  return {
    username,
    accountStatus: user.accountStatus ?? null,
    profileName: profile?.profileName ?? null,
    isOnline,
    macAddress: mac?.macAddress ?? null,
    expiresAt: user.expiresAt ? new Date(user.expiresAt) : null,
    isMonthlyExceeded: Boolean(user.isMonthlyExceeded),
    monthlyUsagePct,
    rejects,
    liveSession: liveSession ?? null,
  };
}

function runRuleEngine(ctx: DiagnosisContext): {
  severity: DiagnosisSeverity;
  summary: string;
  findings: DiagnosisFinding[];
  recommendedActions: DiagnosisAction[];
} {
  const findings: DiagnosisFinding[] = [];
  const actions: DiagnosisAction[] = [];
  const status = String(ctx.accountStatus ?? '').toLowerCase();
  const now = new Date();

  if (status === 'suspended') {
    findings.push({
      code: 'account_suspended',
      severity: 'critical',
      message: 'Account is suspended — RADIUS will reject new sessions.',
      evidence: `accountStatus=${status}`,
    });
    actions.push({
      action: 'review_status',
      description: 'Review why the account was suspended; set status to active if the issue is resolved.',
      priority: 1,
      tabHint: 'overview',
    });
  } else if (status === 'terminated' || status === 'expired') {
    findings.push({
      code: 'account_inactive',
      severity: 'critical',
      message: `Account is ${status} — user cannot authenticate.`,
      evidence: `accountStatus=${status}`,
    });
    actions.push({
      action: 'renew_account',
      description: 'Renew subscription or set account status to active with a valid expiry date.',
      priority: 1,
      tabHint: 'overview',
    });
  }

  if (ctx.expiresAt && ctx.expiresAt.getTime() < now.getTime()) {
    findings.push({
      code: 'subscription_expired',
      severity: 'critical',
      message: 'Subscription expiry date is in the past.',
      evidence: ctx.expiresAt.toISOString().slice(0, 10),
    });
    actions.push({
      action: 'extend_expiry',
      description: 'Update expires-at on the Actions tab or renew the customer package.',
      priority: 1,
      tabHint: 'actions',
    });
  }

  if (ctx.isMonthlyExceeded) {
    findings.push({
      code: 'monthly_quota_exceeded',
      severity: 'critical',
      message: 'Monthly data quota is exceeded — user may be throttled or blocked.',
      evidence: ctx.monthlyUsagePct != null ? `${ctx.monthlyUsagePct}% of monthly quota` : undefined,
    });
    actions.push({
      action: 'reset_quota_or_upgrade',
      description: 'Reset monthly quota (if policy allows), upgrade profile, or wait for cycle reset.',
      priority: 2,
      tabHint: 'actions',
    });
  } else if (ctx.monthlyUsagePct != null && ctx.monthlyUsagePct >= 90) {
    findings.push({
      code: 'monthly_quota_near_limit',
      severity: 'warning',
      message: 'Monthly quota is nearly exhausted.',
      evidence: `${ctx.monthlyUsagePct}% used`,
    });
  }

  if (!ctx.macAddress || !String(ctx.macAddress).trim()) {
    findings.push({
      code: 'no_mac_binding',
      severity: 'warning',
      message: 'No MAC address is stored — first-connect binding or wrong CPE MAC can cause rejects.',
    });
    actions.push({
      action: 'reset_mac',
      description: 'If the customer changed router/CPE, reset MAC binding so the next login binds the new device.',
      priority: 3,
      tabHint: 'actions',
    });
  }

  if (ctx.rejects.length > 0) {
    const latest = ctx.rejects[0];
    findings.push({
      code: 'recent_auth_failures',
      severity: 'warning',
      message: `${ctx.rejects.length} recent authentication failure(s) on record.`,
      evidence: latest?.timestamp
        ? `Last ${latest.status} at ${new Date(latest.timestamp).toISOString()} NAS ${latest.nasIp ?? '?'}`
        : undefined,
    });
    actions.push({
      action: 'verify_credentials',
      description: 'Confirm username/password on the CPE match RADIUS; check for wrong VLAN or NAS config.',
      priority: 2,
      tabHint: 'sessions',
    });
  }

  if (ctx.isOnline && ctx.liveSession) {
    findings.push({
      code: 'session_active',
      severity: 'info',
      message: 'User currently has an active RADIUS session.',
      evidence: [
        ctx.liveSession.nasIpAddress ? `NAS ${ctx.liveSession.nasIpAddress}` : null,
        ctx.liveSession.framedIpAddress ? `IP ${ctx.liveSession.framedIpAddress}` : null,
      ]
        .filter(Boolean)
        .join(', ') || undefined,
    });
    actions.push({
      action: 'check_lan_wifi',
      description: 'If customer reports “no internet” while online, troubleshoot LAN/Wi‑Fi or CPE — RADIUS side looks connected.',
      priority: 4,
      tabHint: 'sessions',
    });
  } else if (!findings.some((f) => f.severity === 'critical')) {
    findings.push({
      code: 'currently_offline',
      severity: 'info',
      message: 'No active session right now.',
    });
    if (ctx.rejects.length === 0) {
      actions.push({
        action: 'check_cpe_power',
        description: 'Ask customer to power-cycle CPE/router and verify cable/fiber link; no recent rejects in logs.',
        priority: 3,
      });
    }
  }

  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasWarning = findings.some((f) => f.severity === 'warning');
  const severity: DiagnosisSeverity = hasCritical ? 'critical' : hasWarning ? 'warning' : 'ok';

  const topFinding = findings.find((f) => f.severity === 'critical') ?? findings.find((f) => f.severity === 'warning');
  const summary = topFinding
    ? topFinding.message
    : ctx.isOnline
      ? 'Connection looks healthy from RADIUS — user is online.'
      : 'No blocking issues detected; user is offline with no recent rejects.';

  const dedupedActions = actions
    .sort((a, b) => a.priority - b.priority)
    .filter((a, i, arr) => arr.findIndex((x) => x.action === a.action) === i)
    .slice(0, 5);

  return { severity, summary, findings, recommendedActions: dedupedActions };
}

async function maybeEnhanceSummaryWithAi(
  base: Pick<ConnectivityDiagnosisResult, 'summary' | 'findings' | 'recommendedActions' | 'context'>
): Promise<{ summary: string; aiEnhanced: boolean }> {
  const apiKey = String(process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey || String(process.env.AI_CONNECTIVITY_ENABLED ?? 'true').toLowerCase() === 'false') {
    return { summary: base.summary, aiEnhanced: false };
  }

  const model = String(process.env.OPENAI_MODEL ?? 'gpt-4o-mini').trim();
  try {
    const payload = {
      model,
      temperature: 0.2,
      max_tokens: 220,
      messages: [
        {
          role: 'system',
          content:
            'You are an ISP NOC assistant. Given structured diagnosis JSON, write 2-3 concise sentences for support staff. Do not invent facts. Do not mention passwords. English only.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            summary: base.summary,
            findings: base.findings.map((f) => ({ severity: f.severity, message: f.message })),
            context: base.context,
          }),
        },
      ],
    };
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const text = resp.data?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text.trim()) {
      return { summary: text.trim(), aiEnhanced: true };
    }
  } catch (e) {
    console.warn('[ai] connectivity summary skipped:', (e as Error)?.message ?? e);
  }
  return { summary: base.summary, aiEnhanced: false };
}

export async function diagnoseUserConnectivity(
  username: string,
  scope?: { isReseller: boolean; resellerId: number | null }
): Promise<ConnectivityDiagnosisResult | null> {
  const ctx = await loadUserContext(username, scope);
  if (!ctx) return null;

  const rules = runRuleEngine(ctx);
  const contextOut = {
    accountStatus: ctx.accountStatus,
    profileName: ctx.profileName,
    isOnline: ctx.isOnline,
    macAddress: ctx.macAddress,
    expiresAt: ctx.expiresAt ? ctx.expiresAt.toISOString().slice(0, 10) : null,
    isMonthlyExceeded: ctx.isMonthlyExceeded,
    monthlyUsagePct: ctx.monthlyUsagePct,
    recentRejectCount: ctx.rejects.length,
    lastRejectAt: ctx.rejects[0]?.timestamp ? new Date(ctx.rejects[0].timestamp).toISOString() : null,
    liveSession: ctx.liveSession
      ? {
          nasIpAddress: (ctx.liveSession.nasIpAddress as string) ?? null,
          framedIpAddress: (ctx.liveSession.framedIpAddress as string) ?? null,
          sessionTimeSeconds:
            ctx.liveSession.sessionTime != null ? Number(ctx.liveSession.sessionTime) : null,
        }
      : null,
  };

  const ai = await maybeEnhanceSummaryWithAi({
    summary: rules.summary,
    findings: rules.findings,
    recommendedActions: rules.recommendedActions,
    context: contextOut,
  });

  return {
    username,
    generatedAt: new Date().toISOString(),
    severity: rules.severity,
    summary: ai.summary,
    findings: rules.findings,
    recommendedActions: rules.recommendedActions,
    context: contextOut,
    aiEnhanced: ai.aiEnhanced,
  };
}
