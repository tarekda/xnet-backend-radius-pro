import { DataSource } from 'typeorm';
import 'reflect-metadata';
import { SessionTrackingSubscriber } from './subscribers/sessionTrackingSubscriber';
import dotenv from "dotenv";

// Ensure CLI commands (typeorm migrations) also load .env
dotenv.config();

// Import all entities directly for Docker compatibility
import { BlockedMacs } from './entities/BlockedMacs';
import { ConnectionLogs } from './entities/ConnectionLogs';
import { DetailedUsage } from './entities/DetailedUsage';
import { ExternalInvoice } from './entities/ExternalInvoice';
import { Invoices } from './entities/Invoices';
import { Logs } from './entities/Logs';
import { ModificationLog } from './entities/ModificationLog';
import { Nas } from './entities/Nas';
import { QuotaLogs } from './entities/QuotaLogs';
import { Radacct } from './entities/Radacct';
import { Radcheck } from './entities/Radcheck';
import { Radprofile } from './entities/Radprofile';
import { Radusagestats } from './entities/Radusagestats';
import { Raduserprofile } from './entities/Raduserprofile';
import { RefreshTokens } from './entities/RefreshTokens';
import { SessionTracking } from './entities/SessionTracking';
import { Settings } from './entities/Settings';
import { SystemUsers } from './entities/SystemUsers';
import { TimeRestrictions } from './entities/TimeRestrictions';
import { UserDetails } from './entities/UserDetails';
import { UserMac } from './entities/UserMac';
import { Expense } from './entities/Expense';
import { Role } from './entities/Role';
import { RolePermission } from './entities/RolePermission';
import { UserPermissionOverride } from './entities/UserPermissionOverride';
import { Reseller } from './entities/Reseller';
import { ResellerLedgerEntry } from './entities/ResellerLedgerEntry';
import { CableVisionAccount } from './entities/CableVisionAccount';
import { CableVisionProfile } from './entities/CableVisionProfile';
import { CableVisionInvoice } from './entities/CableVisionInvoice';
import { SubscriberRefreshTokens } from './entities/SubscriberRefreshTokens';
import { PaymentIntent } from './entities/PaymentIntent';
import { WhishPaymentClaim } from './entities/WhishPaymentClaim';
import { WhatsappPaymentAmbiguity } from './entities/WhatsappPaymentAmbiguity';
import { WhatsappInboundMessage } from './entities/WhatsappInboundMessage';
import { SubscriberWalletEntry } from './entities/SubscriberWalletEntry';
import { AlertRule } from './entities/AlertRule';
import { AlertIncident } from './entities/AlertIncident';
import { AlertSettings } from './entities/AlertSettings';
import { CompanyWalletEntry } from './entities/CompanyWalletEntry';
import { InvoicePayment } from './entities/InvoicePayment';

// Create entities array with explicit references
const entities = [
    BlockedMacs,
    ConnectionLogs,
    DetailedUsage,
    CableVisionAccount,
    CableVisionProfile,
    CableVisionInvoice,
    ExternalInvoice,
    Invoices,
    Logs,
    ModificationLog,
    Nas,
    QuotaLogs,
    Radacct,
    Radcheck,
    Radprofile,
    Radusagestats,
    Raduserprofile,
    RefreshTokens,
    SubscriberRefreshTokens,
    PaymentIntent,
    WhishPaymentClaim,
    WhatsappPaymentAmbiguity,
    WhatsappInboundMessage,
    SubscriberWalletEntry,
    Role,
    RolePermission,
    Reseller,
    ResellerLedgerEntry,
    SessionTracking,
    Settings,
    SystemUsers,
    TimeRestrictions,
    UserDetails,
    UserMac,
    UserPermissionOverride,
    Expense,
    AlertRule,
    AlertIncident,
    AlertSettings,
    CompanyWalletEntry,
    InvoicePayment,
];

export const AppDataSource = new DataSource({
    type: "mysql",
    host: process.env.DB_HOST || "host.docker.internal",
    port: parseInt(process.env.DB_PORT || "3306"),
    username: process.env.DB_USERNAME || "radius",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "radius",
    synchronize: process.env.TYPEORM_SYNCHRONIZE === "true",
    logging: process.env.DB_LOGGING_ENABLED === 'true',
    entities: entities,
    migrations: [
        process.env.NODE_ENV === 'production' 
            ? "dist/db/migrations/**/*.js" 
            : "src/db/migrations/**/*.ts"
    ],
    subscribers: [SessionTrackingSubscriber]
});

