import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSubscriberAndPaymentGateway1773500000000 implements MigrationInterface {
  name = "AddSubscriberAndPaymentGateway1773500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS subscriber_refresh_tokens (
        id INT NOT NULL AUTO_INCREMENT,
        token VARCHAR(512) NOT NULL,
        username VARCHAR(64) NOT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP NULL,
        PRIMARY KEY (id),
        UNIQUE KEY idx_subscriber_refresh_token (token),
        KEY idx_subscriber_refresh_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS payment_intents (
        id INT NOT NULL AUTO_INCREMENT,
        external_invoice_id INT NOT NULL,
        gateway_provider VARCHAR(32) NOT NULL DEFAULT 'stub',
        gateway_intent_id VARCHAR(128) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        amount FLOAT NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        checkout_url VARCHAR(512) NULL,
        metadata JSON NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY idx_payment_intent_gateway (gateway_intent_id),
        KEY idx_payment_intent_invoice (external_invoice_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await queryRunner.query(`
      ALTER TABLE external_invoices
        ADD COLUMN subtotal_amount FLOAT NULL,
        ADD COLUMN tax_rate FLOAT NULL,
        ADD COLUMN tax_amount FLOAT NULL,
        ADD COLUMN total_amount FLOAT NULL,
        ADD COLUMN document_type VARCHAR(20) NOT NULL DEFAULT 'invoice',
        ADD COLUMN parent_invoice_id INT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE external_invoices
        DROP COLUMN parent_invoice_id,
        DROP COLUMN document_type,
        DROP COLUMN total_amount,
        DROP COLUMN tax_amount,
        DROP COLUMN tax_rate,
        DROP COLUMN subtotal_amount
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS payment_intents`);
    await queryRunner.query(`DROP TABLE IF EXISTS subscriber_refresh_tokens`);
  }
}
