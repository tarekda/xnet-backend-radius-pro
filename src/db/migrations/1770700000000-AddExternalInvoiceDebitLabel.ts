import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExternalInvoiceDebitLabel1770700000000 implements MigrationInterface {
  name = "AddExternalInvoiceDebitLabel1770700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'external_invoices'
         AND COLUMN_NAME = 'debitLabel'`
    )) as Array<{ cnt: string | number }>;
    const exists = Number(rows?.[0]?.cnt ?? 0) > 0;
    if (!exists) {
      await queryRunner.query(
        `ALTER TABLE external_invoices
           ADD COLUMN debitLabel VARCHAR(64) NOT NULL DEFAULT ''
           AFTER provider`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'external_invoices'
         AND COLUMN_NAME = 'debitLabel'`
    )) as Array<{ cnt: string | number }>;
    const exists = Number(rows?.[0]?.cnt ?? 0) > 0;
    if (exists) {
      await queryRunner.query(`ALTER TABLE external_invoices DROP COLUMN debitLabel`);
    }
  }
}
