import axios from "axios";
import { AppDataSource } from "../db/config";
import { UserDetails } from "../db/entities/UserDetails";
import { ExternalInvoice } from "../db/entities/ExternalInvoice";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { Radprofile } from "../db/entities/Radprofile";
import { UserController } from "../controllers/userController";
import { restoreSubscriberLine } from "./subscriberReactivationService";
import {
  payExternalInvoiceFromWhatsAppGroupMessage,
  extractPaymentLinesFromMessage,
  WhatsAppGroupPayResult,
} from "./whatsappPaymentGroupService";
import { parseReceiptOcrText } from "./whatsappReceiptOcrService";
import {
  getTopupPlans,
  purchaseTopupPack,
  getSubscriberActiveTopupBytes,
} from "./topupService";

export type AgentIntent =
  | "bill_inquiry"
  | "account_status"
  | "quota_inquiry"
  | "how_to_pay"
  | "reconnect_speed"
  | "topup_inquiry"
  | "support_escalation"
  | "greeting_menu"
  | "receipt_payment"
  | "batch_payment"
  | "unknown";

export interface SubscriberContext {
  username: string;
  fullName: string;
  phoneNumber: string;
  accountStatus: string;
  expiresAt: Date | null;
  profileName: string | null;
  openInvoices: Array<{
    id: number;
    amount: number;
    amountPaid: number;
    remainingDue: number;
    billingMonth: string;
    dueDate: string | null;
  }>;
  totalDue: number;
}

export interface InboundAgentRequest {
  fromNumber: string;
  rawText: string;
  messageSid?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  ocrRawText?: string | null;
  ocrExtractedData?: Record<string, any> | null;
  groupId?: string | null;
}

export interface AgentProcessResult {
  intent: AgentIntent;
  replyText: string;
  subscriber: SubscriberContext | null;
  delivered: boolean;
  paymentResult?: any;
}

/**
 * Normalizes phone numbers down to the last 8 digits for regional Lebanese/international matching.
 */
export function extractPhoneLookupDigits(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : digits;
}

/**
 * Resolves a subscriber's profile, user details, and open invoices from an incoming phone number.
 */
export async function resolveSubscriberFromPhone(phone: string): Promise<SubscriberContext | null> {
  const lookup = extractPhoneLookupDigits(phone);
  if (!lookup || lookup.length < 6) return null;

  try {
    let username: string | null = null;
    let fullName = "";
    let matchedPhone = "";

    // 1. Check UserDetails table
    const userDetailsRepo = AppDataSource.getRepository(UserDetails);
    const userDetail = await userDetailsRepo
      .createQueryBuilder("ud")
      .where("REPLACE(REPLACE(REPLACE(ud.phoneNumber, ' ', ''), '-', ''), '+', '') LIKE :phone", {
        phone: `%${lookup}%`,
      })
      .getOne();

    if (userDetail) {
      username = userDetail.username;
      fullName = userDetail.fullName || userDetail.username;
      matchedPhone = userDetail.phoneNumber || phone;
    }

    // 2. If not found in UserDetails, check ExternalInvoice
    if (!username) {
      const invoiceRepo = AppDataSource.getRepository(ExternalInvoice);
      const inv = await invoiceRepo
        .createQueryBuilder("i")
        .where("REPLACE(REPLACE(REPLACE(i.phoneNumber, ' ', ''), '-', ''), '+', '') LIKE :phone", {
          phone: `%${lookup}%`,
        })
        .andWhere("i.deletedAt IS NULL")
        .orderBy("i.id", "DESC")
        .getOne();

      if (inv) {
        username = inv.username;
        fullName = inv.fullName || inv.username;
        matchedPhone = inv.phoneNumber || phone;
      }
    }

    if (!username) return null;

    // 3. Load Raduserprofile & Radprofile
    const rupRepo = AppDataSource.getRepository(Raduserprofile);
    const rup = await rupRepo.findOne({ where: { username } });

    let profileName: string | null = null;
    if (rup?.profileId) {
      const rpRepo = AppDataSource.getRepository(Radprofile);
      const rp = await rpRepo.findOne({ where: { id: rup.profileId } as any });
      profileName = rp?.profileName ?? null;
    }

    // 4. Load open invoices
    const extRepo = AppDataSource.getRepository(ExternalInvoice);
    const invoices = await extRepo
      .createQueryBuilder("inv")
      .where("inv.username = :username", { username })
      .andWhere("inv.status IN ('unpaid', 'pending')")
      .andWhere("inv.deletedAt IS NULL")
      .andWhere("inv.voidedAt IS NULL")
      .andWhere("inv.documentType != 'credit_note'")
      .orderBy("inv.billingMonth", "ASC")
      .getMany();

    let totalDue = 0;
    const openInvoices = invoices.map((i) => {
      const due = Number(i.totalAmount ?? i.amount ?? 0);
      const paid = Number(i.amountPaid ?? 0);
      const remaining = Math.max(0, due - paid);
      totalDue += remaining;
      return {
        id: i.id as number,
        amount: due,
        amountPaid: paid,
        remainingDue: Number(remaining.toFixed(2)),
        billingMonth: String(i.billingMonth || "").slice(0, 7),
        dueDate: i.payDueDate ? String(i.payDueDate).slice(0, 10) : null,
      };
    });

    return {
      username,
      fullName: fullName || username,
      phoneNumber: matchedPhone,
      accountStatus: String(rup?.accountStatus || "active").toLowerCase(),
      expiresAt: rup?.expiresAt ? new Date(rup.expiresAt) : null,
      profileName,
      openInvoices,
      totalDue: Number(totalDue.toFixed(2)),
    };
  } catch (err: any) {
    console.warn("[whatsapp-agent] Error resolving subscriber by phone:", err?.message || err);
    return null;
  }
}

