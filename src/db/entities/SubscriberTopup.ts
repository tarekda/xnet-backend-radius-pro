import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Index("idx_subscriber_topup_user", ["username"], {})
@Index("idx_subscriber_topup_status", ["status"], {})
@Index("idx_subscriber_topup_month", ["billingMonth"], {})
@Entity("subscriber_topups", { schema: "radius" })
export class SubscriberTopup {
  @PrimaryGeneratedColumn({ type: "bigint", name: "id" })
  id!: string;

  @Column("varchar", { name: "username", length: 64 })
  username!: string;

  @Column("int", { name: "plan_id", nullable: true })
  planId!: number | null;

  @Column("varchar", { name: "plan_name", length: 64 })
  planName!: string;

  @Column("bigint", { name: "extra_bytes" })
  extraBytes!: string;

  @Column("decimal", { name: "price", precision: 10, scale: 2 })
  price!: string;

  @Column("varchar", { name: "currency", length: 8, default: () => "'USD'" })
  currency!: string;

  @Column("varchar", { name: "billing_month", length: 7 })
  billingMonth!: string; // YYYY-MM

  @Column("enum", {
    name: "payment_method",
    enum: ["wallet", "invoice_debit", "cash", "whish", "admin_grant"],
    default: "invoice_debit",
  })
  paymentMethod!: "wallet" | "invoice_debit" | "cash" | "whish" | "admin_grant";

  @Column("int", { name: "invoice_id", nullable: true })
  invoiceId!: number | null;

  @Column("enum", {
    name: "status",
    enum: ["active", "consumed", "expired", "cancelled"],
    default: "active",
  })
  status!: "active" | "consumed" | "expired" | "cancelled";

  @Column("datetime", { name: "expires_at", nullable: true })
  expiresAt!: Date | null;

  @Column("varchar", { name: "created_by", length: 64, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;
}
