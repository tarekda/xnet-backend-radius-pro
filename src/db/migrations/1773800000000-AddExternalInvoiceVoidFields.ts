import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExternalInvoiceVoidFields1773800000000 implements MigrationInterface {
  name = "AddExternalInvoiceVoidFields1773800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE external_invoices
        ADD COLUMN voided_at TIMESTAMP NULL,
        ADD COLUMN voided_by VARCHAR(64) NULL,
        ADD COLUMN void_reason VARCHAR(255) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE external_invoices
        DROP COLUMN void_reason,
        DROP COLUMN voided_by,
        DROP COLUMN voided_at
    `);
  }
}
