/**
 * Report catalog.
 *
 * Every report reuses an existing service aggregation where one exists, so the
 * numbers on a report always match the numbers on the corresponding screen.
 */
import { AppDataSource } from "../db/config";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { Radprofile } from "../db/entities/Radprofile";
import { UserDetails } from "../db/entities/UserDetails";
import { UserMac } from "../db/entities/UserMac";
import {
  getCollectedMetrics,
  getCollectorBreakdown,
  getExternalInvoicesAgingSummary,
  getExternalInvoicesMonthlyTrend,
  getExternalInvoicesPaymentDueTracker,
} from "../services/invoiceService";
import { getExpenseMonthlyTotals, listExpenses } from "../services/expenseService";
import {
  REPORT_MAX_ROWS,
  type ReportDefinition,
  type ReportDescriptor,
} from "./reportTypes";

/* ── helpers ──────────────────────────────────────────────────────────────── */

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function money(value: number): number {
  return round(Number(value) || 0, 2);
}

/* ── billing ──────────────────────────────────────────────────────────────── */

const revenueMonthly: ReportDefinition = {
  key: "revenue-monthly",
  title: "Monthly revenue & collections",
  description:
    "Billed vs collected amounts per billing month, with the collection rate for each month.",
  category: "billing",
  params: [
    { name: "months", label: "Months to include", type: "number", default: "6" },
  ],
  build: async (params) => {
    const months = Math.min(24, Math.max(1, toInt(params.months, 6)));
    const trend = await getExternalInvoicesMonthlyTrend(months);

    const totalBilled = trend.reduce((sum, row) => sum + row.totalAmount, 0);
    const totalCollected = trend.reduce((sum, row) => sum + row.paidAmount, 0);

    const rows = trend.map((row) => ({
      month: row.month,
      totalCount: row.totalCount,
      paidCount: row.paidCount,
      unpaidCount: row.totalCount - row.paidCount,
      totalAmount: money(row.totalAmount),
      paidAmount: money(row.paidAmount),
      outstandingAmount: money(row.totalAmount - row.paidAmount),
      collectionRate: row.totalAmount > 0 ? round((row.paidAmount / row.totalAmount) * 100, 1) : 0,
    }));

    return {
      key: revenueMonthly.key,
      title: revenueMonthly.title,
      subtitle: `Last ${months} billing month${months === 1 ? "" : "s"}`,
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Months", value: rows.length },
        { label: "Total billed", value: money(totalBilled) },
        { label: "Total collected", value: money(totalCollected) },
        { label: "Outstanding", value: money(totalBilled - totalCollected) },
        {
          label: "Collection rate",
          value: totalBilled > 0 ? `${round((totalCollected / totalBilled) * 100, 1)}%` : "0%",
        },
      ],
      columns: [
        { key: "month", label: "Billing month", width: 16 },
        { key: "totalCount", label: "Invoices", type: "number", width: 12 },
        { key: "paidCount", label: "Paid", type: "number", width: 10 },
        { key: "unpaidCount", label: "Unpaid", type: "number", width: 10 },
        { key: "totalAmount", label: "Billed (USD)", type: "currency", width: 16 },
        { key: "paidAmount", label: "Collected (USD)", type: "currency", width: 18 },
        { key: "outstandingAmount", label: "Outstanding (USD)", type: "currency", width: 18 },
        { key: "collectionRate", label: "Collection rate %", type: "percent", width: 18 },
      ],
      rows,
      totals: {
        totalCount: rows.reduce((sum, row) => sum + row.totalCount, 0),
        paidCount: rows.reduce((sum, row) => sum + row.paidCount, 0),
        unpaidCount: rows.reduce((sum, row) => sum + row.unpaidCount, 0),
        totalAmount: money(totalBilled),
        paidAmount: money(totalCollected),
        outstandingAmount: money(totalBilled - totalCollected),
      },
    };
  },
};

