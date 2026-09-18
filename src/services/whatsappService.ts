import axios from "axios";

type WhatsAppSendOptions = {
    to: string; // E.164 without '+' (WhatsApp Cloud API expects country code without plus)
    message: string;
    /** Optional variables for template-based sends (Twilio Content API) */
    templateVariables?: Record<string, string | number>;
    /** Twilio Content template SID override */
    contentSid?: string;
    /** Select payment vs reminder Twilio Content template from env */
    templateKind?: "payment" | "reminder";
};

function resolveTwilioContentSid(kind?: "payment" | "reminder"): string {
    if (kind === "reminder") {
        const reminderSid = String(process.env.TWILIO_CONTENT_SID_REMINDER ?? "").trim();
        if (reminderSid) return reminderSid;
        throw new Error(
            "TWILIO_CONTENT_SID_REMINDER is required for payment reminders. " +
            "Create a Twilio Content template for reminders (see env.example) and set its HX… SID in .env."
        );
    }
    return String(process.env.TWILIO_CONTENT_SID ?? "").trim();
}

export function composeReminderMessage(params: {
    fullName?: string | null;
    username?: string;
    invoiceId: number | undefined;
    amount?: number | string | null;
    billingMonth?: string | Date | null;
    status?: string | null;
}): string {
    const month = params.billingMonth ? String(params.billingMonth).slice(0, 10) : "";
    const amountValue =
        typeof params.amount === "number"
            ? params.amount.toFixed(2)
            : String(params.amount ?? "").trim();
    const name = params.fullName || params.username || "Customer";
    return (
        `Hi ${name}, this is a payment reminder for Invoice #${params.invoiceId ?? "?"}` +
        (month ? ` (Billing month: ${month})` : "") +
        (amountValue ? `, amount: $${amountValue}` : "") +
        `. Status: ${params.status || "unpaid"}. Thank you.`
    );
}

/** Variables for Twilio reminder Content template (placeholders {{1}}…{{5}}). */
export function buildReminderTemplateVariables(params: {
    fullName?: string | null;
    username?: string;
    invoiceId: number | undefined;
    amount?: number | string | null;
    billingMonth?: string | Date | null;
    status?: string | null;
    checkoutUrl?: string | null;
}): Record<string, string> {
    const mode = String(process.env.TWILIO_REMINDER_CONTENT_MODE ?? "structured").trim().toLowerCase();
    const message = composeReminderMessage(params);
    if (mode === "full_body" || mode === "message") {
        return { "1": message };
    }
    const month = params.billingMonth ? String(params.billingMonth).slice(0, 10) : "";
    const amountValue =
        typeof params.amount === "number"
            ? params.amount.toFixed(2)
            : String(params.amount ?? "").trim();
    const name = params.fullName || params.username || "Customer";
    const vars: Record<string, string> = {
        "1": name,
        "2": String(params.invoiceId ?? ""),
        "3": month || "—",
        "4": amountValue || "0.00",
        "5": String(params.status || "unpaid"),
    };
    if (params.checkoutUrl) {
        vars["6"] = params.checkoutUrl;
    }
    return vars;
}

/** Variables for Twilio payment-received Content template (placeholders {{1}}…{{3}}). */
export function buildPaymentTemplateVariables(params: {
    fullName?: string | null;
    username?: string;
    invoiceId?: number;
    amount?: number | string | null;
}): Record<string, string> {
    const name = params.fullName || params.username || "Customer";
    const amountValue =
        typeof params.amount === "number"
            ? params.amount.toFixed(2)
            : String(params.amount ?? "").trim();
    return {
        "1": name,
        "2": String(params.invoiceId ?? ""),
        "3": amountValue,
    };
}

/**
 * Sends a WhatsApp text message via Meta WhatsApp Cloud API or Twilio.
 * Requires WHATSAPP_ENABLED=true and provider-specific env vars.
 */
