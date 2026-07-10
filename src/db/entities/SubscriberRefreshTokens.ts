import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Index("idx_subscriber_refresh_token", ["token"], { unique: true })
@Index("idx_subscriber_refresh_username", ["username"], {})
@Entity("subscriber_refresh_tokens", { schema: "radius" })
export class SubscriberRefreshTokens {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("varchar", { name: "token", length: 512 })
  token!: string;

  @Column("varchar", { name: "username", length: 64 })
  username!: string;

  @Column("timestamp", {
    name: "created_at",
    nullable: true,
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date | null;

  @Column("timestamp", { name: "revoked_at", nullable: true })
  revokedAt!: Date | null;
}
