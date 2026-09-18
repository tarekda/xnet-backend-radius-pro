import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The `Invoices` entity has always declared the cash-collection and
 * reconciliation columns, but no migration ever added them to `invoices`, so
 * the daily revenue snapshot job failed on `Unknown column 'collected_at'`.
 *
 * Columns are appended (no `AFTER`) and each is added only when missing, so
 * this is safe regardless of the rest of the table's shape.
 */
const COLUMNS: Array<{ name: string; definition: string }> = [
  { name: "collected_by", definition: "VARCHAR(64) NULL" },
  { name: "collected_at", definition: "TIMESTAMP NULL" },
  { name: "cash_reconciled", definition: "TINYINT(1) NOT NULL DEFAULT 0" },
  { name: "reconciled_by", definition: "VARCHAR(64) NULL" },
  { name: "reconciled_at", definition: "TIMESTAMP NULL" },
];

export class AddInvoiceCollectionColumns1774800000000 implements MigrationInterface {
  name = "AddInvoiceCollectionColumns1774800000000";

  private async hasColumn(queryRunner: QueryRunner, column: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'invoices'
         AND COLUMN_NAME = ?`,
      [column]
    )) as Array<{ cnt: string | number }>;
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of COLUMNS) {
      if (await this.hasColumn(queryRunner, column.name)) continue;
      await queryRunner.query(
        `ALTER TABLE invoices ADD COLUMN ${column.name} ${column.definition}`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [...COLUMNS].reverse()) {
      if (!(await this.hasColumn(queryRunner, column.name))) continue;
      await queryRunner.query(`ALTER TABLE invoices DROP COLUMN ${column.name}`);
    }
  }
}
