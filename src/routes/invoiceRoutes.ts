// src/routes/invoice.routes.ts
import { Router } from "express";
import { bulkPayInvoicesHandler, bulkDeleteExternalInvoicesHandler, bulkUpdateExternalInvoicesHandler, createExternalInvoiceDebitHandler, deleteExternalInvoiceHandler, generateInvoicesHandler, getExternalDunningPreviewHandler, getExternalInvoiceByIdHandler, getExternalInvoiceHistoryHandler, getExternalInvoicePaymentLinesHandler, getExternalInvoicesAgingSummaryHandler, getExternalInvoicesHandler, getExternalInvoicesPaymentDueHandler, getExternalInvoicesTrendHandler, getInvoicesHandler, getProviderMacListHandler, getProviderMacOptionsHandler, syncProviderMacAddressesHandler, payExternalInvoiceHandler, unpayExternalInvoiceHandler, payInvoiceHandler, runExternalDunningHandler, setExternalInvoiceWorkflowHandler, sharePaidExternalInvoiceHandler, updateExternalInvoiceHandler, uploadExternalInvoiceFile, previewExternalInvoiceFile, collectInvoiceHandler, reconcileBulkCashHandler, reconcileInvoiceCashHandler, getCollectedMetricsHandler, getCollectorBreakdownHandler, getCollectedInvoicesListHandler, remindExternalInvoiceHandler, emailExternalInvoiceHandler, getWhatsAppDiagnosticsHandler, getSubscriberDunningEnforcementHandler, restoreSubscriberLineHandler, previewMyISPInvoicesHandler, importMyISPInvoicesHandler, previewMyISP2InvoicesHandler, importMyISP2InvoicesHandler, previewRadiusInvoicesHandler, importRadiusInvoicesHandler, previewIDMInvoicesHandler, importIDMInvoicesHandler, previewTerraInvoicesHandler, importTerraInvoicesHandler, previewTerra2InvoicesHandler, importTerra2InvoicesHandler, previewMispInvoicesHandler, importMispInvoicesHandler } from "../controllers/invoiceController";
import {
  dismissWhatsappPaymentAmbiguityHandler,
  listWhatsappPaymentAmbiguitiesHandler,
  resolveWhatsappPaymentAmbiguityHandler,
} from "../controllers/whatsappPaymentAmbiguityController";
import {
  getInboundWhatsAppMessagesHandler,
  retryInboundWhatsAppMessageHandler,
  resolveInboundWhatsAppMessageHandler,
} from "../controllers/whatsappInboundController";
import {
  uploadAndScanReceiptHandler,
  confirmReceiptReconciliationHandler,
} from "../controllers/receiptUploadController";
import { simulateInboundAgentMessageHandler } from "../controllers/whatsappWebhookController";
import fs from "fs";
import path from "path";
import multer from "multer";
import { authenticateToken, authorizeAnyPermissions, authorizePermissions, authorizeRoles } from '../middleware/authMiddleware';
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: Number(process.env.INVOICE_UPLOAD_MAX_BYTES || 10 * 1024 * 1024), // 10MB
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    const ok =
      name.endsWith(".xlsx") ||
      name.endsWith(".xls") ||
      name.endsWith(".csv") ||
      file.mimetype.includes("spreadsheet") ||
      file.mimetype.includes("excel") ||
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (!ok) {
      cb(new Error("Only Excel/CSV invoice files are allowed"));
      return;
    }
    cb(null, true);
  },
});

const receiptStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), "uploads", "receipts");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `receipt-${uniqueSuffix}${ext}`);
  },
});
const uploadReceipt = multer({
  storage: receiptStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only image files or PDFs are allowed for receipts"));
    }
  },
});

