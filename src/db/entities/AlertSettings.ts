import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import type { AlertSettingsPayload } from "../../alerts/alertMetrics";

@Entity("alert_settings", { schema: "radius" })
export class AlertSettings {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("json", { name: "payload" })
  payload!: AlertSettingsPayload;

  @Column("timestamp", {
    name: "updated_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt!: Date;
}
