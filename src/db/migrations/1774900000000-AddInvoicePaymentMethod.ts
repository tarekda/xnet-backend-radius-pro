import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The `Invoices` entity declares `payment_method`, but the live `invoices`
 * table never had it — so every TypeORM read of that entity (for example the
 * monthly invoice generator, which runs on the 1st of each month) fails with
 * `Unknown column 'payment_method'`.
 *
 * The column is added to match the entity, mirroring `external_invoices` and
 * `cable_vision_invoices`, which already carry the same field.
 */
const COLUMN = "payment_method";
const DEFINITION = "VARCHAR(20) NULL";

export class AddInvoicePaymentMethod1774900000000 implements MigrationInterface {
  name = "AddInvoicePaymentMethod1774900000000";

  private async hasColumn(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'invoices'
         AND COLUMN_NAME = ?`,
      [COLUMN]
    )) as Array<{ cnt: string | number }>;
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner)) return;
    await queryRunner.query(
      `ALTER TABLE invoices ADD COLUMN ${COLUMN} ${DEFINITION}`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner))) return;
    await queryRunner.query(`ALTER TABLE invoices DROP COLUMN ${COLUMN}`);
  }
}