const router = Router();
router.post(
  "/generate-monthly",
  authenticateToken,
  authorizeRoles("admin", "manager"),
  generateInvoicesHandler
);
router.get(
  "/",
  authenticateToken,
  authorizeRoles("admin", "manager", "support", "collector"),
  getInvoicesHandler
);
// Add route for paying a single invoice
// Settling money needs both the role and the explicit permission, so a deny
// override on a single user is honoured.
router.post("/pay/:invoiceId", authenticateToken, authorizeRoles('admin','manager','support','collector'), authorizePermissions('billing.invoices.pay'), payInvoiceHandler);
router.post("/collect/:invoiceId", authenticateToken, authorizeRoles('collector','manager','admin'), authorizePermissions('billing.invoices.pay'), collectInvoiceHandler);
// IMPORTANT: define /reconcile/bulk before /reconcile/:invoiceId
router.post("/reconcile/bulk", authenticateToken, authorizeRoles('collector','manager','admin'), authorizePermissions('billing.invoices.pay'), reconcileBulkCashHandler);
router.post("/reconcile/:invoiceId", authenticateToken, authorizeRoles('collector','manager','admin'), authorizePermissions('billing.invoices.pay'), reconcileInvoiceCashHandler);
// Add route for bulk paying invoices
router.post("/bulk-pay", authenticateToken, authorizeRoles('admin','manager'), authorizePermissions('billing.invoices.pay'), bulkPayInvoicesHandler);
router.post("/upload/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), upload.single("file"), previewExternalInvoiceFile);
router.post("/upload", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), upload.single("file"), uploadExternalInvoiceFile);
router.post("/myisp/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), previewMyISPInvoicesHandler);
router.post("/myisp/import", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), importMyISPInvoicesHandler);
router.post("/myisp2/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), previewMyISP2InvoicesHandler);
router.post("/myisp2/import", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), importMyISP2InvoicesHandler);
router.post("/radius/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), previewRadiusInvoicesHandler);
router.post("/radius/import", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), importRadiusInvoicesHandler);
router.post("/idm/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), previewIDMInvoicesHandler);
router.post("/idm/import", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), importIDMInvoicesHandler);
router.post("/terra/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), previewTerraInvoicesHandler);
router.post("/terra/import", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), importTerraInvoicesHandler);
router.post("/terra2/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), previewTerra2InvoicesHandler);
router.post("/terra2/import", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), importTerra2InvoicesHandler);
router.post("/misp/preview", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), previewMispInvoicesHandler);
router.post("/misp/import", authenticateToken, authorizePermissions('billing.invoiceUpload.create'), importMispInvoicesHandler);
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
  "/external/provider-macs/providers",
  authenticateToken,
  authorizePermissions("billing.invoiceUpload.create"),
  authorizePermissions("users.view"),
  getProviderMacOptionsHandler
);
router.get(
  "/external/provider-macs",
  authenticateToken,
  authorizePermissions("billing.invoiceUpload.create"),
  authorizePermissions("users.view"),
  getProviderMacListHandler
);
router.post(
  "/external/provider-macs/sync",
  authenticateToken,
  authorizePermissions("billing.invoiceUpload.create"),
  authorizePermissions("users.view"),
  syncProviderMacAddressesHandler
);
router.get(
  "/external/whatsapp-payment-ambiguities",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.pay"
  ),
  listWhatsappPaymentAmbiguitiesHandler
);
router.post(
  "/external/whatsapp-payment-ambiguities/:ambiguityId/resolve",
  authenticateToken,
  authorizePermissions("billing.externalInvoices.pay"),
  resolveWhatsappPaymentAmbiguityHandler
);
router.post(
  "/external/whatsapp-payment-ambiguities/:ambiguityId/dismiss",
  authenticateToken,
  authorizePermissions("billing.externalInvoices.pay"),
  dismissWhatsappPaymentAmbiguityHandler
);
router.get(
  "/external/whatsapp-inbound-messages",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.pay"
  ),
  getInboundWhatsAppMessagesHandler
);
router.post(
  "/external/whatsapp-inbound-messages/:id/retry",
  authenticateToken,
  authorizePermissions("billing.externalInvoices.pay"),
  retryInboundWhatsAppMessageHandler
);
router.post(
  "/external/whatsapp-inbound-messages/:id/resolve",
  authenticateToken,
  authorizePermissions("billing.externalInvoices.pay"),
  resolveInboundWhatsAppMessageHandler
);
router.post(
  "/external/whatsapp/simulate",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.pay"
  ),
  simulateInboundAgentMessageHandler
);
router.post(
  "/external/receipt-ocr/upload-test",
  authenticateToken,
  authorizePermissions("billing.externalInvoices.pay"),
  uploadReceipt.single("receipt"),
  uploadAndScanReceiptHandler
);
router.post(
  "/external/receipt-ocr/confirm",
  authenticateToken,
  authorizePermissions("billing.externalInvoices.pay"),
  confirmReceiptReconciliationHandler
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
  "/external/:invoiceId/email",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  emailExternalInvoiceHandler
);
router.post(
  "/external/:invoiceId/share-paid",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  sharePaidExternalInvoiceHandler
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
  authorizePermissions("billing.externalInvoices.dunning"),
  runExternalDunningHandler
);
router.get(
  "/external/dunning/subscriber-state/:username",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.dunning",
    "users.view"
  ),
  getSubscriberDunningEnforcementHandler
);
router.post(
  "/external/dunning/restore-line/:username",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.pay",
    "billing.externalInvoices.dunning",
    "users.edit"
  ),
  restoreSubscriberLineHandler
);
router.put(
  "/external/:invoiceId",
  authenticateToken,
  authorizeRoles("admin", "manager"),
  updateExternalInvoiceHandler
);
router.delete(
  "/external/:invoiceId",
  authenticateToken,
  authorizeRoles("admin", "manager"),
  deleteExternalInvoiceHandler
);
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
router.get(
  "/external/trend",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "admin.analytics.view"
  ),
  getExternalInvoicesTrendHandler
);
router.get(
  "/external/aging-summary",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "admin.analytics.view"
  ),
  getExternalInvoicesAgingSummaryHandler
);
router.get(
  "/external/:invoiceId",
  authenticateToken,
  authorizeAnyPermissions(
    "billing.externalInvoices.view",
    "billing.externalInvoices.viewTotals",
    "billing.externalInvoices.pay",
    "billing.externalInvoices.unpay"
  ),
  getExternalInvoiceByIdHandler
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
