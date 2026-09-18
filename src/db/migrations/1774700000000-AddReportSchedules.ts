import { MigrationInterface, QueryRunner } from "typeorm";
import { PERMISSIONS } from "../../access/permissions";

const MANAGE = "admin.reports.manage";
const ROLES = ["admin", "manager"];

/**
 * Adds the report-schedule table used for recurring emailed reports, and the
 * permission that gates managing them.
 */
export class AddReportSchedules1774700000000 implements MigrationInterface {
  name = "AddReportSchedules1774700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!PERMISSIONS.includes(MANAGE)) {
      throw new Error("admin.reports.manage is not registered in PERMISSIONS");
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS report_schedules (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(128) NOT NULL,
        report_key VARCHAR(64) NOT NULL,
        format VARCHAR(10) NOT NULL DEFAULT 'xlsx',
        recipients TEXT NOT NULL,
        cron_expr VARCHAR(64) NOT NULL,
        params JSON NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        last_run_at TIMESTAMP NULL,
        last_status VARCHAR(16) NULL,
        last_error TEXT NULL,
        last_duration_ms INT NULL,
        created_by VARCHAR(64) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_report_schedules_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const placeholders = ROLES.map(() => "?").join(", ");
    const rows: Array<{ id: number }> = await queryRunner.query(
      `SELECT id FROM roles WHERE \`key\` IN (${placeholders})`,
      ROLES
    );

    for (const role of rows) {
      await queryRunner.query(
        "INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)",
        [role.id, MANAGE]
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM role_permissions WHERE permission = ?", [MANAGE]);
    await queryRunner.query("DROP TABLE IF EXISTS report_schedules");
  }
}
