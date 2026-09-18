import { MigrationInterface, QueryRunner } from "typeorm";
import { PERMISSIONS } from "../../access/permissions";

const PERMISSION = "billing.invoices.pay";
const ROLES = ["admin", "manager", "collector", "support"];

/**
 * Turns the implicit "these roles may settle an invoice" rule on the invoice
 * pay/collect/reconcile routes into an explicit, revocable permission.
 *
 * The role list mirrors what those routes allowed before, so no one loses
 * access — but a deny override on a single user now takes effect.
 */
export class AddInvoicePayPermission1775200000000 implements MigrationInterface {
  name = "AddInvoicePayPermission1775200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!PERMISSIONS.includes(PERMISSION as (typeof PERMISSIONS)[number])) {
      throw new Error(`${PERMISSION} is not registered in PERMISSIONS`);
    }

    const placeholders = ROLES.map(() => "?").join(", ");
    const rows: Array<{ id: number }> = await queryRunner.query(
      `SELECT id FROM roles WHERE \`key\` IN (${placeholders})`,
      ROLES
    );

    for (const role of rows) {
      await queryRunner.query(
        "INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)",
        [role.id, PERMISSION]
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM role_permissions WHERE permission = ?", [PERMISSION]);
  }
}