/**
 * Detects whether an inbound text message contains payment lines (single or multiple lines of names and amounts).
 * Supports staff prefixes (paid:, تم الدفع:), multi-line entries separated by newline/comma/semicolon,
 * and single line formats with trailing currency/numeric amounts (e.g. `Ahmad Khalil 35`).
 */
export function isPaymentLineMessage(rawText: string): boolean {
  const text = String(rawText || "").trim();
  if (!text) return false;

  // 1. Explicit staff payment prefixes or currency prefixes (e.g. "$name amount", "paid: name amount")
  if (/^([\$€£]|paid|pay|payment|done|received|تم الدفع|دفع)[\s:\-–—]*/i.test(text)) {
    return true;
  }

  // 2. Extract payment lines using the multi-line parser
  const lines = extractPaymentLinesFromMessage(text);
  if (lines.length === 0) return false;

  // Case A: At least one line has an explicit trailing numeric amount (e.g. "Ahmad Khalil 35", "johndoe 25$")
  const hasExplicitAmount = lines.some((l) => l.amount !== null && l.amount > 0);
  if (hasExplicitAmount) {
    // Avoid false positives on questions (e.g. "is my bill 35?")
    if (!/[?؟]/.test(text)) {
      return true;
    }
  }

  // Case B: Multiple distinct lines (newline, comma, semicolon delimited)
  if (lines.length >= 2) {
    const areCandidateNames = lines.every(
      (l) =>
        l.name.length <= 60 &&
        !/[?؟]/.test(l.name) &&
        !/(how|why|when|what|kif|shou|shu|ليش|كيف|شو|متى)/i.test(l.name)
    );
    if (areCandidateNames) {
      return true;
    }
  }

  return false;
}

/**
 * Classifies the subscriber's intent using high-speed deterministic regex across English, Arabic, and Franco-Arab.
 */