export async function sendWhatsAppMessage({ to, message, templateVariables, templateKind, contentSid }: WhatsAppSendOptions): Promise<void> {
    if (process.env.WHATSAPP_ENABLED !== 'true') {
        return; // disabled in this environment
    }

    const provider = (process.env.WHATSAPP_PROVIDER || 'cloud').toLowerCase();
    if (provider === 'twilio') {
        return sendViaTwilio({ to, message, templateVariables, templateKind, contentSid });
    }

    return sendViaCloud({ to, message });
}

function formatProviderConfigError(provider: string): string {
    if (process.env.WHATSAPP_ENABLED !== 'true') {
        return "WhatsApp is disabled (set WHATSAPP_ENABLED='true').";
    }
    if (provider === "twilio") {
        return "Twilio WhatsApp not configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID+SECRET, TWILIO_CONTENT_SID, and TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID).";
    }
    return "WhatsApp Cloud not configured (need WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID).";
}

function extractDigitsOrThrow(to: string): string {
    const overrideDigits = resolveOverrideDigits();
    const digits = (overrideDigits || to || "").replace(/\D/g, "");
    if (!digits) throw new Error("Invalid recipient phone number (no digits after normalization).");
    return digits;
}

function extractAxiosErrorMessage(error: any): string {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const base = error?.message || "Request failed";
    if (status === 401) {
        return twilioAuthErrorWithDiagnostics(
            "Twilio authentication failed (401). Credentials must come from the same Twilio account/subaccount."
        );
    }
    try {
        const payload = data ? JSON.stringify(data) : "";
        return status ? `${base} (status ${status})${payload ? `: ${payload}` : ""}` : base;
    } catch {
        return status ? `${base} (status ${status})` : base;
    }
}

/** Ensures Twilio WhatsApp sender format: whatsapp:+E164 */
export function normalizeTwilioWhatsAppFrom(raw: string | undefined): string | undefined {
    const v = String(raw ?? "").trim();
    if (!v) return undefined;
    if (v.toLowerCase().startsWith("whatsapp:")) return v;
    const digits = v.replace(/\D/g, "");
    if (!digits) return undefined;
    return `whatsapp:+${digits}`;
}

type TwilioHttpAuth = { username: string; password: string; mode: "api-key" | "auth-token" };

function getTwilioAccountSid(): string {
    return String(process.env.TWILIO_ACCOUNT_SID ?? "").trim();
}

/** Prefer API Key (SK + secret); fall back to Account SID + Auth Token. */
function getTwilioHttpAuth(): TwilioHttpAuth | null {
    const apiKeySid = String(process.env.TWILIO_API_KEY_SID ?? "").trim();
    const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET ?? "").trim();
    if (apiKeySid && apiKeySecret) {
        return { username: apiKeySid, password: apiKeySecret, mode: "api-key" };
    }
    const accountSid = getTwilioAccountSid();
    const authToken = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();
    if (accountSid && authToken) {
        return { username: accountSid, password: authToken, mode: "auth-token" };
    }
    return null;
}

function getTwilioHttpAuthCandidates(): TwilioHttpAuth[] {
    const candidates: TwilioHttpAuth[] = [];
    const primary = getTwilioHttpAuth();
    if (primary) candidates.push(primary);

    const accountSid = getTwilioAccountSid();
    const authToken = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();
    if (
        accountSid &&
        authToken &&
        !candidates.some((candidate) => candidate.mode === "auth-token")
    ) {
        candidates.push({ username: accountSid, password: authToken, mode: "auth-token" });
    }
    return candidates;
}

