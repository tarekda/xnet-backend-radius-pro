import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** A recurring report delivery: which report, how often, and who receives it. */
@Entity("report_schedules", { schema: "radius" })
@Index("idx_report_schedules_enabled", ["enabled"])
export class ReportSchedule {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id?: number;

  @Column("varchar", { name: "name", length: 128 })
  name: string;

  /** Key of a report in the report registry (`revenue-monthly`, `ar-aging`, ...). */
  @Column("varchar", { name: "report_key", length: 64 })
  reportKey: string;

  @Column("varchar", { name: "format", length: 10, default: () => "'xlsx'" })
  format: "csv" | "xlsx";

  /** Comma-separated recipient addresses. */
  @Column("text", { name: "recipients" })
  recipients: string;

  /** Standard 5-field cron expression, e.g. `0 7 * * 1` for Mondays at 07:00. */
  @Column("varchar", { name: "cron_expr", length: 64 })
  cronExpr: string;

  /** Report parameters as a flat string map. */
  @Column("json", { name: "params", nullable: true })
  params: Record<string, string> | null;

  @Column("tinyint", { name: "enabled", width: 1, default: () => "'1'" })
  enabled: boolean;

  @Column("timestamp", { name: "last_run_at", nullable: true })
  lastRunAt: Date | null;

  @Column("varchar", { name: "last_status", length: 16, nullable: true })
  lastStatus: "success" | "failed" | null;

  @Column("text", { name: "last_error", nullable: true })
  lastError: string | null;

  @Column("int", { name: "last_duration_ms", nullable: true })
  lastDurationMs: number | null;

  @Column("varchar", { name: "created_by", length: 64, nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamp" })
  updatedAt: Date;
}
