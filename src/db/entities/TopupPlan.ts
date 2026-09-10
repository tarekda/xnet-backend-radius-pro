import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("topup_plans", { schema: "radius" })
export class TopupPlan {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("varchar", { name: "name", length: 64 })
  name!: string;

  /** Extra quota in bytes (e.g. 20 * 1024^3 for 20 GB) */
  @Column("bigint", { name: "extra_bytes" })
  extraBytes!: string;

  @Column("decimal", { name: "price", precision: 10, scale: 2 })
  price!: string;

  @Column("varchar", { name: "currency", length: 8, default: () => "'USD'" })
  currency!: string;

  @Column("tinyint", {
    name: "is_active",
    width: 1,
    default: () => "'1'",
  })
  isActive!: boolean;

  @Column("int", { name: "sort_order", default: () => "'0'" })
  sortOrder!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @UpdateDateColumn({
    name: "updated_at",
    type: "timestamp",
    default: () => "CURRENT_TIMESTAMP",
    onUpdate: "CURRENT_TIMESTAMP",
  })
  updatedAt!: Date;
}