async function withTwilioAuthFallback<T>(
    operation: (auth: TwilioHttpAuth) => Promise<T>
): Promise<{ result: T; auth: TwilioHttpAuth }> {
    const candidates = getTwilioHttpAuthCandidates();
    if (candidates.length === 0) {
        throw new Error("Twilio authentication credentials are missing");
    }

    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
        const auth = candidates[index];
        try {
            return { result: await operation(auth), auth };
        } catch (error: any) {
            lastError = error;
            const canTryNext =
                error?.response?.status === 401 && index < candidates.length - 1;
            if (!canTryNext) throw error;
            console.warn(
                `[whatsapp] Twilio ${auth.mode} credentials were rejected; retrying with ${candidates[index + 1].mode}`
            );
        }
    }

    throw lastError;
}

function twilioMessagesUrl(accountSid: string): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
}

function twilioMessageUrl(accountSid: string, messageSid: string): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`;
}

/** Mask secrets for logs/API — shows prefix, suffix, and length only. */
function maskCredentialPreview(value: string | undefined | null): string {
    const v = String(value ?? "").trim();
    if (!v) return "(empty)";
    if (v.length <= 8) return `**** (len=${v.length})`;
    return `${v.slice(0, 4)}…${v.slice(-4)} (len=${v.length})`;
}

export type TwilioCredentialDiagnostics = {
    accountSid: string | null;
    authTokenLoaded: boolean;
    authTokenPreview: string;
    apiKeySid: string | null;
    apiKeySecretLoaded: boolean;
    apiKeySecretPreview: string;
    authModeUsed: "api-key" | "auth-token" | null;
    authUsernameUsed: string | null;
    authSecretPreview: string;
    apiKeySidWithoutSecret: boolean;
    whatsappFrom: string | null;
    contentSid: string | null;
};

export function getTwilioCredentialDiagnostics(): TwilioCredentialDiagnostics {
    const accountSid = getTwilioAccountSid() || null;
    const authToken = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();
    const apiKeySid = String(process.env.TWILIO_API_KEY_SID ?? "").trim();
    const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET ?? "").trim();
    const auth = getTwilioHttpAuth();

    return {
        accountSid,
        authTokenLoaded: Boolean(authToken),
        authTokenPreview: maskCredentialPreview(authToken),
        apiKeySid: apiKeySid || null,
        apiKeySecretLoaded: Boolean(apiKeySecret),
        apiKeySecretPreview: maskCredentialPreview(apiKeySecret),
        authModeUsed: auth?.mode ?? null,
        authUsernameUsed: auth?.username ?? null,
        authSecretPreview: auth ? maskCredentialPreview(auth.password) : "(none)",
        apiKeySidWithoutSecret: Boolean(apiKeySid && !apiKeySecret),
        whatsappFrom: normalizeTwilioWhatsAppFrom(process.env.TWILIO_WHATSAPP_FROM) ?? null,
        contentSid: String(process.env.TWILIO_CONTENT_SID ?? "").trim() || null,
    };
}

export function logTwilioCredentialDiagnostics(context: string): void {
    const d = getTwilioCredentialDiagnostics();
    console.log(`[whatsapp] ${context}:`, JSON.stringify(d));
    if (d.apiKeySidWithoutSecret) {
        console.warn(
            "[whatsapp] TWILIO_API_KEY_SID is set but TWILIO_API_KEY_SECRET is empty — falling back to TWILIO_AUTH_TOKEN"
        );
    }
}

function twilioAuthErrorWithDiagnostics(baseMessage: string): string {
    const d = getTwilioCredentialDiagnostics();
    const parts = [
        baseMessage,
        `Loaded env → accountSid=${d.accountSid ?? "(empty)"}`,
        `authToken=${d.authTokenPreview}`,
        `apiKeySid=${d.apiKeySid ?? "(empty)"}`,
        `apiKeySecret=${d.apiKeySecretPreview}`,
        `authMode=${d.authModeUsed ?? "none"}`,
        `authUser=${d.authUsernameUsed ?? "(none)"}`,
        `authSecret=${d.authSecretPreview}`,
    ];
    if (d.apiKeySidWithoutSecret) {
        parts.push("WARN: add TWILIO_API_KEY_SECRET or remove TWILIO_API_KEY_SID to avoid confusion");
    }
    return parts.join(". ");
}

export async function testTwilioCredentials(): Promise<{
    ok: boolean;
    status?: number;
    message?: string;
    accountStatus?: string;
}> {
    const accountSid = getTwilioAccountSid();
    if (!accountSid || getTwilioHttpAuthCandidates().length === 0) {
        return { ok: false, message: "Missing TWILIO_ACCOUNT_SID or auth credentials" };
    }
    try {
        const { result: resp } = await withTwilioAuthFallback((auth) =>
            axios.get(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
                auth: { username: auth.username, password: auth.password },
                timeout: 10000,
            })
        );
        return { ok: true, accountStatus: String(resp.data?.status ?? "unknown") };
    } catch (e: any) {
        return {
            ok: false,
            status: e?.response?.status,
            message: e?.response?.data?.message || e?.message || "Twilio auth test failed",
        };
    }
}

export type WhatsAppConfigStatus = {
    enabled: boolean;
    provider: string;
    configured: boolean;
    authOk?: boolean;
    issues: string[];
};

export function getWhatsAppConfigStatus(): WhatsAppConfigStatus {
    const enabled = process.env.WHATSAPP_ENABLED === "true";
    const provider = (process.env.WHATSAPP_PROVIDER || "cloud").toLowerCase();
    const issues: string[] = [];

    if (!enabled) {
        return { enabled: false, provider, configured: false, issues: ["WHATSAPP_ENABLED is not 'true'"] };
    }

    if (provider === "twilio") {
        const accountSid = getTwilioAccountSid();
        const auth = getTwilioHttpAuth();
        const from = normalizeTwilioWhatsAppFrom(process.env.TWILIO_WHATSAPP_FROM);
        const messagingServiceSid = String(process.env.TWILIO_MESSAGING_SERVICE_SID ?? "").trim();
        const contentSid = String(process.env.TWILIO_CONTENT_SID ?? "").trim();

        if (!accountSid) issues.push("Missing TWILIO_ACCOUNT_SID");
        if (!auth) {
            issues.push("Set TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET");
        } else if (auth.mode === "api-key" && !auth.username.startsWith("SK")) {
            issues.push("TWILIO_API_KEY_SID should start with SK");
        }
        // Note: apiKeySid without secret is NOT a blocking issue — we fall back to Auth Token (warn only at startup)
        if (!from && !messagingServiceSid) {
            issues.push("Set TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886) or TWILIO_MESSAGING_SERVICE_SID");
        }
        if (!contentSid) issues.push("Missing TWILIO_CONTENT_SID (Twilio Content template SID)");

        return {
            enabled: true,
            provider,
            configured: issues.length === 0,
            issues,
        };
    }

    const token = String(process.env.WHATSAPP_TOKEN ?? "").trim();
    const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
    if (!token) issues.push("Missing WHATSAPP_TOKEN");
    if (!phoneNumberId) issues.push("Missing WHATSAPP_PHONE_NUMBER_ID");

    return { enabled: true, provider, configured: issues.length === 0, issues };
}

/** Logs config issues and verifies Twilio credentials when WhatsApp is enabled. */
export async function validateWhatsAppAtStartup(): Promise<void> {
    const status = getWhatsAppConfigStatus();
    if (!status.enabled) {
        console.log("[whatsapp] Disabled (WHATSAPP_ENABLED != true)");
        return;
    }

    if (status.issues.length) {
        console.warn("[whatsapp] Configuration incomplete:", status.issues.join("; "));
        logTwilioCredentialDiagnostics("startup config incomplete");
        return;
    }

    if (status.provider !== "twilio") {
        console.log("[whatsapp] Cloud API provider configured");
        return;
    }

    logTwilioCredentialDiagnostics("startup");

    const accountSid = getTwilioAccountSid();
    if (!accountSid || getTwilioHttpAuthCandidates().length === 0) {
        console.warn("[whatsapp] Twilio credentials missing; skipping startup check");
        return;
    }
    try {
        const { result: resp, auth } = await withTwilioAuthFallback((candidate) =>
            axios.get(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
                auth: { username: candidate.username, password: candidate.password },
                timeout: 10000,
            })
        );
        const from = normalizeTwilioWhatsAppFrom(process.env.TWILIO_WHATSAPP_FROM);
        console.log(
            `[whatsapp] Twilio credentials OK (${auth.mode}, account ${resp.data?.status ?? "unknown"}, sender ${from ?? "messaging-service"})`
        );
    } catch (e: any) {
        const msg = extractAxiosErrorMessage(e);
        console.error(`[whatsapp] Twilio credential check failed: ${msg}`);
        logTwilioCredentialDiagnostics("startup auth failed");
    }
}

/**
 * Strict WhatsApp sender: throws if message is not actually sent.
 * Use this for user-facing actions (e.g. "Send reminder") where silent no-ops are confusing.
 */
export async function sendWhatsAppMessageStrict(
    opts: WhatsAppSendOptions
): Promise<{ provider: string; to: string; mode: string; sid?: string; status?: string; errorCode?: any; errorMessage?: any }> {
    const provider = (process.env.WHATSAPP_PROVIDER || 'cloud').toLowerCase();
    if (process.env.WHATSAPP_ENABLED !== 'true') {
        throw new Error(formatProviderConfigError(provider));
    }

    if (provider === "twilio") {
        const accountSid = getTwilioAccountSid();
        const from = normalizeTwilioWhatsAppFrom(process.env.TWILIO_WHATSAPP_FROM);
        const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
        const contentSid = opts.contentSid || resolveTwilioContentSid(opts.templateKind);

        if (
            !accountSid ||
            getTwilioHttpAuthCandidates().length === 0 ||
            (!from && !messagingServiceSid) ||
            !contentSid
        ) {
            throw new Error(formatProviderConfigError(provider));
        }

        const digits = extractDigitsOrThrow(opts.to);
        const toParam = `whatsapp:+${digits}`;
        const url = twilioMessagesUrl(accountSid);

        const params: Record<string, string> = {
            To: toParam,
            ...(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid } : { From: from as string }),
            ContentSid: contentSid,
        };

        // ContentVariables JSON
        let contentVariables = process.env.TWILIO_CONTENT_VARIABLES_JSON;
        if (opts.templateVariables && Object.keys(opts.templateVariables).length > 0) {
            const normalized: Record<string, string> = {};
            for (const [k, v] of Object.entries(opts.templateVariables)) normalized[String(k)] = String(v);
            contentVariables = JSON.stringify(normalized);
        }
        if (contentVariables) {
            try {
                const parsed = JSON.parse(contentVariables);
                // Only inject freeform message for non-reminder templates (legacy payment templates)
                if (
                    parsed &&
                    typeof parsed === "object" &&
                    parsed.message === undefined &&
                    opts.templateKind !== "reminder"
                ) {
                    (parsed as any).message = opts.message;
                }
                contentVariables = JSON.stringify(parsed);
            } catch {
                contentVariables =
                    opts.templateKind === "reminder"
                        ? JSON.stringify({ "1": opts.message })
                        : JSON.stringify({ message: opts.message });
            }
        } else if (opts.templateKind === "reminder") {
            contentVariables = JSON.stringify({ "1": opts.message });
        } else {
            contentVariables = JSON.stringify({ message: opts.message });
        }
        params["ContentVariables"] = contentVariables;

        // Optional delivery callback (useful for debugging async failures)
        const statusCallback = String(process.env.TWILIO_STATUS_CALLBACK_URL || "").trim();
        if (statusCallback) {
            params["StatusCallback"] = statusCallback;
        }

        logTwilioCredentialDiagnostics("before send");

        try {
            const { result: sendResp, auth } = await withTwilioAuthFallback((candidate) =>
                axios.post(url, new URLSearchParams(params).toString(), {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    auth: { username: candidate.username, password: candidate.password },
                    timeout: 10000,
                })
            );
            const sid = sendResp?.data?.sid as string | undefined;

            // Twilio accepts the request but delivery can still fail asynchronously.
            // Fetch the message resource once to surface immediate errors/status.
            let status: string | undefined = sendResp?.data?.status;
            let errorCode: any = sendResp?.data?.error_code;
            let errorMessage: any = sendResp?.data?.error_message;
            if (sid) {
                try {
                    const msgUrl = twilioMessageUrl(accountSid, sid);
                    const msgResp = await axios.get(msgUrl, {
                        auth: { username: auth.username, password: auth.password },
                        timeout: 10000,
                    });
                    status = msgResp?.data?.status ?? status;
                    errorCode = msgResp?.data?.error_code ?? errorCode;
                    errorMessage = msgResp?.data?.error_message ?? errorMessage;
                } catch {
                    // ignore; initial send response still useful
                }
            }

            return { provider: "twilio", to: digits, mode: "twilio-template", sid, status, errorCode, errorMessage };
        } catch (e: any) {
            logTwilioCredentialDiagnostics("send failed");
            throw new Error(`Twilio WhatsApp send failed: ${extractAxiosErrorMessage(e)}`);
        }
    }

    // Cloud provider
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
        throw new Error(formatProviderConfigError(provider));
    }

    const digits = extractDigitsOrThrow(opts.to);
    const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

    try {
        await axios.post(
            url,
            {
                messaging_product: "whatsapp",
                to: digits,
                type: "text",
                text: { body: opts.message },
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                timeout: 10000,
            }
        );
        return { provider: "cloud", to: digits, mode: "cloud-text" };
    } catch (e: any) {
        // If outside window, try template; otherwise bubble error
        if (!isOutsideWindowError(e)) {
            throw new Error(`WhatsApp Cloud send failed: ${extractAxiosErrorMessage(e)}`);
        }

        // Template fallback (strict)
        const templateName = (process.env.WHATSAPP_TEMPLATE_NAME || "payment_confirmation").trim();
        const languageCode = (process.env.WHATSAPP_TEMPLATE_LANGUAGE_CODE || "en_US").trim();
        if (!templateName || !languageCode) {
            throw new Error("WhatsApp Cloud template fallback not configured (WHATSAPP_TEMPLATE_NAME / WHATSAPP_TEMPLATE_LANGUAGE_CODE).");
        }
        try {
            await axios.post(
                url,
                {
                    messaging_product: "whatsapp",
                    to: digits,
                    type: "template",
                    template: {
                        name: templateName,
                        language: { code: languageCode },
                        components: [
                            {
                                type: "body",
                                parameters: [{ type: "text", text: opts.message }],
                            },
                        ],
                    },
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 10000,
                }
            );
            return { provider: "cloud", to: digits, mode: "cloud-template" };
        } catch (e2: any) {
            throw new Error(`WhatsApp Cloud template send failed: ${extractAxiosErrorMessage(e2)}`);
        }
    }
}

function resolveOverrideDigits(): string | undefined {
    const override = process.env.WHATSAPP_OVERRIDE_TO?.trim();
    if (!override) return undefined;
    if (override.startsWith('whatsapp:')) {
        return override.replace(/[^0-9]/g, '');
    }
    return override.replace(/\D/g, '');
}

async function sendViaCloud({ to, message }: WhatsAppSendOptions): Promise<void> {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
        console.warn("WhatsApp Cloud not configured: missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
        return;
    }

    // Normalize phone (remove non-digits and leading '+')
    const overrideDigits = resolveOverrideDigits();
    const normalizedTo = (overrideDigits || to || "").replace(/\D/g, "");
    if (!normalizedTo) {
        console.warn("WhatsApp not sent: invalid recipient phone");
        return;
    }

    const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
    try {
        await axios.post(
            url,
            {
                messaging_product: "whatsapp",
                to: normalizedTo,
                type: "text",
                text: { body: message },
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                timeout: 10000,
            }
        );
    } catch (error: any) {
        const status = error?.response?.status;
        const data = error?.response?.data;
        console.error("WhatsApp Cloud send failed", { status, data, message: error?.message });

        // Fallback: If outside 24h customer window, try sending a template
        if (isOutsideWindowError(error)) {
            await sendViaCloudTemplate({
                token,
                phoneNumberId,
                to: normalizedTo,
                message,
            });
        }
    }
}

async function sendViaTwilio(opts: WhatsAppSendOptions): Promise<void> {
    const accountSid = getTwilioAccountSid();
    const from = normalizeTwilioWhatsAppFrom(process.env.TWILIO_WHATSAPP_FROM);
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    if (!accountSid || getTwilioHttpAuthCandidates().length === 0 || (!from && !messagingServiceSid)) {
        console.warn("Twilio not configured: missing TWILIO_ACCOUNT_SID, auth credentials, and either TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID");
        return;
    }
 
    await sendViaTwilioTemplate(opts);  
}

export function composePaidMessage(params: {
    fullName?: string | null;
    username?: string;
    amount?: number;
    invoiceId?: number;
}): string {
    const name = params.fullName || params.username || "Customer";
    const amountStr = typeof params.amount === 'number' ? params.amount.toFixed(2) : undefined;
    const invoiceRef = params.invoiceId ? ` (Invoice #${params.invoiceId})` : "";
    return `Hi ${name}, your payment${invoiceRef} has been received${amountStr ? `: $${amountStr}` : ''}. Thank you!`;
}

