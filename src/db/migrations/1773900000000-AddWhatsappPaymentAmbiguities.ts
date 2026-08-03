import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhatsappPaymentAmbiguities1773900000000 implements MigrationInterface {
  name = "AddWhatsappPaymentAmbiguities1773900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_payment_ambiguities (
        id INT NOT NULL AUTO_INCREMENT,
        submitted_name VARCHAR(128) NOT NULL,
        billing_month DATE NOT NULL,
        candidate_invoice_ids JSON NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        resolved_invoice_id INT NULL,
        resolved_by VARCHAR(64) NULL,
        resolved_at TIMESTAMP NULL,
        dismiss_reason VARCHAR(255) NULL,
        source_from VARCHAR(64) NULL,
        message_id VARCHAR(128) NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_wa_amb_status (status),
        KEY idx_wa_amb_billing_month (billing_month),
        KEY idx_wa_amb_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS whatsapp_payment_ambiguities`);
  }
}
