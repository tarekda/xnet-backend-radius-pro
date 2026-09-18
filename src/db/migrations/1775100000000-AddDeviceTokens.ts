import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Push tokens for the staff mobile app.
 *
 * The token is unique: re-installing the app or signing in as another user
 * moves the existing row rather than adding a second one.
 */
export class AddDeviceTokens1775100000000 implements MigrationInterface {
  name = "AddDeviceTokens1775100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id INT NOT NULL AUTO_INCREMENT,
        username VARCHAR(64) NOT NULL,
        token VARCHAR(255) NOT NULL,
        platform VARCHAR(16) NOT NULL DEFAULT 'android',
        device_name VARCHAR(128) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        last_seen_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_device_tokens_token (token),
        KEY idx_device_tokens_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS device_tokens");
  }
}