/** Notify subscriber that Whish was approved and wallet was credited. */
export function composeWalletCreditMessage(params: {
    fullName?: string | null;
    username?: string;
    amount?: number;
    balance?: number;
    invoiceId?: number;
}): string {
    const name = params.fullName || params.username || "Customer";
    const amountStr = typeof params.amount === "number" ? params.amount.toFixed(2) : "0.00";
    const balStr = typeof params.balance === "number" ? params.balance.toFixed(2) : null;
    const inv = params.invoiceId ? ` (for invoice #${params.invoiceId})` : "";
    return (
        `Hi ${name}, $${amountStr} was credited to your wallet${inv}.` +
        (balStr != null ? ` Current balance: $${balStr}.` : "") +
        ` Open the subscriber portal and tap Pay from wallet to settle your invoice.`
    );
}


function isOutsideWindowError(error: any): boolean {
    try {
        const code = error?.response?.data?.error?.code;
        const fbSubcode = error?.response?.data?.error?.error_subcode;
        const msg: string = error?.response?.data?.error?.message || "";
        // Known Cloud API patterns for the 24h window restriction
        return (
            msg.toLowerCase().includes("outside the allowed window") ||
            code === 131051 || // Common code for outside 24h window
            fbSubcode === 2018047 // Sometimes returned as subcode
        );
    } catch {
        return false;
    }
}

