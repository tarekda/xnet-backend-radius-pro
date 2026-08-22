import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhatsappInboundMessages1774400000000 implements MigrationInterface {
  name = "AddWhatsappInboundMessages1774400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
        id INT NOT NULL AUTO_INCREMENT,
        from_number VARCHAR(64) NOT NULL,
        raw_text TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'received',
        parsed_names JSON NULL,
        extracted_amount DECIMAL(12,2) NULL,
        overpayment_amount DECIMAL(12,2) NULL,
        paid_invoice_ids JSON NULL,
        message_sid VARCHAR(128) NULL,
        error_detail TEXT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_wa_inbound_from (from_number),
        KEY idx_wa_inbound_status (status),
        KEY idx_wa_inbound_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS whatsapp_inbound_messages`);
  }
}
