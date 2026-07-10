import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSubscriberWalletLedger1773700000000 implements MigrationInterface {
  name = "AddSubscriberWalletLedger1773700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS subscriber_wallet_ledger (
        id BIGINT NOT NULL AUTO_INCREMENT,
        username VARCHAR(64) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        entry_type ENUM('credit','debit') NOT NULL,
        reference_type VARCHAR(64) NULL,
        reference_id VARCHAR(64) NULL,
        note VARCHAR(255) NULL,
        created_by VARCHAR(64) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_subscriber_wallet_username (username),
        KEY idx_subscriber_wallet_ref (reference_type, reference_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS subscriber_wallet_ledger`);
  }
}
