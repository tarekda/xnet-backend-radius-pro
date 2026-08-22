import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("idx_alert_incidents_resolved_ts", ["resolved", "timestamp"])
@Index("idx_alert_incidents_rule_resolved", ["ruleId", "resolved"])
@Entity("alert_incidents", { schema: "radius" })
export class AlertIncident {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("int", { name: "rule_id", nullable: true })
  ruleId!: number | null;

  @Column("varchar", { name: "rule_name", length: 255 })
  ruleName!: string;

  @Column("varchar", { name: "severity", length: 20 })
  severity!: string;

  @Column("text", { name: "message" })
  message!: string;

  @Column("varchar", { name: "metric", length: 64 })
  metric!: string;

  @Column("double", { name: "value" })
  value!: number;

  @Column("double", { name: "threshold" })
  threshold!: number;

  @Column("timestamp", {
    name: "timestamp",
    default: () => "CURRENT_TIMESTAMP",
  })
  timestamp!: Date;

  @Column("tinyint", { name: "acknowledged", width: 1, default: () => "'0'" })
  acknowledged!: boolean;

  @Column("varchar", { name: "acknowledged_by", nullable: true, length: 128 })
  acknowledgedBy!: string | null;

  @Column("timestamp", { name: "acknowledged_at", nullable: true })
  acknowledgedAt!: Date | null;

  @Column("tinyint", { name: "resolved", width: 1, default: () => "'0'" })
  resolved!: boolean;

  @Column("timestamp", { name: "resolved_at", nullable: true })
  resolvedAt!: Date | null;
}
