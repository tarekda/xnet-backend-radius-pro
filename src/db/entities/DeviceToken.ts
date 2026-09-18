import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * An Expo push token belonging to a signed-in staff device.
 *
 * A token identifies a device installation, not a person, so the row is
 * re-pointed at whoever signed in last and deleted as soon as Expo reports
 * the token as unregistered.
 */
@Entity("device_tokens", { schema: "radius" })
@Index("idx_device_tokens_username", ["username"])
@Index("uniq_device_tokens_token", ["token"], { unique: true })
export class DeviceToken {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id?: number;

  @Column("varchar", { name: "username", length: 64 })
  username: string;

  @Column("varchar", { name: "token", length: 255 })
  token: string;

  @Column("varchar", { name: "platform", length: 16, default: () => "'android'" })
  platform: string;

  @Column("varchar", { name: "device_name", length: 128, nullable: true })
  deviceName: string | null;

  @Column("tinyint", { name: "is_active", width: 1, default: () => "'1'" })
  isActive: boolean | number;

  @Column("timestamp", { name: "last_seen_at", nullable: true })
  lastSeenAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamp" })
  updatedAt: Date;
}
