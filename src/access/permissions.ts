export const PERMISSIONS = [
  // Sidebar visibility (UI only)
  "ui.sidebar.home.show",
  "ui.sidebar.dashboard.show",
  "ui.sidebar.users.list.show",
  "ui.sidebar.users.online.show",
  "ui.sidebar.users.profiles.show",
  "ui.sidebar.radius.settings.show",
  "ui.sidebar.radius.nas.show",
  "ui.sidebar.billing.invoiceUpload.show",
  "ui.sidebar.billing.externalInvoices.show",
  "ui.sidebar.billing.collections.show",
  "ui.sidebar.cablevision.show",
  "ui.sidebar.admin.analytics.show",
  "ui.sidebar.admin.reports.show",
  "ui.sidebar.admin.alerts.show",
  "ui.sidebar.admin.expenses.show",
  "ui.sidebar.admin.authUsers.show",
  "ui.sidebar.admin.access.show",
  "ui.sidebar.admin.backups.show",
  "ui.sidebar.admin.resellers.show",
  "ui.sidebar.admin.companyWallet.show",
  "ui.sidebar.support.tickets.show",

  // Admin section
  "admin.analytics.view",
  "admin.reports.view",
  "admin.reports.manage",
  "admin.alerts.view",
  "admin.expenses.view",
  "admin.authUsers.manage",
  "admin.access.manage",
  "admin.resellers.manage",
  "admin.resellers.fund",

  // Users section
  "users.view",
  "users.online.view",
  "users.resetDailyQuota",
  "users.resetMonthlyQuota",

  // Radius settings section
  "radius.settings.view",
  "radius.nas.view",
  "radius.profiles.view",

  // Billing section
  "billing.invoiceUpload.create",
  "billing.externalInvoices.view",
  "billing.externalInvoices.viewTotals",
  "billing.externalInvoices.pay",
  "billing.externalInvoices.unpay",
  "billing.externalInvoices.dunning",
  "billing.invoices.pay",
  "billing.collections.view",
  "billing.companyWallet.view",
  "billing.companyWallet.manage",

  // Cable Vision
  "cablevision.accounts.view",
  "cablevision.accounts.manage",
  "cablevision.invoices.view",
  "cablevision.invoices.pay",
  "cablevision.invoices.unpay",
  "cablevision.invoices.generate",

  // Dashboard widgets
  "dashboard.widget.totalAmount",
  "dashboard.widget.invoiceCounts",

  // Support / ticketing
  "support.tickets.view",
  "support.tickets.manage",

  // Reseller portal
  "reseller.portal.access",
  "reseller.balance.view",
  "reseller.users.view",
  "reseller.users.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

