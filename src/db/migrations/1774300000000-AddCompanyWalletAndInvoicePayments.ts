import { MigrationInterface, QueryRunner } from "typeorm";
import { PERMISSIONS } from "../../access/permissions";

const VIEW = "billing.companyWallet.view";
const MANAGE = "billing.companyWallet.manage";
const NAV = "ui.sidebar.admin.companyWallet.show";

export class AddCompanyWalletAndInvoicePayments1774300000000 implements MigrationInterface {
  name = "AddCompanyWalletAndInvoicePayments1774300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!PERMISSIONS.includes(VIEW) || !PERMISSIONS.includes(MANAGE) || !PERMISSIONS.includes(NAV)) {
      throw new Error("Company wallet permissions are not registered in PERMISSIONS");
    }

    await queryRunner.query(`
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

    await queryRunner.query(`
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

    const amountPaidCol = (await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_invoices' AND COLUMN_NAME = 'amount_paid'`
    )) as Array<{ cnt: string | number }>;
    if (Number(amountPaidCol?.[0]?.cnt ?? 0) === 0) {
      await queryRunner.query(`
        ALTER TABLE external_invoices
          ADD COLUMN amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0
      `);
    }

    await queryRunner.query(`
      UPDATE external_invoices ei
      LEFT JOIN (
        SELECT CAST(SUBSTRING_INDEX(e.reference_id, ':', 1) AS UNSIGNED) AS invoice_id,
               SUM(e.amount) AS paid
          FROM subscriber_wallet_ledger e
         WHERE e.entry_type = 'debit'
           AND e.reference_type = 'external_invoice'
         GROUP BY CAST(SUBSTRING_INDEX(e.reference_id, ':', 1) AS UNSIGNED)
      ) w ON w.invoice_id = ei.id
         SET ei.amount_paid = CASE
           WHEN ei.status = 'paid' THEN COALESCE(ei.total_amount, ei.amount, 0)
           ELSE COALESCE(w.paid, ei.amount_paid, 0)
         END
    `);

    const rows: Array<{ id: number }> = await queryRunner.query(
      "SELECT id FROM roles WHERE `key` IN ('admin','manager')"
    );
    for (const r of rows) {
      await queryRunner.query("INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)", [r.id, VIEW]);
      await queryRunner.query("INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)", [r.id, MANAGE]);
      await queryRunner.query("INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)", [r.id, NAV]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM role_permissions WHERE permission IN (?, ?, ?)", [VIEW, MANAGE, NAV]);
    await queryRunner.query(`DROP TABLE IF EXISTS invoice_payments`);
    await queryRunner.query(`DROP TABLE IF EXISTS company_wallet_ledger`);
    const amountPaidCol = (await queryRunner.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_invoices' AND COLUMN_NAME = 'amount_paid'`
    )) as Array<{ cnt: string | number }>;
    if (Number(amountPaidCol?.[0]?.cnt ?? 0) > 0) {
      await queryRunner.query(`ALTER TABLE external_invoices DROP COLUMN amount_paid`);
    }
  }
}