async function ensureExternalInvoiceLastRemindedAtColumn(): Promise<void> {
    const rows = (await AppDataSource.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'external_invoices'
           AND COLUMN_NAME = 'lastRemindedAt'`
    )) as Array<{ cnt: string | number }>;
    if (Number(rows?.[0]?.cnt ?? 0) > 0) return;
    await AppDataSource.query(
        `ALTER TABLE external_invoices
           ADD COLUMN lastRemindedAt TIMESTAMP NULL DEFAULT NULL
           AFTER lastAction`
    );
    console.log("✅ Added external_invoices.lastRemindedAt");
}

async function ensureQuotaCycleStartDateColumn(): Promise<void> {
    const rows = (await AppDataSource.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'raduserprofile'
           AND COLUMN_NAME = 'quota_cycle_start_date'`
    )) as Array<{ cnt: string | number }>;
    if (Number(rows?.[0]?.cnt ?? 0) > 0) return;
    await AppDataSource.query(
        `ALTER TABLE raduserprofile
           ADD COLUMN quota_cycle_start_date DATE NULL DEFAULT NULL
           AFTER quota_reset_day`
    );
    console.log("✅ Added raduserprofile.quota_cycle_start_date");
}

async function ensureExternalInvoiceDebitLabelColumn(): Promise<void> {
    const rows = (await AppDataSource.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'external_invoices'
           AND COLUMN_NAME = 'debitLabel'`
    )) as Array<{ cnt: string | number }>;
    if (Number(rows?.[0]?.cnt ?? 0) > 0) return;
    await AppDataSource.query(
        `ALTER TABLE external_invoices
           ADD COLUMN debitLabel VARCHAR(64) NOT NULL DEFAULT ''
           AFTER provider`
    );
    console.log("✅ Added external_invoices.debitLabel");
}

async function ensureExternalInvoiceAmountPaidColumn(): Promise<void> {
    const rows = (await AppDataSource.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'external_invoices'
           AND COLUMN_NAME = 'amount_paid'`
    )) as Array<{ cnt: string | number }>;
    if (Number(rows?.[0]?.cnt ?? 0) > 0) return;
    await AppDataSource.query(
        `ALTER TABLE external_invoices
           ADD COLUMN amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0
           AFTER total_amount`
    );
    console.log("✅ Added external_invoices.amount_paid");
}

async function ensureCompanyWalletAndInvoicePaymentTables(): Promise<void> {
    await AppDataSource.query(`
      CREATE TABLE IF NOT EXISTS company_wallet_ledger (
        id BIGINT NOT NULL AUTO_INCREMENT,
        amount DECIMAL(12,2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        entry_type ENUM('credit','debit') NOT NULL,
        reference_type VARCHAR(64) NULL,
        reference_id VARCHAR(64) NULL,
        note VARCHAR(255) NULL,
        created_by VARCHAR(64) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_company_wallet_ref (reference_type, reference_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await AppDataSource.query(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id INT NOT NULL AUTO_INCREMENT,
        external_invoice_id INT NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        method VARCHAR(20) NOT NULL,
        payment_reference VARCHAR(128) NULL,
        payment_provider VARCHAR(32) NULL,
        created_by VARCHAR(64) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        voided_at TIMESTAMP NULL,
        voided_by VARCHAR(64) NULL,
        PRIMARY KEY (id),
        KEY idx_invoice_payments_invoice (external_invoice_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export const initializeDB = async () => {
    try {
        // Debug: Log entities being loaded
        console.log('🔍 Loading entities:', entities.map(e => e.name));
        console.log('📋 Total entities to load:', entities.length);
        console.log('🔍 Logs entity:', Logs);
        
        await AppDataSource.initialize();
        console.log("✅ Database connection established");
        console.log("✅ Entities loaded:", AppDataSource.entityMetadatas.map(e => e.name));

        try {
            await ensureQuotaCycleStartDateColumn();
        } catch (patchError: any) {
            console.warn("⚠️ quota_cycle_start_date schema patch skipped:", patchError?.message || patchError);
        }

        try {
            await ensureExternalInvoiceLastRemindedAtColumn();
        } catch (patchError: any) {
            console.warn("⚠️ lastRemindedAt schema patch skipped:", patchError?.message || patchError);
        }

        try {
            await ensureExternalInvoiceDebitLabelColumn();
        } catch (patchError: any) {
            console.warn("⚠️ debitLabel schema patch skipped:", patchError?.message || patchError);
        }

        try {
            await ensureExternalInvoiceAmountPaidColumn();
        } catch (patchError: any) {
            console.warn("⚠️ amount_paid schema patch skipped:", patchError?.message || patchError);
        }

        try {
            await ensureCompanyWalletAndInvoicePaymentTables();
        } catch (patchError: any) {
            console.warn("⚠️ company wallet / invoice_payments schema patch skipped:", patchError?.message || patchError);
        }
    } catch (error: any) {
        console.error("❌ Error connecting to database:", error);
        console.error("❌ Error details:", error.message);
        if (error.message && error.message.includes('metadata')) {
            console.error("🔍 This appears to be an entity metadata issue");
            console.error("🔍 Available entities:", entities.map(e => e.name));
        }
        process.exit(1);
    }
};