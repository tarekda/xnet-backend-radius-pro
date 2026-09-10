import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhatsappInboundOcrColumns1774500000000 implements MigrationInterface {
  name = "AddWhatsappInboundOcrColumns1774500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_inbound_messages
        ADD COLUMN media_url VARCHAR(512) NULL AFTER message_sid,
        ADD COLUMN media_type VARCHAR(64) NULL AFTER media_url,
        ADD COLUMN ocr_raw_text TEXT NULL AFTER media_type,
        ADD COLUMN ocr_extracted_data JSON NULL AFTER ocr_raw_text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_inbound_messages
        DROP COLUMN ocr_extracted_data,
        DROP COLUMN ocr_raw_text,
        DROP COLUMN media_type,
        DROP COLUMN media_url
    `);
  }
}
