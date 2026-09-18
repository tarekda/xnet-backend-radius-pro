import { MigrationInterface, QueryRunner } from "typeorm";
import { PERMISSIONS } from "../../access/permissions";

const VIEW = "support.tickets.view";
const MANAGE = "support.tickets.manage";
const NAV = "ui.sidebar.support.tickets.show";
const ROLES = ["admin", "manager", "support"];

/**
 * Creates the ticketing tables and grants the support permissions to the
 * staff roles that answer subscriber calls.
 */
export class AddTicketingModule1775000000000 implements MigrationInterface {
  name = "AddTicketingModule1775000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const permission of [VIEW, MANAGE, NAV]) {
      if (!PERMISSIONS.includes(permission as (typeof PERMISSIONS)[number])) {
        throw new Error(`${permission} is not registered in PERMISSIONS`);
      }
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INT NOT NULL AUTO_INCREMENT,
        subject VARCHAR(200) NOT NULL,
        description TEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        priority VARCHAR(10) NOT NULL DEFAULT 'normal',
        category VARCHAR(24) NOT NULL DEFAULT 'other',
        source VARCHAR(20) NOT NULL DEFAULT 'phone',
        requester VARCHAR(64) NULL,
        assignee VARCHAR(64) NULL,
        first_response_due_at TIMESTAMP NULL,
        resolve_due_at TIMESTAMP NULL,
        first_responded_at TIMESTAMP NULL,
        resolved_at TIMESTAMP NULL,
        closed_at TIMESTAMP NULL,
        sla_breached_at TIMESTAMP NULL,
        created_by VARCHAR(64) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_tickets_status (status),
        KEY idx_tickets_assignee (assignee),
        KEY idx_tickets_requester (requester),
        KEY idx_tickets_resolve_due (resolve_due_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ticket_comments (
        id INT NOT NULL AUTO_INCREMENT,
        ticket_id INT NOT NULL,
        author VARCHAR(64) NULL,
        body TEXT NOT NULL,
        visibility VARCHAR(10) NOT NULL DEFAULT 'public',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_ticket_comments_ticket (ticket_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const placeholders = ROLES.map(() => "?").join(", ");
    const rows: Array<{ id: number }> = await queryRunner.query(
      `SELECT id FROM roles WHERE \`key\` IN (${placeholders})`,
      ROLES
    );

    for (const role of rows) {
      for (const permission of [VIEW, MANAGE, NAV]) {
        await queryRunner.query(
          "INSERT IGNORE INTO role_permissions (roleId, permission) VALUES (?, ?)",
          [role.id, permission]
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const placeholders = [VIEW, MANAGE, NAV].map(() => "?").join(", ");
    await queryRunner.query(`DELETE FROM role_permissions WHERE permission IN (${placeholders})`, [
      VIEW,
      MANAGE,
      NAV,
    ]);
    await queryRunner.query("DROP TABLE IF EXISTS ticket_comments");
    await queryRunner.query("DROP TABLE IF EXISTS tickets");
  }
}
