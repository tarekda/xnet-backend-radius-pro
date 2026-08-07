import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExternalInvoiceProviderMac1774000000000 implements MigrationInterface {
  name = "AddExternalInvoiceProviderMac1774000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE external_invoices
        ADD COLUMN provider_mac_address VARCHAR(17) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE external_invoices
        DROP COLUMN provider_mac_address
    `);
  }
}
