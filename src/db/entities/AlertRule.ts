import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("alert_rules", { schema: "radius" })
export class AlertRule {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("varchar", { name: "name", length: 255 })
  name!: string;

  @Column("text", { name: "description", nullable: true })
  description!: string | null;

  @Column("varchar", { name: "metric", length: 64 })
  metric!: string;

  @Column("varchar", { name: "condition", length: 32 })
  condition!: string;

  @Column("double", { name: "threshold" })
  threshold!: number;

  @Column("int", { name: "duration", default: 5 })
  duration!: number;

  @Column("varchar", { name: "severity", length: 20 })
  severity!: string;

  @Column("tinyint", { name: "enabled", width: 1, default: () => "'1'" })
  enabled!: boolean;

  @Column("timestamp", {
    name: "created_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;

  @Column("timestamp", {
    name: "updated_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt!: Date;

  @Column("timestamp", { name: "last_triggered", nullable: true })
  lastTriggered!: Date | null;

  @Column("int", { name: "trigger_count", default: 0 })
  triggerCount!: number;
}
