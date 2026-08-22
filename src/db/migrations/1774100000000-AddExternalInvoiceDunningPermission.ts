import { MigrationInterface, QueryRunner } from "typeorm";
import { PERMISSIONS } from "../../access/permissions";

const DUNNING_PERM = "billing.externalInvoices.dunning";

export class AddExternalInvoiceDunningPermission1774100000000 implements MigrationInterface {
  name = "AddExternalInvoiceDunningPermission1774100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!PERMISSIONS.includes(DUNNING_PERM)) {
      throw new Error(`Permission not registered in PERMISSIONS: ${DUNNING_PERM}`);
    }

    const rows: Array<{ id: number }> = await queryRunner.query(
      "SELECT id FROM roles WHERE `key` IN ('admin','manager')"
    );

    for (const r of rows) {
      await queryRunner.query(
        "INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)",
        [r.id, DUNNING_PERM]
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM role_permissions WHERE permission = ?", [DUNNING_PERM]);
  }
}