const arAging: ReportDefinition = {
  key: "ar-aging",
  title: "Accounts receivable aging",
  description:
    "Outstanding external invoices grouped into aging buckets, following the same grace period used on the aging screen.",
  category: "billing",
  params: [
    { name: "from", label: "Billing month from", type: "month" },
    { name: "to", label: "Billing month to", type: "month" },
    { name: "graceDays", label: "Grace days", type: "number", default: "7" },
  ],
  build: async (params) => {
    const graceDays = Math.max(0, toInt(params.graceDays, 7));
    const summary = await getExternalInvoicesAgingSummary({
      from: nonEmpty(params.from),
      to: nonEmpty(params.to),
      graceDays,
    });

    const totalAmount = summary.buckets.reduce((sum, bucket) => sum + bucket.amount, 0);

    const rows = summary.buckets.map((bucket) => ({
      bucket: bucket.label,
      count: bucket.count,
      amount: money(bucket.amount),
      share: totalAmount > 0 ? round((bucket.amount / totalAmount) * 100, 1) : 0,
    }));

    return {
      key: arAging.key,
      title: arAging.title,
      subtitle: `Aged as of ${new Date(summary.asOf).toLocaleString()} · ${graceDays} grace day(s)`,
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Open invoices", value: summary.openInvoices },
        { label: "Open amount", value: money(summary.openAmount) },
        { label: "Overdue invoices", value: summary.overdueInvoices },
        { label: "Overdue amount", value: money(summary.overdueAmount) },
        { label: "Overdue rate", value: `${round(summary.overdueRatePercent, 1)}%` },
        { label: "Avg days overdue", value: round(summary.avgDaysOverdue, 1) },
      ],
      columns: [
        { key: "bucket", label: "Aging bucket", width: 18 },
        { key: "count", label: "Invoices", type: "number", width: 12 },
        { key: "amount", label: "Outstanding (USD)", type: "currency", width: 20 },
        { key: "share", label: "Share %", type: "percent", width: 12 },
      ],
      rows,
      totals: {
        count: rows.reduce((sum, row) => sum + row.count, 0),
        amount: money(totalAmount),
      },
    };
  },
};

const arTopDebtors: ReportDefinition = {
  key: "ar-top-debtors",
  title: "Top debtors",
  description: "Subscribers with the largest outstanding external invoice balances.",
  category: "billing",
  params: [
    { name: "from", label: "Billing month from", type: "month" },
    { name: "to", label: "Billing month to", type: "month" },
    { name: "graceDays", label: "Grace days", type: "number", default: "7" },
  ],
  build: async (params) => {
    const graceDays = Math.max(0, toInt(params.graceDays, 7));
    const summary = await getExternalInvoicesAgingSummary({
      from: nonEmpty(params.from),
      to: nonEmpty(params.to),
      graceDays,
    });

    const rows = summary.topDebtors.map((debtor) => ({
      username: debtor.username,
      fullName: debtor.fullName ?? "",
      amount: money(debtor.amount),
      invoices: debtor.invoices,
      maxOverdueDays: debtor.maxOverdueDays,
    }));

    return {
      key: arTopDebtors.key,
      title: arTopDebtors.title,
      subtitle: `Top ${rows.length} by outstanding balance · aged as of ${new Date(summary.asOf).toLocaleString()}`,
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Debtors listed", value: rows.length },
        { label: "Open amount (all)", value: money(summary.openAmount) },
        { label: "Overdue amount (all)", value: money(summary.overdueAmount) },
      ],
      columns: [
        { key: "username", label: "Username", width: 20 },
        { key: "fullName", label: "Full name", width: 26 },
        { key: "amount", label: "Outstanding (USD)", type: "currency", width: 20 },
        { key: "invoices", label: "Open invoices", type: "number", width: 14 },
        { key: "maxOverdueDays", label: "Max days overdue", type: "number", width: 18 },
      ],
      rows,
      totals: {
        amount: money(rows.reduce((sum, row) => sum + row.amount, 0)),
        invoices: rows.reduce((sum, row) => sum + row.invoices, 0),
      },
    };
  },
};

