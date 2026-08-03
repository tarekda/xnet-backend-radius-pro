import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("idx_wa_amb_status", ["status"], {})
@Index("idx_wa_amb_billing_month", ["billingMonth"], {})
@Entity("whatsapp_payment_ambiguities", { schema: "radius" })
export class WhatsappPaymentAmbiguity {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("varchar", { name: "submitted_name", length: 128 })
  submittedName!: string;

  @Column("date", { name: "billing_month" })
  billingMonth!: string;

  @Column("json", { name: "candidate_invoice_ids" })
  candidateInvoiceIds!: number[];

  @Column("varchar", { name: "status", length: 20, default: () => "'pending'" })
  status!: "pending" | "resolved" | "dismissed";

  @Column("int", { name: "resolved_invoice_id", nullable: true })
  resolvedInvoiceId!: number | null;

  @Column("varchar", { name: "resolved_by", nullable: true, length: 64 })
  resolvedBy!: string | null;

  @Column("timestamp", { name: "resolved_at", nullable: true })
  resolvedAt!: Date | null;

  @Column("varchar", { name: "dismiss_reason", nullable: true, length: 255 })
  dismissReason!: string | null;

  @Column("varchar", { name: "source_from", nullable: true, length: 64 })
  sourceFrom!: string | null;

  @Column("varchar", { name: "message_id", nullable: true, length: 128 })
  messageId!: string | null;

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
