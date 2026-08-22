import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAlertTables1774200000000 implements MigrationInterface {
  name = "CreateAlertTables1774200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        description TEXT NULL,
        metric VARCHAR(64) NOT NULL,
        \`condition\` VARCHAR(32) NOT NULL,
        threshold DOUBLE NOT NULL,
        duration INT NOT NULL DEFAULT 5,
        severity VARCHAR(20) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_triggered TIMESTAMP NULL,
        trigger_count INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        KEY idx_alert_rules_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert_incidents (
        id INT NOT NULL AUTO_INCREMENT,
        rule_id INT NULL,
        rule_name VARCHAR(255) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        metric VARCHAR(64) NOT NULL,
        value DOUBLE NOT NULL,
        threshold DOUBLE NOT NULL,
        timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        acknowledged TINYINT(1) NOT NULL DEFAULT 0,
        acknowledged_by VARCHAR(128) NULL,
        acknowledged_at TIMESTAMP NULL,
        resolved TINYINT(1) NOT NULL DEFAULT 0,
        resolved_at TIMESTAMP NULL,
        PRIMARY KEY (id),
        KEY idx_alert_incidents_resolved_ts (resolved, timestamp),
        KEY idx_alert_incidents_rule_resolved (rule_id, resolved),
        CONSTRAINT fk_alert_incidents_rule
          FOREIGN KEY (rule_id) REFERENCES alert_rules (id)
          ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert_settings (
        id INT NOT NULL AUTO_INCREMENT,
        payload JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS alert_incidents`);
    await queryRunner.query(`DROP TABLE IF EXISTS alert_rules`);
    await queryRunner.query(`DROP TABLE IF EXISTS alert_settings`);
  }
}
