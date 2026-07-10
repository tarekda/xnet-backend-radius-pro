import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Index("idx_payment_intent_gateway", ["gatewayIntentId"], { unique: true })
@Index("idx_payment_intent_invoice", ["externalInvoiceId"], {})
@Entity("payment_intents", { schema: "radius" })
export class PaymentIntent {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("int", { name: "external_invoice_id" })
  externalInvoiceId!: number;

  @Column("varchar", { name: "gateway_provider", length: 32, default: () => "'stub'" })
  gatewayProvider!: string;

  @Column("varchar", { name: "gateway_intent_id", length: 128 })
  gatewayIntentId!: string;

  @Column("varchar", { name: "status", length: 20, default: () => "'pending'" })
  status!: "pending" | "succeeded" | "failed" | "expired";

  @Column("float", { name: "amount", precision: 12 })
  amount!: number;

  @Column("varchar", { name: "currency", length: 8, default: () => "'USD'" })
  currency!: string;

  @Column("varchar", { name: "checkout_url", nullable: true, length: 512 })
  checkoutUrl!: string | null;

  @Column("json", { name: "metadata", nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column("timestamp", {
    name: "created_at",
    nullable: true,
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date | null;

  @Column("timestamp", {
    name: "updated_at",
    nullable: true,
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt!: Date | null;
}
