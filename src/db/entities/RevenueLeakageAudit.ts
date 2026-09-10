import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type LeakageType =
  | "EXPIRED_UNPAID_ONLINE"
  | "GHOST_STALE_SESSION"
  | "PROFILE_SPEED_MISALIGNMENT"
  | "CONCURRENT_SESSION_LEAK";

export type RemediationAction =
  | "none"
  | "mikrotik_disconnect"
  | "coa_disconnect"
  | "re_quarantine"
  | "manual_disconnect";

export type AuditStatus = "detected" | "remediated" | "ignored";

@Entity("revenue_leakage_audits")
@Index("idx_rla_username", ["username"])
@Index("idx_rla_status", ["status"])
@Index("idx_rla_leak_type", ["leakType"])
@Index("idx_rla_detected_at", ["detectedAt"])
export class RevenueLeakageAudit {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 64 })
  username!: string;

  @Column({ type: "varchar", length: 128, nullable: true })
  fullName!: string | null;

  @Column({ type: "varchar", length: 45, nullable: true })
  nasIp!: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  nasIdentifier!: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  callerId!: string | null;

  @Column({ type: "varchar", length: 45, nullable: true })
  framedIp!: string | null;

  @Column({ type: "varchar", length: 64 })
  leakType!: LeakageType;

  @Column({ type: "text", nullable: true })
  leakReason!: string | null;

  @Column({ type: "bigint", default: 0 })
  bytesIn!: string;

  @Column({ type: "bigint", default: 0 })
  bytesOut!: string;

  @Column({ type: "int", nullable: true })
  unpaidInvoiceId!: number | null;

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  unpaidAmount!: number;

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  estimatedLossUsd!: number;

  @Column({ type: "varchar", length: 64, default: "none" })
  remediationAction!: RemediationAction;

  @Column({ type: "varchar", length: 32, default: "detected" })
  status!: AuditStatus;

  @CreateDateColumn({ type: "datetime" })
  detectedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  resolvedBy!: string | null;

  @Column({ type: "json", nullable: true })
  metadata!: Record<string, any> | null;

  @UpdateDateColumn({ type: "datetime" })
  updatedAt!: Date;
}
