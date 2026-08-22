import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("idx_invoice_payments_invoice", ["externalInvoiceId"])
@Entity("invoice_payments", { schema: "radius" })
export class InvoicePayment {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("int", { name: "external_invoice_id" })
  externalInvoiceId!: number;

  @Column("decimal", { name: "amount", precision: 12, scale: 2 })
  amount!: string;

  @Column("varchar", { name: "method", length: 20 })
  method!: string;

  @Column("varchar", { name: "payment_reference", length: 128, nullable: true })
  paymentReference!: string | null;

  @Column("varchar", { name: "payment_provider", length: 32, nullable: true })
  paymentProvider!: string | null;

  @Column("varchar", { name: "created_by", length: 64, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column("timestamp", { name: "voided_at", nullable: true })
  voidedAt!: Date | null;

  @Column("varchar", { name: "voided_by", length: 64, nullable: true })
  voidedBy!: string | null;
}