const paymentDue: ReportDefinition = {
  key: "payment-due",
  title: "Payment due tracker",
  description:
    "Open invoices that have a payment target date, with what is still outstanding on each.",
  category: "billing",
  params: [],
  build: async () => {
    const invoices = await getExternalInvoicesPaymentDueTracker();
    const rows = invoices.map((invoice) => {
      // Mirrors the API's own remaining-due rule: billed total minus collected.
      const amount = Number(invoice.totalAmount ?? invoice.amount ?? 0);
      const paid = Number(invoice.amountPaid ?? 0);
      const remaining = amount - paid;
      return {
        id: invoice.id,
        username: invoice.username,
        fullName: invoice.fullName ?? "",
        billingMonth: invoice.billingMonth,
        payDueDate: invoice.payDueDate ?? "",
        status: invoice.status,
        amount: money(amount),
        amountPaid: money(paid),
        remainingDue: money(remaining),
        phoneNumber: invoice.phoneNumber ?? "",
      };
    });

    const totalRemaining = rows.reduce((sum, row) => sum + row.remainingDue, 0);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = rows.filter((row) => row.payDueDate && row.payDueDate < today);

    return {
      key: paymentDue.key,
      title: paymentDue.title,
      subtitle: `${rows.length} open invoice(s) with a payment target date`,
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Invoices", value: rows.length },
        { label: "Past due date", value: overdue.length },
        { label: "Remaining due", value: money(totalRemaining) },
      ],
      columns: [
        { key: "id", label: "Invoice #", type: "number", width: 12 },
        { key: "username", label: "Username", width: 20 },
        { key: "fullName", label: "Full name", width: 26 },
        { key: "billingMonth", label: "Billing month", width: 16 },
        { key: "payDueDate", label: "Due date", type: "date", width: 14 },
        { key: "status", label: "Status", width: 12 },
        { key: "amount", label: "Amount (USD)", type: "currency", width: 16 },
        { key: "amountPaid", label: "Paid (USD)", type: "currency", width: 16 },
        { key: "remainingDue", label: "Remaining (USD)", type: "currency", width: 18 },
        { key: "phoneNumber", label: "Phone", width: 18 },
      ],
      rows,
      totals: {
        amount: money(rows.reduce((sum, row) => sum + row.amount, 0)),
        amountPaid: money(rows.reduce((sum, row) => sum + row.amountPaid, 0)),
        remainingDue: money(totalRemaining),
      },
    };
  },
};

/* ── collections ──────────────────────────────────────────────────────────── */

const collectionsByCollector: ReportDefinition = {
  key: "collections-by-collector",
  title: "Collections by collector",
  description:
    "Field collection totals per collector for a date range, with cash reconciliation context.",
  category: "collections",
  params: [
    { name: "from", label: "Collected from", type: "date" },
    { name: "to", label: "Collected to", type: "date" },
  ],
  build: async (params) => {
    const from = nonEmpty(params.from);
    const to = nonEmpty(params.to);

    const [breakdown, metrics] = await Promise.all([
      getCollectorBreakdown(from, to),
      getCollectedMetrics(from, to),
    ]);

    const rows = breakdown.map((entry) => ({
      collector: entry.collector,
      count: entry.count,
      totalAmount: money(entry.totalAmount),
      averageAmount: entry.count > 0 ? money(entry.totalAmount / entry.count) : 0,
      share: metrics.totalCashCollected > 0
        ? round((entry.totalAmount / metrics.totalCashCollected) * 100, 1)
        : 0,
    }));

    const rangeLabel = from || to ? `${from ?? "start"} → ${to ?? "today"}` : "All time";

    return {
      key: collectionsByCollector.key,
      title: collectionsByCollector.title,
      subtitle: rangeLabel,
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Collectors", value: rows.length },
        { label: "Collected invoices", value: metrics.totalCollectedInvoices },
        { label: "Total collected", value: money(metrics.totalCashCollected) },
      ],
      columns: [
        { key: "collector", label: "Collector", width: 22 },
        { key: "count", label: "Invoices", type: "number", width: 12 },
        { key: "totalAmount", label: "Collected (USD)", type: "currency", width: 20 },
        { key: "averageAmount", label: "Average (USD)", type: "currency", width: 18 },
        { key: "share", label: "Share %", type: "percent", width: 12 },
      ],
      rows,
      totals: {
        count: rows.reduce((sum, row) => sum + row.count, 0),
        totalAmount: money(rows.reduce((sum, row) => sum + row.totalAmount, 0)),
      },
    };
  },
};

/* ── expenses ─────────────────────────────────────────────────────────────── */

const expensesMonthly: ReportDefinition = {
  key: "expenses-monthly",
  title: "Monthly expenses",
  description: "Operational expenses totalled per month and currency.",
  category: "expenses",
  params: [
    { name: "from", label: "Expense date from", type: "date" },
    { name: "to", label: "Expense date to", type: "date" },
  ],
  build: async (params) => {
    const dateFrom = nonEmpty(params.from);
    const dateTo = nonEmpty(params.to);
    const totals = await getExpenseMonthlyTotals({ dateFrom, dateTo });

    const rows = totals.map((entry) => ({
      month: entry.month,
      currency: entry.currency,
      totalAmount: money(entry.totalAmount),
    }));

    return {
      key: expensesMonthly.key,
      title: expensesMonthly.title,
      subtitle: dateFrom || dateTo ? `${dateFrom ?? "start"} → ${dateTo ?? "today"}` : "All time",
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Months", value: rows.length },
        { label: "Total expenses", value: money(rows.reduce((sum, row) => sum + row.totalAmount, 0)) },
      ],
      columns: [
        { key: "month", label: "Month", width: 14 },
        { key: "currency", label: "Currency", width: 10 },
        { key: "totalAmount", label: "Amount", type: "currency", width: 18 },
      ],
      rows,
      totals: { totalAmount: money(rows.reduce((sum, row) => sum + row.totalAmount, 0)) },
    };
  },
};

