export const ALERT_METRIC_TYPES = [
  "users",
  "bandwidth",
  "auth_success_rate",
  "auth_failed_attempts",
  "cpu_usage",
  "memory_usage",
  "disk_usage",
] as const;

export type AlertMetricType = (typeof ALERT_METRIC_TYPES)[number];

export const ALERT_CONDITIONS = [
  "greater_than",
  "less_than",
  "equals",
  "not_equals",
  "percentage_change",
] as const;

export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export const ALERT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export type AlertMetricObject = {
  type: string;
  label: string;
  unit: string;
  description: string;
};

export const ALERT_METRICS: AlertMetricObject[] = [
  {
    type: "users",
    label: "Active Users",
    unit: "users",
    description: "Number of currently active users",
  },
  {
    type: "bandwidth",
    label: "Bandwidth Usage",
    unit: "MB/s",
    description: "Current bandwidth consumption",
  },
  {
    type: "auth_success_rate",
    label: "Authentication Success Rate",
    unit: "%",
    description: "Percentage of successful authentication attempts",
  },
  {
    type: "auth_failed_attempts",
    label: "Failed Authentication Attempts",
    unit: "attempts",
    description: "Number of failed authentication attempts",
  },
  {
    type: "cpu_usage",
    label: "CPU Usage",
    unit: "%",
    description: "Current CPU utilization",
  },
  {
    type: "memory_usage",
    label: "Memory Usage",
    unit: "%",
    description: "Current memory utilization",
  },
  {
    type: "disk_usage",
    label: "Disk Usage",
    unit: "%",
    description: "Current disk space utilization",
  },
];

const METRIC_BY_TYPE = new Map(ALERT_METRICS.map((m) => [m.type, m]));

export function isAlertMetricType(value: string): value is AlertMetricType {
  return (ALERT_METRIC_TYPES as readonly string[]).includes(value);
}

export function isAlertCondition(value: string): value is AlertCondition {
  return (ALERT_CONDITIONS as readonly string[]).includes(value);
}

export function isAlertSeverity(value: string): value is AlertSeverity {
  return (ALERT_SEVERITIES as readonly string[]).includes(value);
}

/** Accepts the frontend metric object or a stored type string. */
export function parseMetricType(input: unknown): AlertMetricType | null {
  if (typeof input === "string") {
    const t = input.trim();
    return isAlertMetricType(t) ? t : null;
  }
  if (input && typeof input === "object" && "type" in input) {
    const t = String((input as { type?: unknown }).type ?? "").trim();
    return isAlertMetricType(t) ? t : null;
  }
  return null;
}

export function toMetricObject(type: string): AlertMetricObject {
  const known = isAlertMetricType(type) ? METRIC_BY_TYPE.get(type) : undefined;
  if (known) return known;
  return {
    type: type || "unknown",
    label: type || "Unknown",
    unit: "",
    description: "",
  };
}

export function evaluateCondition(
  condition: string,
  value: number,
  threshold: number
): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  switch (condition) {
    case "greater_than":
      return value > threshold;
    case "less_than":
      return value < threshold;
    case "equals":
      return value === threshold;
    case "not_equals":
      return value !== threshold;
    case "percentage_change":
      return false;
    default:
      return false;
  }
}

export function formatAlertMessage(
  metricType: string,
  value: number,
  threshold: number,
  condition: string
): string {
  const metric = toMetricObject(metricType);
  const verb =
    condition === "less_than"
      ? "dropped below"
      : condition === "equals"
        ? "equals"
        : condition === "not_equals"
          ? "does not equal"
          : "exceeded";
  const formatNum = (n: number) =>
    metric.unit === "%" ? String(n) : n.toLocaleString();
  return `${metric.label} (${formatNum(value)}${metric.unit ? (metric.unit === "%" ? "%" : "") : ""}) ${verb} threshold (${formatNum(threshold)}${metric.unit === "%" ? "%" : ""})`;
}

export type AlertSettingsPayload = {
  emailNotifications: boolean;
  smsNotifications: boolean;
  webhookNotifications: boolean;
  inAppNotifications: boolean;
  emailRecipients: string[];
  smsRecipients: string[];
  webhookUrl?: string;
  quietHours: {
    enabled: boolean;
    startTime: string;
    endTime: string;
    timezone: string;
  };
  escalationPolicy: {
    enabled: boolean;
    escalationDelay: number;
    maxEscalations: number;
  };
};

export const DEFAULT_ALERT_SETTINGS: AlertSettingsPayload = {
  emailNotifications: false,
  smsNotifications: false,
  webhookNotifications: false,
  inAppNotifications: true,
  emailRecipients: [],
  smsRecipients: [],
  quietHours: {
    enabled: false,
    startTime: "22:00",
    endTime: "08:00",
    timezone: "UTC",
  },
  escalationPolicy: {
    enabled: false,
    escalationDelay: 30,
    maxEscalations: 3,
  },
};

export function mergeAlertSettings(
  current: AlertSettingsPayload,
  updates: Partial<AlertSettingsPayload>
): AlertSettingsPayload {
  return {
    ...current,
    ...updates,
    emailRecipients: Array.isArray(updates.emailRecipients)
      ? updates.emailRecipients.map(String)
      : current.emailRecipients,
    smsRecipients: Array.isArray(updates.smsRecipients)
      ? updates.smsRecipients.map(String)
      : current.smsRecipients,
    quietHours: {
      ...current.quietHours,
      ...(updates.quietHours || {}),
    },
    escalationPolicy: {
      ...current.escalationPolicy,
      ...(updates.escalationPolicy || {}),
    },
  };
}
