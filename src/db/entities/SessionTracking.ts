import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("idx_session", ["sessionId"], {})
@Index("idx_status", ["status"], {})
@Index("idx_username", ["username"], {})
@Index("idx_status_username", ["status", "username"], {})
@Entity("session_tracking", { schema: "radius" })
export class SessionTracking {
  @PrimaryGeneratedColumn({ type: "bigint", name: "id" })
  id: string;

  @Column("varchar", { name: "username", length: 64 })
  username: string;

  @Column("varchar", { name: "session_id", length: 64 })
  sessionId: string;

  @Column("varchar", { name: "mac_address", length: 17 })
  macAddress: string;

  @Column("datetime", { name: "start_time" })
  startTime: Date;

  @Column("datetime", { name: "end_time", nullable: true })
  endTime: Date | null;

  @Column("datetime", { name: "last_update", nullable: true })
  lastUpdate: Date | null;

  @Column("varchar", { name: "nas_ip", nullable: true, length: 15 })
  nasIp: string | null;

  @Column("varchar", { name: "framed_ip", nullable: true, length: 15 })
  framedIp: string | null;

  @Column("bigint", { name: "bytes_in", nullable: true, default: () => "'0'" })
  bytesIn: string | null;

  @Column("bigint", { name: "bytes_out", nullable: true, default: () => "'0'" })
  bytesOut: string | null;

  @Column("int", { name: "session_time", nullable: true, default: () => "'0'" })
  sessionTime: number | null;

  @Column("enum", {
    name: "status",
    enum: ["active", "completed", "terminated"],
  })
  status: "active" | "completed" | "terminated";

  @Column("bigint", {
    name: "daily_bytes_in",
    nullable: true,
    default: () => "'0'",
  })
  dailyBytesIn: string | null;

  @Column("bigint", {
    name: "daily_bytes_out",
    nullable: true,
    default: () => "'0'",
  })
  dailyBytesOut: string | null;

  @Column("int", {
    name: "daily_session_time",
    nullable: true,
    default: () => "'0'",
  })
  dailySessionTime: number | null;
}