async function sendViaCloudTemplate(params: {
    token: string | undefined;
    phoneNumberId: string | undefined;
    to: string; // digits only
    message: string; // we pass as a single body parameter
}): Promise<void> {
    const { token, phoneNumberId, to, message } = params;
    if (!token || !phoneNumberId) {
        console.warn("WhatsApp Cloud template not sent: missing configuration");
        return;
    }

    const templateName = (process.env.WHATSAPP_TEMPLATE_NAME || "payment_confirmation").trim();
    const languageCode = (process.env.WHATSAPP_TEMPLATE_LANGUAGE_CODE || "en_US").trim();
    if (!templateName || !languageCode) {
        console.warn("WhatsApp Cloud template not sent: missing WHATSAPP_TEMPLATE_NAME or WHATSAPP_TEMPLATE_LANGUAGE_CODE");
        return;
    }

    const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
    try {
        await axios.post(
            url,
            {
                messaging_product: "whatsapp",
                to,
                type: "template",
                template: {
                    name: templateName,
                    language: { code: languageCode },
                    components: [
                        {
                            type: "body",
                            parameters: [
                                { type: "text", text: message }
                            ]
                        }
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                timeout: 10000,
            }
        );
        console.log("WhatsApp Cloud template sent as fallback");
    } catch (error: any) {
        const status = error?.response?.status;
        const data = error?.response?.data;
        console.error("WhatsApp Cloud template send failed", { status, data, message: error?.message });
    }
}


async function sendViaTwilioTemplate(opts: WhatsAppSendOptions): Promise<void> {
    const { to, message, templateVariables, templateKind } = opts;
    const accountSid = getTwilioAccountSid();
    const from = normalizeTwilioWhatsAppFrom(process.env.TWILIO_WHATSAPP_FROM);
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    let contentSid: string;
    try {
        contentSid = opts.contentSid || resolveTwilioContentSid(templateKind);
    } catch (e: any) {
        console.warn(String(e?.message || e));
        return;
    }

    if (
        !accountSid ||
        getTwilioHttpAuthCandidates().length === 0 ||
        (!from && !messagingServiceSid) ||
        !contentSid
    ) {
        console.warn("Twilio template not configured: require TWILIO_ACCOUNT_SID, auth credentials, (TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID), and content SID");
        return;
    }

    const overrideDigitsTwilio = resolveOverrideDigits();
    let digits = (overrideDigitsTwilio || to || "").replace(/\D/g, "");
    if (!digits) {
        console.warn("Twilio WhatsApp template not sent: invalid recipient phone");
        return;
    }
    const toParam = `whatsapp:+${digits}`;

    const url = twilioMessagesUrl(accountSid);
    const params: Record<string, string> = {
        To: toParam,
        ...(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid } : { From: from as string }),
        ContentSid: contentSid,
    };

    // Build ContentVariables JSON.
    // Precedence: explicit templateVariables param > TWILIO_CONTENT_VARIABLES_JSON > default { message }
    let contentVariables = process.env.TWILIO_CONTENT_VARIABLES_JSON;
    if (templateVariables && Object.keys(templateVariables).length > 0) {
        try {
            const normalized: Record<string, string> = {};
            for (const [k, v] of Object.entries(templateVariables)) {
                normalized[String(k)] = String(v);
            }
            contentVariables = JSON.stringify(normalized);
        } catch {
            contentVariables = JSON.stringify({ message });
        }
    }
    if (contentVariables) {
        try {
            const parsed = JSON.parse(contentVariables);
            if (
                parsed &&
                typeof parsed === "object" &&
                parsed.message === undefined &&
                templateKind !== "reminder"
            ) {
                (parsed as any).message = message;
            }
            contentVariables = JSON.stringify(parsed);
        } catch {
            contentVariables =
                templateKind === "reminder"
                    ? JSON.stringify({ "1": message })
                    : JSON.stringify({ message });
        }
    } else if (templateKind === "reminder") {
        contentVariables = JSON.stringify({ "1": message });
    } else {
        contentVariables = JSON.stringify({ message });
    }
    params["ContentVariables"] = contentVariables;

    const body = new URLSearchParams(params).toString();
    try {
        const { result } = await withTwilioAuthFallback((auth) =>
            axios.post(url, body, {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                auth: { username: auth.username, password: auth.password },
                timeout: 10000,
            })
        );
        const { data } = result;
        console.log("Twilio template SID:", data.sid);
    } catch (error: any) {
        const status = error?.response?.status;
        const data = error?.response?.data;
        console.error("Twilio WhatsApp template send failed", { status, data, message: error?.message });
    }
}