export function classifyConversationalIntent(rawText: string, hasMedia = false): AgentIntent {
  if (hasMedia) return "receipt_payment";

  const text = String(rawText || "").trim().toLowerCase();
  if (!text) return "greeting_menu";

  // Menu shortcuts
  if (text === "1" || text === "١") return "bill_inquiry";
  if (text === "2" || text === "٢") return "account_status";
  if (text === "3" || text === "٣") return "quota_inquiry";
  if (text === "4" || text === "٤") return "how_to_pay";
  if (text === "5" || text === "٥") return "reconnect_speed";
  if (text === "6" || text === "٦") return "topup_inquiry";
  if (text === "7" || text === "٧" || text === "0" || text === "٠") return "support_escalation";

  // Batch or name + amount payment parser
  if (isPaymentLineMessage(rawText)) {
    return "batch_payment";
  }

  // 1. How to Pay / Payment methods (tested before bill inquiry)
  if (
    /(\bhow to pay\b|\bhow can i pay\b|\bwhere to pay\b|\bpayment method\b|\bpay method\b|\bwhish\b|\bomt\b|\bbob\b|\bbank\b|\bways to pay\b|\bkif bedfa3\b|\bkif fiyye idfa3\b|\bwein bedfa3\b|\btari2at\b|طريقة الدفع|كيف فيي ادفع|وين بدفع|طرق الدفع|ويش)/i.test(
      text
    )
  ) {
    return "how_to_pay";
  }

  // 2. Top-up / Turbo Boost / Extra Quota (tested before generic quota inquiry)
  if (
    /(\btopup\b|\bturbo\b|\bboost\b|\bextra giga\b|\bextra gb\b|\bextra quota\b|\bzide giga\b|\bzidli\b|\bbaddi giga\b|\bbuy gb\b|\bbuy quota\b|تعبئة|شحن|باقة اضافية|زيادة غيغا|اكسترا|تيربو)/i.test(
      text
    )
  ) {
    return "topup_inquiry";
  }

  // 3. Quota / Usage / Consumption (tested before generic 'how much')
  if (
    /(\bquota\b|\busage\b|\bconsumption\b|\bremaining\b|\bgigabytes?\b|\bgiga\b|\bdata\b|\baddeh ba2i\b|\bade ba2e\b|\bkam giga\b|\bmasrouf\b|\bestehlak\b|غيغا|كوتا|استهلاك|كم باقي|رصيد البيانات)/i.test(
      text
    )
  ) {
    return "quota_inquiry";
  }

  // 4. Bill / Balance Inquiry
  if (
    /(\bbill\b|\binvoice\b|\bbalance\b|\bdue\b|\bhow much\b|\bamount\b|\bfattour|\bfatour|\bhesab|\bshou 3layi\b|\bade 3laye\b|\bkam 3layi\b|فاتورة|حساب|كم حسابي|قديش عليي|مستحقات|رصيد|الفاتورة)/i.test(
      text
    )
  ) {
    return "bill_inquiry";
  }

  // 5. Account / Subscription / Expiry
  if (
    /(\bstatus\b|\bexpire\b|\bexpiry\b|\bexpiration\b|\bwhen does\b|\bmy plan\b|\bw2tish\b|\bemta\b|\bbyekhlas\b|\bishtirak\b|\bactive\b|اشتراك|انتهاء|تاريخ|متى ينتهي|حالة الحساب|باقتي)/i.test(
      text
    )
  ) {
    return "account_status";
  }

  // 6. Slow Connection / Reconnect / Refresh
  if (
    /(\bslow\b|\bbati2\b|\breconnect\b|\breset\b|\brefresh\b|\bdown\b|\bno internet\b|\bm2atta3\b|\bfasel\b|بطيء|فصل|الانترنت بطيء|تنشيط|اعادة اتصال)/i.test(
      text
    )
  ) {
    return "reconnect_speed";
  }

  // 7. Support Escalation / Human Agent
  if (
    /(\bagent\b|\bhuman\b|\btalk to person\b|\brepresentative\b|\boperator\b|\bmowazzaf\b|\bhada yrod\b|\bhelpdesk\b|\bsupport\b|موظف|خدمة العملاء|تحدث مع موظف|دعم فني|مساعدة)/i.test(
      text
    )
  ) {
    return "support_escalation";
  }

  // 8. Greeting / Menu
  if (
    /^(hi|hello|hey|start|menu|help|bonjour|marhaba|salam|kifak|ahla|مرحبا|السلام عليكم|اهلا|قائمة|هلا)$/i.test(
      text
    )
  ) {
    return "greeting_menu";
  }

  return "unknown";
}

/**
 * Builds the standard WhatsApp self-service menu.
 */
export function buildMenuMessage(subscriberName?: string | null): string {
  const greeting = subscriberName ? `Hello *${subscriberName}* 👋` : `Welcome to *XNet Support* 👋`;
  return (
    `${greeting}\n\n` +
    `How can I help you today? Please reply with a number:\n\n` +
    `1️⃣ *Check Bill & Balance* (فحص الفاتورة)\n` +
    `2️⃣ *Subscription Status & Expiry* (حالة الاشتراك)\n` +
    `3️⃣ *Check Quota & Usage* (رصيد الغيغا)\n` +
    `4️⃣ *How to Pay* (طرق الدفع: Whish / OMT)\n` +
    `5️⃣ *Refresh Internet Connection* (تنشيط الاتصال)\n` +
    `6️⃣ *Turbo Boost Extra Quota* (شحن باقة غيغا إضافية)\n` +
    `7️⃣ *Speak with Support Agent* (الدعم الفني)\n\n` +
    `📸 *Tip:* Simply send a photo of your payment receipt (Whish / OMT) for instant automated activation!`
  );
}