const expensesDetail: ReportDefinition = {
  key: "expenses-detail",
  title: "Expense detail",
  description: "Line-by-line operational expenses with category, status, and audit fields.",
  category: "expenses",
  params: [
    { name: "from", label: "Expense date from", type: "date" },
    { name: "to", label: "Expense date to", type: "date" },
    {
      name: "status",
      label: "Status",
      type: "select",
      default: "",
      options: [
        { value: "", label: "All statuses" },
        { value: "paid", label: "Paid" },
        { value: "unpaid", label: "Unpaid" },
      ],
    },
    { name: "category", label: "Category", type: "text" },
  ],
  build: async (params) => {
    const dateFrom = nonEmpty(params.from);
    const dateTo = nonEmpty(params.to);
    const status = nonEmpty(params.status) as "paid" | "unpaid" | undefined;

    const result = await listExpenses({
      page: 1,
      limit: REPORT_MAX_ROWS + 1,
      dateFrom,
      dateTo,
      status,
      category: nonEmpty(params.category),
    });

    const truncated = result.data.length > REPORT_MAX_ROWS;
    const visible = truncated ? result.data.slice(0, REPORT_MAX_ROWS) : result.data;

    const rows = visible.map((expense) => ({
      id: expense.id,
      expenseDate: expense.expenseDate,
      title: expense.title,
      category: expense.category ?? "",
      amount: money(Number(expense.amount)),
      currency: expense.currency,
      status: expense.status,
      notes: expense.notes ?? "",
      createdBy: expense.createdBy ?? "",
    }));

    return {
      key: expensesDetail.key,
      title: expensesDetail.title,
      subtitle: dateFrom || dateTo ? `${dateFrom ?? "start"} → ${dateTo ?? "today"}` : "All time",
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Expenses", value: result.total },
        { label: "Rows exported", value: rows.length },
        { label: "Total amount", value: money(rows.reduce((sum, row) => sum + row.amount, 0)) },
        ...(truncated
          ? [{ label: "Note", value: `Capped at ${REPORT_MAX_ROWS.toLocaleString()} rows` }]
          : []),
      ],
      columns: [
        { key: "id", label: "ID", type: "number", width: 10 },
        { key: "expenseDate", label: "Date", type: "date", width: 14 },
        { key: "title", label: "Title", width: 30 },
        { key: "category", label: "Category", width: 18 },
        { key: "amount", label: "Amount", type: "currency", width: 16 },
        { key: "currency", label: "Currency", width: 10 },
        { key: "status", label: "Status", width: 12 },
        { key: "createdBy", label: "Created by", width: 18 },
        { key: "notes", label: "Notes", width: 32 },
      ],
      rows,
      totals: { amount: money(rows.reduce((sum, row) => sum + row.amount, 0)) },
    };
  },
};

/* ── subscribers ──────────────────────────────────────────────────────────── */

