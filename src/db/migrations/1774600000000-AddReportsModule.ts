import { MigrationInterface, QueryRunner } from "typeorm";
import { PERMISSIONS } from "../../access/permissions";

const VIEW = "admin.reports.view";
const NAV = "ui.sidebar.admin.reports.show";
const ROLES = ["admin", "manager", "support", "collector"];

/**
 * Registers the reports-module permissions and grants them to the operational
 * roles. No tables are needed — every report is derived from existing data.
 */
export class AddReportsModule1774600000000 implements MigrationInterface {
  name = "AddReportsModule1774600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!PERMISSIONS.includes(VIEW) || !PERMISSIONS.includes(NAV)) {
      throw new Error("Reports permissions are not registered in PERMISSIONS");
    }

    const placeholders = ROLES.map(() => "?").join(", ");
    const rows: Array<{ id: number }> = await queryRunner.query(
      `SELECT id FROM roles WHERE \`key\` IN (${placeholders})`,
      ROLES
    );

    for (const role of rows) {
      await queryRunner.query(
        "INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)",
        [role.id, VIEW]
      );
      await queryRunner.query(
        "INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)",
        [role.id, NAV]
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM role_permissions WHERE permission IN (?, ?)", [
      VIEW,
      NAV,
    ]);
  }
}
