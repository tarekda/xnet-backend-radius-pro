// src/routes/invoice.routes.ts
import { Router } from "express";
import { bulkPayInvoicesHandler, bulkDeleteExternalInvoicesHandler, bulkUpdateExternalInvoicesHandler, createExternalInvoiceDebitHandler, deleteExternalInvoiceHandler, generateInvoicesHandler, getExternalDunningPreviewHandler, getExternalInvoiceHistoryHandler, getExternalInvoicePaymentLinesHandler, getExternalInvoicesAgingSummaryHandler, getExternalInvoicesHandler, getExternalInvoicesPaymentDueHandler, getExternalInvoicesTrendHandler, getInvoicesHandler, payExternalInvoiceHandler, unpayExternalInvoiceHandler, payInvoiceHandler, runExternalDunningHandler, setExternalInvoiceWorkflowHandler, updateExternalInvoiceHandler, uploadExternalInvoiceFile, previewExternalInvoiceFile, collectInvoiceHandler, reconcileBulkCashHandler, reconcileInvoiceCashHandler, getCollectedMetricsHandler, getCollectorBreakdownHandler, getCollectedInvoicesListHandler, remindExternalInvoiceHandler, getWhatsAppDiagnosticsHandler } from "../controllers/invoiceController";
import multer from "multer";
import { authenticateToken, authorizeAnyPermissions, authorizePermissions, authorizeRoles } from '../middleware/authMiddleware';
const upload = multer({ dest: "uploads/" }); // temp folder

const router = Router();
router.post("/generate-monthly", generateInvoicesHandler);
router.get("/", getInvoicesHandler);
// Add route for paying a single invoice
router.post("/pay/:invoiceId", authenticateToken, authorizeRoles('admin','manager','support','collector'), payInvoiceHandler);
router.post("/collect/:invoiceId", authenticateToken, authorizeRoles('collector','manager','admin'), collectInvoiceHandler);
// IMPORTANT: define /reconcile/bulk before /reconcile/:invoiceId
router.post("/reconcile/bulk", authenticateToken, authorizeRoles('collector','manager','admin'), reconcileBulkCashHandler);
router.post("/reconcile/:invoiceId", authenticateToken, authorizeRoles('collector','manager','admin'), reconcileInvoiceCashHandler);
// Add route for bulk paying invoices
router.post("/bulk-pay", authenticateToken, authorizeRoles('admin','manager'), bulkPayInvoicesHandler);
router.post("/upload/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), upload.single("file"), previewExternalInvoiceFile);
router.post("/upload", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), upload.single("file"), uploadExternalInvoiceFile);
router.get(
  "/whatsapp/diagnostics",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getWhatsAppDiagnosticsHandler
);
router.get(
  "/external",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getExternalInvoicesHandler
);
router.get(
  "/external/aging-summary",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getExternalInvoicesAgingSummaryHandler
);
router.get(
  "/external/trend",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getExternalInvoicesTrendHandler
);
router.get(
  "/external/payment-due",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getExternalInvoicesPaymentDueHandler
);
router.get(
  "/external/:invoiceId/history",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getExternalInvoiceHistoryHandler
);
router.post(
  "/external/pay/:invoiceId",
  authenticateToken,
  authorizePermissions('billing.externalInvoices.pay'),
  payExternalInvoiceHandler
);
router.post("/external/unpay/:invoiceId", authenticateToken, authorizePermissions('billing.externalInvoices.unpay'), unpayExternalInvoiceHandler);
router.post(
  "/external/:invoiceId/remind",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  remindExternalInvoiceHandler
);
router.post(
  "/external/:invoiceId/workflow",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  setExternalInvoiceWorkflowHandler
);
router.get(
  "/external/dunning/preview",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay"
  ),
  getExternalDunningPreviewHandler
);
router.post(
  "/external/dunning/run",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay"
  ),
  runExternalDunningHandler
);
router.put("/external/:invoiceId",authenticateToken, updateExternalInvoiceHandler);
router.delete("/external/:invoiceId", authenticateToken,deleteExternalInvoiceHandler);
router.post("/external/bulk-delete", authenticateToken, authorizeRoles('admin','manager'), bulkDeleteExternalInvoicesHandler);
router.get(
  "/external/payment-lines",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getExternalInvoicePaymentLinesHandler
);
router.post(
  "/external/debit",
  authenticateToken,
  authorizeRoles('admin', 'manager'),
  createExternalInvoiceDebitHandler
);
router.post("/external/bulk-update", authenticateToken, authorizeRoles('admin','manager'), bulkUpdateExternalInvoicesHandler);

// Collected metrics & drilldowns
router.get('/collected/metrics', authenticateToken, authorizeRoles('admin','manager','support','collector'), getCollectedMetricsHandler);
router.get('/collected/breakdown', authenticateToken, authorizeRoles('admin','manager','support'), getCollectorBreakdownHandler);
router.get('/collected/list', authenticateToken, authorizeRoles('admin','manager','support','collector'), getCollectedInvoicesListHandler);

export default router;
