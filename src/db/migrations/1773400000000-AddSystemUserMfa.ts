import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSystemUserMfa1773400000000 implements MigrationInterface {
  name = "AddSystemUserMfa1773400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE system_users
        ADD COLUMN mfa_enabled TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN totp_secret_encrypted VARCHAR(512) NULL,
        ADD COLUMN mfa_enrolled_at TIMESTAMP NULL,
        ADD COLUMN mfa_backup_codes_hash TEXT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE system_users
        DROP COLUMN mfa_backup_codes_hash,
        DROP COLUMN mfa_enrolled_at,
        DROP COLUMN totp_secret_encrypted,
        DROP COLUMN mfa_enabled
    `);
  }
}