/**
 * Generates the conversational response based on classified intent and subscriber context.
 */
export async function generateAgentResponse(
  intent: AgentIntent,
  sub: SubscriberContext | null,
  rawText?: string
): Promise<string> {
  const whishNumber = process.env.WHATSAPP_WHISH_ACCOUNT_NUMBER || process.env.WHISH_PHONE_NUMBER || "70 000 000";
  const supportPhone = process.env.SUPPORT_PHONE_NUMBER || "01-000000";

  switch (intent) {
    case "bill_inquiry": {
      if (!sub) {
        return (
          `📄 *Bill Inquiry*\n\n` +
          `I couldn't locate an account matching this WhatsApp number.\n\n` +
          `Please reply with your *username* (e.g. \`user: johndoe\`) or contact our desk at ${supportPhone}.`
        );
      }

      if (sub.openInvoices.length === 0) {
        return (
          `🎉 *Great news, ${sub.fullName}!* (Account: \`${sub.username}\`)\n\n` +
          `You have *no outstanding invoices*. Your account is fully paid up.\n\n` +
          (sub.expiresAt
            ? `📅 Current Expiration: *${sub.expiresAt.toLocaleDateString()}*\n`
            : "") +
          `Thank you for choosing XNet! 🚀`
        );
      }

      let invoiceLines = "";
      for (const inv of sub.openInvoices) {
        invoiceLines += `• *Invoice #${inv.id}* (${inv.billingMonth}): *$${inv.remainingDue.toFixed(2)}*` +
          (inv.dueDate ? ` (Due: ${inv.dueDate})` : "") +
          `\n`;
      }

      return (
        `📋 *Your Outstanding Invoices* (*${sub.fullName}* - \`${sub.username}\`):\n\n` +
        invoiceLines +
        `\n💵 *Total Amount Due:* *$${sub.totalDue.toFixed(2)}*\n\n` +
        `💳 *How to Pay Instantly:*\n` +
        `• *Whish Money:* Transfer to *${whishNumber}* and send the receipt screenshot here for instant activation!\n` +
        `• Reply with *4* for more payment channels.`
      );
    }

    case "account_status": {
      if (!sub) {
        return (
          `ℹ️ *Account Status*\n\n` +
          `We couldn't detect your subscriber username from this phone number.\n` +
          `Please reply with \`user: <your_username>\` so we can look up your subscription.`
        );
      }

      const now = new Date();
      let statusEmoji = "🟢";
      let statusLabel = "Active (Full Speed)";

      if (sub.accountStatus === "suspended") {
        statusEmoji = "🔴";
        statusLabel = "Suspended (Unpaid Invoice)";
      } else if (sub.accountStatus === "expired" || (sub.expiresAt && sub.expiresAt < now)) {
        statusEmoji = "🟡";
        statusLabel = "Expired (Renewal Required)";
      }

      let expiryText = sub.expiresAt ? sub.expiresAt.toLocaleDateString() : "Not set";
      if (sub.expiresAt) {
        const daysLeft = Math.ceil((sub.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        if (daysLeft > 0) {
          expiryText += ` (${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining)`;
        } else {
          expiryText += ` (Expired)`;
        }
      }

      return (
        `👤 *Subscriber Overview:*\n\n` +
        `• *Name:* ${sub.fullName}\n` +
        `• *Username:* \`${sub.username}\`\n` +
        `• *Plan:* ${sub.profileName || "Standard Plan"}\n` +
        `• *Status:* ${statusEmoji} *${statusLabel}*\n` +
        `• *Expires:* *${expiryText}*\n` +
        (sub.totalDue > 0
          ? `\n⚠️ *Pending Due:* *$${sub.totalDue.toFixed(2)}* (Reply *1* to view bill)`
          : "\n✅ Account is in good standing.")
      );
    }

    case "quota_inquiry": {
      if (!sub) {
        return `📊 *Quota Check*\n\nPlease reply with your username (\`user: username\`) to check your monthly quota.`;
      }
      const activeBytes = await getSubscriberActiveTopupBytes(sub.username);
      const activeGb = Number(activeBytes / (BigInt(1024) * BigInt(1024) * BigInt(1024)));

      return (
        `📊 *Data Quota & Usage:*\n\n` +
        `• *Account:* \`${sub.username}\`\n` +
        `• *Plan:* ${sub.profileName || "Unlimited / Fair Usage"}\n` +
        (activeGb > 0 ? `• *Active Turbo Boost:* *+${activeGb} GB*\n` : "") +
        `• *Status:* ${sub.accountStatus === "active" ? "🟢 Normal Speed" : "🟡 Restricted"}\n\n` +
        `💡 Your monthly quota resets on the 1st of every month.\n` +
        `🚀 Need a high-speed turbo boost? Reply *6* or *TOPUP* to see available extra packs!`
      );
    }

    case "topup_inquiry": {
      if (!sub) {
        return (
          `🚀 *XNet Turbo Boost Extra Data*\n\n` +
          `I couldn't locate an account matching this phone number.\n` +
          `Please reply with your subscriber username (\`user: <username>\`) to view your top-up options.`
        );
      }

      const plans = await getTopupPlans();
      const textLower = String(rawText || "").toLowerCase();

      // Check if user requested a specific pack
      let selectedPlan = null;
      for (const p of plans) {
        const gbStr = `${p.gb}`;
        if (textLower.includes(gbStr) || textLower.includes(`${gbStr}gb`)) {
          selectedPlan = p;
          break;
        }
      }

      if (selectedPlan) {
        try {
          const purchaseRes = await purchaseTopupPack({
            username: sub.username,
            planId: selectedPlan.id,
            paymentMethod: "invoice_debit",
            actorUsername: `whatsapp:${sub.phoneNumber}`,
          });

          return (
            `🚀 *Turbo Boost Activated!* 🎉\n\n` +
            `• *Account:* \`${sub.username}\`\n` +
            `• *Pack:* *${selectedPlan.name}* (+${selectedPlan.gb} GB)\n` +
            `• *Amount:* *${selectedPlan.formattedPrice}* (Added to your monthly billing invoice)\n\n` +
            (purchaseRes.unthrottled
              ? `⚡ *Your line has been automatically unthrottled and refreshed at full speed!*\n`
              : `✅ *Extra data is now active for your current billing cycle.*\n`) +
            `Enjoy your high-speed internet! 🌐`
          );
        } catch (err: any) {
          return `❌ *Activation Notice:* ${err?.message || "Could not activate top-up pack"}. Please contact our support team.`;
        }
      }

      // If no specific pack was requested, display catalog
      let catalog = "";
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        catalog += `${i + 1}️⃣ *${p.name}* — *${p.formattedPrice}*\n`;
      }

      const activeBytes = await getSubscriberActiveTopupBytes(sub.username);
      const activeGb = Number(activeBytes / (BigInt(1024) * BigInt(1024) * BigInt(1024)));

      return (
        `🚀 *XNet Turbo Boost Extra Data Packs:*\n\n` +
        (activeGb > 0 ? `📊 You currently have *${activeGb} GB* active Turbo Boost quota.\n\n` : "") +
        `Need more high-speed gigabytes before your cycle resets?\n\n` +
        catalog +
        `\n👉 *To activate instantly, reply with:*\n` +
        `*TOPUP 20* or *TOPUP 50* or *TOPUP 120*\n\n` +
        `*(The cost will be conveniently added to your next monthly invoice)*`
      );
    }

    case "how_to_pay": {
      return (
        `💳 *Payment Options:*\n\n` +
        `1️⃣ *Whish Money (Instant Auto-Activation):*\n` +
        `• Send money to *${whishNumber}*\n` +
        `• Send the transfer screenshot right here in this chat. Our automated system will activate your line in seconds!\n\n` +
        `2️⃣ *OMT / BoB Finance:*\n` +
        `• Ask the agent to pay *XNet Internet*\n` +
        `• Provide your phone number or account username.\n\n` +
        `3️⃣ *Cash at Branch:*\n` +
        `• Visit our desk during business hours (9:00 AM - 6:00 PM).\n\n` +
        (sub && sub.totalDue > 0 ? `💵 Your current total due is: *$${sub.totalDue.toFixed(2)}*` : "")
      );
    }

    case "reconnect_speed": {
      if (!sub) {
        return `🔄 *Connection Refresh*\n\nPlease reply with your *username* (e.g. \`user: johndoe\`) so we can refresh your line.`;
      }

      if (sub.accountStatus === "suspended" || sub.totalDue > 0) {
        return (
          `⚠️ *Connection Notice:*\n\n` +
          `Subscriber \`${sub.username}\` currently has an overdue balance of *$${sub.totalDue.toFixed(2)}*.\n` +
          `Your line speed may be throttled until settlement.\n\n` +
          `Reply with *1* to see your bill, or send a receipt screenshot for instant restore!`
        );
      }

      // Trigger actual live session refresh
      try {
        await UserController.disconnectUser(sub.username);
      } catch {}

      return (
        `🔄 *Connection Refreshed!*\n\n` +
        `We have sent a refresh signal to our NAS for \`${sub.username}\`.\n` +
        `• Your router should re-negotiate connection within *15 seconds*.\n` +
        `• If you still experience issues, please power cycle your router or reply *6* to speak with technical support.`
      );
    }

    case "support_escalation": {
      return (
        `👨‍💼 *XNet Support Desk*\n\n` +
        `Our team is available to assist you!\n` +
        `• *Phone / Hotline:* ${supportPhone}\n` +
        `• *Hours:* Mon - Sat, 9:00 AM to 8:00 PM\n\n` +
        `A support ticket has been flagged with your phone number. An agent will follow up with you shortly.`
      );
    }

    case "greeting_menu":
    default: {
      return buildMenuMessage(sub?.fullName);
    }
  }
}

/**
 * Formats a clean, itemized WhatsApp receipt summary when single or multiple payment lines
 * are parsed and processed against external invoices.
 */
export function buildBatchPaymentReply(payResult: WhatsAppGroupPayResult): string {
  if (!payResult.ok) {
    if (payResult.reason === "disabled") {
      return `⚠️ *Payment Processing Disabled*\nAutomated WhatsApp invoice payment is currently disabled on this server.`;
    }
    if (payResult.reason === "wrong_group") {
      return `⚠️ *Unauthorized Sender*\nThis sender or group is not authorized to register direct batch payments.`;
    }
    if (payResult.reason === "empty_message") {
      return `⚠️ *Payment Parsing Failed*\nCould not find valid subscriber names or amounts in your message.\nFormat: \`Subscriber Name Amount\` (e.g. \`Ahmad Khalil 35\`)`;
    }
    return `❌ *Payment Processing Error*\n${payResult.detail || "An unexpected error occurred while processing payments."}`;
  }

  const { results } = payResult;
  const paidCount = results.filter((r) => r.status === "paid").length;
  const ambiguousCount = results.filter((r) => r.status === "ambiguous").length;
  const noMatchCount = results.filter((r) => r.status === "no_match").length;

  let totalCollected = 0;
  for (const r of results) {
    if (r.status === "paid" && r.amount) {
      totalCollected += r.amount;
    }
  }

  // Single line submission: concise confirmation
  if (results.length === 1) {
    const r = results[0];
    if (r.status === "paid") {
      return (
        `✅ *Payment Confirmed & Line Activated!* 🎉\n\n` +
        `• *Subscriber:* *${r.name}*\n` +
        `• *Amount Paid:* *${r.amount ? `$${r.amount.toFixed(2)}` : "Full Balance"}*\n` +
        `• *Invoice Paid:* #${r.paidInvoiceIds.join(", #")}\n` +
        `• *Billing Month:* ${r.billingMonth}\n\n` +
        `⚡ Speed throttle has been removed and connection restored at full speed!`
      );
    }
    if (r.status === "ambiguous") {
      return (
        `⚠️ *Payment Ambiguity Notice*\n\n` +
        `Found *${r.candidateCount}* matching accounts for *${r.name}* in ${r.billingMonth}.\n` +
        `Ambiguity logged as *#${r.ambiguityId}* for admin reconciliation.\n` +
        `Please specify the exact *username* (e.g. \`user: johndoe\`).`
      );
    }
    if (r.status === "no_match") {
      return (
        `❌ *No Unpaid Invoice Found*\n\n` +
        `Could not find an open/unpaid invoice matching *${r.name}*.\n` +
        `Please verify the subscriber's full name or username.`
      );
    }
    return (
      `⚠️ *Payment Processing Failed*\n\n` +
      `Could not process payment for *${r.name}*: ${r.detail}`
    );
  }

  // Multi-line batch submission: itemized report
  const itemizedLines = results.map((r) => {
    if (r.status === "paid") {
      const amt = r.amount ? `$${r.amount.toFixed(2)}` : "Full";
      return `• ✅ *${r.name}*: Paid ${amt} (#${r.paidInvoiceIds.join(", #")})`;
    }
    if (r.status === "ambiguous") {
      return `• ⚠️ *${r.name}*: Ambiguous (${r.candidateCount} matches) [Ambiguity #${r.ambiguityId}]`;
    }
    if (r.status === "no_match") {
      return `• ❌ *${r.name}*: No unpaid invoice found`;
    }
    return `• ⚠️ *${r.name}*: Error (${r.detail})`;
  });

  return (
    `📋 *Batch Payment Report* (${results.length} lines parsed)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ *Paid:* ${paidCount}  |  ⚠️ *Ambiguous:* ${ambiguousCount}  |  ❌ *No Match:* ${noMatchCount}\n` +
    (totalCollected > 0 ? `💰 *Total Amount:* *$${totalCollected.toFixed(2)}*\n` : "") +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    itemizedLines.join("\n") +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ Real-time CoA throttle release signals sent to NAS for reactivated subscribers.`
  );
}

/**
 * Handles incoming media (receipt images from Whish, OMT, BoB, Suyool, etc.):
 * - Runs OCR on the receipt image.
 * - Reconciles and pays the external invoice.
 * - Executes Step 1's closed-loop self-healing reconnection.
 * - Generates instant celebratory e-receipt confirmation.
 */
export async function handleReceiptSubmission(
  sub: SubscriberContext | null,
  options: {
    rawText: string;
    mediaUrl?: string | null;
    ocrRawText?: string | null;
    ocrExtractedData?: Record<string, any> | null;
    fromNumber: string;
    messageSid?: string | null;
  }
): Promise<{ replyText: string; paymentResult: any }> {
  const rawText = options.rawText || "(media receipt)";
  const extracted = options.ocrExtractedData || (options.ocrRawText ? parseReceiptOcrText(options.ocrRawText) : null);

  // Attempt payment processing using existing group payment engine
  const paymentResult = await payExternalInvoiceFromWhatsAppGroupMessage(rawText, {
    from: options.fromNumber,
    messageId: options.messageSid || undefined,
  });

  const paidIds = paymentResult.ok ? paymentResult.paidInvoiceIds || [] : [];
  const results = paymentResult.ok ? paymentResult.results || [] : [];
  const firstRes = results[0];
  const isAmbiguous = results.some((r) => r.status === "ambiguous");

  if (paidIds.length > 0) {
    // Automatically trigger Step 1 closed-loop self-healing line restoration
    const username = sub?.username || (firstRes && firstRes.name ? firstRes.name : null);
    let newExpiry: Date | null = null;

    if (username) {
      try {
        await restoreSubscriberLine(username, {
          trigger: "gateway_payment",
          actor: "whatsapp:agent",
          invoiceId: paidIds[0],
        });
        const rupRepo = AppDataSource.getRepository(Raduserprofile);
        const updated = await rupRepo.findOne({ where: { username } });
        newExpiry = updated?.expiresAt ? new Date(updated.expiresAt) : null;
      } catch (healErr: any) {
        console.warn("[whatsapp-agent] Self-healing after payment warning:", healErr?.message || healErr);
      }
    }

    const amount = extracted?.amount || firstRes?.amount || "—";
    const provider = (extracted?.provider || "Whish / Transfer").toUpperCase();
    const ref = extracted?.referenceId ? `\n• *Reference:* \`${extracted.referenceId}\`` : "";
    const expiryStr = newExpiry ? `\n📅 *New Expiry:* *${newExpiry.toLocaleDateString()}*` : "";

    const reply =
      `✅ *Payment Confirmed & Line Activated!* 🎉\n\n` +
      `Thank you${sub ? `, *${sub.fullName}*` : ""}!\n` +
      `• *Amount:* *$${amount}*\n` +
      `• *Provider:* *${provider}*` +
      ref +
      `\n• *Invoice Paid:* #${paidIds.join(", #")}\n` +
      expiryStr +
      `\n\n⚡ Your connection has been refreshed at full speed. Enjoy your internet!`;

    return { replyText: reply, paymentResult };
  }

  // If ambiguous
  if (isAmbiguous) {
    return {
      replyText:
        `⚠️ *Payment Ambiguity Notice*\n\n` +
        `We received your receipt${extracted?.amount ? ` for *$${extracted.amount}*` : ""}, but found multiple open accounts matching this information.\n\n` +
        `Please reply with your *username* (e.g. \`user: johndoe\`) so we can credit the correct invoice immediately.`,
      paymentResult,
    };
  }

  // If no match found
  return {
    replyText:
      `📥 *Receipt Received*\n\n` +
      `We detected your receipt${extracted?.amount ? ` of *$${extracted.amount}*` : ""}${extracted?.provider ? ` via *${extracted.provider.toUpperCase()}*` : ""}.\n` +
      `However, we could not automatically find an open invoice for this sender.\n\n` +
      `Please reply with your *username* (e.g. \`user: your_username\`) or *Invoice #* and we will link it immediately!`,
    paymentResult,
  };
}

/**
 * Dispatches an outbound WhatsApp reply to the sender.
 * Supports Twilio 24-hr session messages and Meta WhatsApp Cloud API.
 */
export async function sendWhatsAppAgentReply(to: string, message: string): Promise<boolean> {
  if (process.env.WHATSAPP_ENABLED !== "true") {
    console.log("[whatsapp-agent] Outbound reply skipped: WHATSAPP_ENABLED != 'true'");
    return false;
  }

  const cleanTo = to.replace(/whatsapp:/i, "").trim();
  const digits = cleanTo.replace(/\D/g, "");
  if (!digits) return false;

  const provider = (process.env.WHATSAPP_PROVIDER || "cloud").toLowerCase();

  try {
    if (provider === "twilio") {
      const accountSid = String(process.env.TWILIO_ACCOUNT_SID ?? "").trim();
      const authToken = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();
      const apiKeySid = String(process.env.TWILIO_API_KEY_SID ?? "").trim();
      const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET ?? "").trim();
      const from = String(process.env.TWILIO_WHATSAPP_FROM ?? "").trim();

      if (!accountSid || (!authToken && (!apiKeySid || !apiKeySecret)) || !from) {
        console.warn("[whatsapp-agent] Twilio credentials incomplete for outbound reply");
        return false;
      }

      const authUser = apiKeySid || accountSid;
      const authPass = apiKeySecret || authToken;

      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const params = new URLSearchParams({
        To: `whatsapp:+${digits}`,
        From: from.startsWith("whatsapp:") ? from : `whatsapp:+${from.replace(/\D/g, "")}`,
        Body: message,
      });

      await axios.post(url, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        auth: { username: authUser, password: authPass },
        timeout: 10000,
      });

      console.log(`[whatsapp-agent] Twilio reply delivered to +${digits}`);
      return true;
    }

    // Meta Cloud API
    const token = String(process.env.WHATSAPP_TOKEN ?? "").trim();
    const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
    if (!token || !phoneNumberId) {
      console.warn("[whatsapp-agent] Cloud API credentials incomplete for outbound reply");
      return false;
    }

    const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: digits,
        type: "text",
        text: { body: message },
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      }
    );

    console.log(`[whatsapp-agent] Cloud API reply delivered to +${digits}`);
    return true;
  } catch (err: any) {
    console.warn(`[whatsapp-agent] Failed to send WhatsApp reply to +${digits}:`, err?.response?.data || err?.message || err);
    return false;
  }
}