const subscriberFleet: ReportDefinition = {
  key: "subscriber-fleet",
  title: "Subscriber fleet snapshot",
  description:
    "Every subscriber with profile, account status, expiry, and contact details — for reconciliation and field work.",
  category: "subscribers",
  params: [
    {
      name: "status",
      label: "Account status",
      type: "select",
      default: "",
      options: [
        { value: "", label: "All statuses" },
        { value: "active", label: "Active" },
        { value: "expired", label: "Expired" },
        { value: "suspended", label: "Suspended" },
        { value: "blocked", label: "Blocked" },
        { value: "terminated", label: "Terminated" },
      ],
    },
    {
      name: "expiringWithinDays",
      label: "Expiring within (days)",
      type: "number",
      help: "Leave blank to ignore expiry.",
    },
  ],
  build: async (params) => {
    const status = nonEmpty(params.status);
    const expiringDays = nonEmpty(params.expiringWithinDays);

    const qb = AppDataSource.getRepository(Raduserprofile)
      .createQueryBuilder("up")
      .leftJoin(Radprofile, "p", "up.profile_id = p.id")
      .leftJoin(UserDetails, "d", "up.username = d.username")
      .leftJoin(UserMac, "m", "up.username = m.username")
      .select("up.username", "username")
      .addSelect("d.full_name", "fullName")
      .addSelect("p.profile_name", "profileName")
      .addSelect("up.account_status", "accountStatus")
      .addSelect("up.expires_at", "expiresAt")
      .addSelect("d.phone_number", "phoneNumber")
      .addSelect("d.email", "email")
      .addSelect("m.mac_address", "macAddress");

    if (status) qb.andWhere("up.account_status = :status", { status });

    if (expiringDays) {
      const days = Math.max(0, toInt(expiringDays, 0));
      if (days > 0) {
        qb.andWhere(
          "up.expires_at IS NOT NULL AND up.expires_at >= NOW() AND up.expires_at <= DATE_ADD(NOW(), INTERVAL :days DAY)",
          { days }
        );
      }
    }

    qb.orderBy("up.username", "ASC").limit(REPORT_MAX_ROWS + 1);

    const raw = await qb.getRawMany<{
      username: string;
      fullName: string | null;
      profileName: string | null;
      accountStatus: string | null;
      expiresAt: Date | string | null;
      phoneNumber: string | null;
      email: string | null;
      macAddress: string | null;
    }>();

    const truncated = raw.length > REPORT_MAX_ROWS;
    const visible = truncated ? raw.slice(0, REPORT_MAX_ROWS) : raw;

    const today = Date.now();
    const rows = visible.map((row) => {
      const expires = row.expiresAt ? new Date(row.expiresAt) : null;
      const daysToExpiry =
        expires && !Number.isNaN(expires.getTime())
          ? Math.ceil((expires.getTime() - today) / 86_400_000)
          : null;
      return {
        username: row.username,
        fullName: row.fullName ?? "",
        profileName: row.profileName ?? "",
        accountStatus: row.accountStatus ?? "",
        expiresAt: row.expiresAt ?? "",
        daysToExpiry: daysToExpiry ?? "",
        phoneNumber: row.phoneNumber ?? "",
        email: row.email ?? "",
        macAddress: row.macAddress ?? "",
      };
    });

    const expired = rows.filter((row) => row.daysToExpiry !== "" && Number(row.daysToExpiry) < 0);

    return {
      key: subscriberFleet.key,
      title: subscriberFleet.title,
      subtitle: [
        status ? `Status: ${status}` : "All statuses",
        expiringDays ? `Expiring within ${expiringDays} day(s)` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      generatedAt: new Date().toISOString(),
      summary: [
        { label: "Subscribers", value: rows.length },
        { label: "Past expiry", value: expired.length },
        ...(truncated
          ? [{ label: "Note", value: `Capped at ${REPORT_MAX_ROWS.toLocaleString()} rows` }]
          : []),
      ],
      columns: [
        { key: "username", label: "Username", width: 20 },
        { key: "fullName", label: "Full name", width: 26 },
        { key: "profileName", label: "Profile", width: 18 },
        { key: "accountStatus", label: "Status", width: 14 },
        { key: "expiresAt", label: "Expires at", type: "date", width: 14 },
        { key: "daysToExpiry", label: "Days to expiry", type: "number", width: 16 },
        { key: "phoneNumber", label: "Phone", width: 18 },
        { key: "email", label: "Email", width: 28 },
        { key: "macAddress", label: "MAC", width: 20 },
      ],
      rows,
    };
  },
};

/* ── catalog ──────────────────────────────────────────────────────────────── */

const REPORT_DEFINITIONS: ReportDefinition[] = [
  revenueMonthly,
  arAging,
  arTopDebtors,
  paymentDue,
  collectionsByCollector,
  expensesMonthly,
  expensesDetail,
  subscriberFleet,
];

const REPORTS_BY_KEY = new Map(REPORT_DEFINITIONS.map((report) => [report.key, report]));

export function getReportDefinition(key: string): ReportDefinition | undefined {
  return REPORTS_BY_KEY.get(key);
}

export function listReportDefinitions(): ReportDescriptor[] {
  return REPORT_DEFINITIONS.map(({ key, title, description, category, params }) => ({
    key,
    title,
    description,
    category,
    params,
  }));
}
