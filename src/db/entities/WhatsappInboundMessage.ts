import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Index("idx_wa_inbound_from", ["fromNumber"], {})
@Index("idx_wa_inbound_status", ["status"], {})
@Index("idx_wa_inbound_created", ["createdAt"], {})
@Entity("whatsapp_inbound_messages", { schema: "radius" })
export class WhatsappInboundMessage {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("varchar", { name: "from_number", length: 64 })
  fromNumber!: string;

  @Column("text", { name: "raw_text" })
  rawText!: string;

  @Column("varchar", { name: "status", length: 20, default: () => "'received'" })
  status!: "received" | "processed" | "no_match" | "ambiguous" | "error" | "ignored";

  @Column("json", { name: "parsed_names", nullable: true })
  parsedNames!: string[] | null;

  @Column("decimal", { name: "extracted_amount", precision: 12, scale: 2, nullable: true })
  extractedAmount!: number | null;

  @Column("decimal", { name: "overpayment_amount", precision: 12, scale: 2, nullable: true })
  overpaymentAmount!: number | null;

  @Column("json", { name: "paid_invoice_ids", nullable: true })
  paidInvoiceIds!: number[] | null;

  @Column("varchar", { name: "message_sid", nullable: true, length: 128 })
  messageSid!: string | null;

  @Column("text", { name: "error_detail", nullable: true })
  errorDetail!: string | null;

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
