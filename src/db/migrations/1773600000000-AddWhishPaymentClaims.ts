import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhishPaymentClaims1773600000000 implements MigrationInterface {
  name = "AddWhishPaymentClaims1773600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS whish_payment_claims (
        id INT NOT NULL AUTO_INCREMENT,
        external_invoice_id INT NOT NULL,
        username VARCHAR(64) NOT NULL,
        amount FLOAT NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        whish_reference VARCHAR(128) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        note VARCHAR(512) NULL,
        confirmed_by VARCHAR(64) NULL,
        confirmed_at TIMESTAMP NULL,
        rejection_reason VARCHAR(255) NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_whish_claim_invoice (external_invoice_id),
        KEY idx_whish_claim_status (status),
        KEY idx_whish_claim_reference (whish_reference)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await queryRunner.query(`
      ALTER TABLE external_invoices
        ADD COLUMN payment_reference VARCHAR(128) NULL,
        ADD COLUMN payment_provider VARCHAR(32) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE external_invoices
        DROP COLUMN payment_provider,
        DROP COLUMN payment_reference
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS whish_payment_claims`);
  }
}