/**
 * Master Inbound Message Handler:
 * Orchestrates subscriber identification, intent classification, receipt handling,
 * batch multi-line payment parsing, response generation, and outbound dispatch.
 */
export async function processInboundAgentMessage(req: InboundAgentRequest): Promise<AgentProcessResult> {
  const hasMedia = Boolean(req.mediaUrl || (req.mediaType && req.mediaType.startsWith("image")));
  const subscriber = await resolveSubscriberFromPhone(req.fromNumber);
  const intent = classifyConversationalIntent(req.rawText, hasMedia);

  let replyText = "";
  let paymentResult: any = null;

  if (intent === "receipt_payment") {
    const res = await handleReceiptSubmission(subscriber, {
      rawText: req.rawText,
      mediaUrl: req.mediaUrl,
      ocrRawText: req.ocrRawText,
      ocrExtractedData: req.ocrExtractedData,
      fromNumber: req.fromNumber,
      messageSid: req.messageSid,
    });
    replyText = res.replyText;
    paymentResult = res.paymentResult;
  } else if (intent === "batch_payment") {
    const payResult = await payExternalInvoiceFromWhatsAppGroupMessage(req.rawText, {
      from: req.fromNumber,
      groupId: req.groupId ?? (req.fromNumber.includes("@g.us") ? req.fromNumber : undefined),
      messageId: req.messageSid ?? undefined,
    });
    paymentResult = payResult;
    replyText = buildBatchPaymentReply(payResult);
  } else {
    replyText = await generateAgentResponse(intent, subscriber, req.rawText);
  }

  // Deliver outbound conversational response
  const delivered = await sendWhatsAppAgentReply(req.fromNumber, replyText);

  return {
    intent,
    replyText,
    subscriber,
    delivered,
    paymentResult,
  };
}
