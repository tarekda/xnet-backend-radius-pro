import { Request, RequestHandler } from "express";
import fs from "fs";
import path from "path";
import {
  performOcrOnImage,
  parseReceiptOcrText,
  matchReceiptWithInvoices,
  ExtractedReceiptData,
} from "../services/whatsappReceiptOcrService";
import { AppDataSource } from "../db/config";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { WhatsappInboundMessage } from "../db/entities/WhatsappInboundMessage";
import { payExternalInvoicesFromWhatsAppInbound } from "../services/whatsappInboundPayService";

/**
 * Handle receipt image upload, OCR extraction, and auto-matching candidate invoices.
 */
export const uploadAndScanReceiptHandler: RequestHandler = async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ ok: false, error: "No image file provided." });
    return;
  }

  const filePath = file.path;
  try {
    // 1. Run OCR
    const rawOcrText = await performOcrOnImage(filePath);

    // 2. Parse structured receipt data
    const extracted = parseReceiptOcrText(rawOcrText);

    // 3. Match against unpaid external invoices
    const matchResult = await matchReceiptWithInvoices(extracted);

    // Provide relative URL to access uploaded receipt image
    const relativeUrl = `/uploads/receipts/${path.basename(filePath)}`;

    res.json({
      ok: true,
      data: {
        rawOcrText,
        extracted,
        matchResult,
        mediaUrl: relativeUrl,
      },
    });
  } catch (err: any) {
    console.error("[receipt-ocr] scan error:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to process receipt image OCR.",
    });
  }
};

/**
 * Confirm and apply receipt reconciliation against a chosen invoice.
 */
export const confirmReceiptReconciliationHandler: RequestHandler = async (req: Request, res) => {
  const { invoiceId, receiptData, mediaUrl } = req.body as {
    invoiceId: number;
    receiptData: ExtractedReceiptData;
    mediaUrl?: string;
  };

  if (!invoiceId) {
    res.status(400).json({ ok: false, error: "Missing target invoiceId." });
    return;
  }

  try {
    const invoiceRepo = AppDataSource.getRepository(ExternalInvoice);
    const invoice = await invoiceRepo.findOne({ where: { id: invoiceId } });

    if (!invoice) {
      res.status(404).json({ ok: false, error: "Invoice not found." });
      return;
    }

    const actor = (req as any).user?.username || (req as any).user?.name || "ocr_operator";
    const amountToApply = receiptData?.amount != null ? Number(receiptData.amount) : Number(invoice.totalAmount ?? invoice.amount ?? 0);
    const matchedName = receiptData?.senderName || invoice.fullName || "Receipt Slip OCR";

    // 1. Apply payment
    const paidIds = await payExternalInvoicesFromWhatsAppInbound(
      [invoice],
      matchedName,
      {
        from: receiptData?.phoneNumber || undefined,
        messageId: receiptData?.referenceId ? `ocr:${receiptData.referenceId}` : undefined,
        paidAmount: amountToApply,
      }
    );

    // 2. Create inbound message log record
    const inboundRepo = AppDataSource.getRepository(WhatsappInboundMessage);
    const msgRecord = inboundRepo.create({
      fromNumber: receiptData?.phoneNumber || "Receipt OCR Upload",
      rawText: receiptData?.rawText || `Uploaded Receipt [Ref: ${receiptData?.referenceId || "N/A"}]`,
      status: "processed",
      parsedNames: receiptData?.candidateNames || [],
      extractedAmount: amountToApply ?? null,
      overpaymentAmount: null,
      paidInvoiceIds: [invoice.id!],
      mediaUrl: mediaUrl || null,
      mediaType: "image/jpeg",
      ocrRawText: receiptData?.rawText || null,
      ocrExtractedData: (receiptData as any) || null,
      errorDetail: `Reconciled manually via OCR to Invoice #${invoice.id} by ${actor}`,
    });
    await inboundRepo.save(msgRecord);

    res.json({
      ok: true,
      message: `Invoice #${invoice.id} successfully paid via Receipt OCR.`,
      data: {
        invoiceId: invoice.id,
        paidInvoiceIds: paidIds,
        messageId: msgRecord.id,
      },
    });
  } catch (err: any) {
    console.error("[receipt-ocr] confirm error:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to confirm receipt payment.",
    });
  }
};
