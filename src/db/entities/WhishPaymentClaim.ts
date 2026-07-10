import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Index("idx_whish_claim_invoice", ["externalInvoiceId"], {})
@Index("idx_whish_claim_status", ["status"], {})
@Index("idx_whish_claim_reference", ["whishReference"], {})
@Entity("whish_payment_claims", { schema: "radius" })
export class WhishPaymentClaim {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("int", { name: "external_invoice_id" })
  externalInvoiceId!: number;

  @Column("varchar", { name: "username", length: 64 })
  username!: string;

  @Column("float", { name: "amount", precision: 12 })
  amount!: number;

  @Column("varchar", { name: "currency", length: 8, default: () => "'USD'" })
  currency!: string;

  /** Whish transaction / reference number from the payer's receipt */
  @Column("varchar", { name: "whish_reference", length: 128 })
  whishReference!: string;

  @Column("varchar", { name: "status", length: 20, default: () => "'pending'" })
  status!: "pending" | "confirmed" | "rejected";

  @Column("varchar", { name: "note", nullable: true, length: 512 })
  note!: string | null;

  @Column("varchar", { name: "confirmed_by", nullable: true, length: 64 })
  confirmedBy!: string | null;

  @Column("timestamp", { name: "confirmed_at", nullable: true })
  confirmedAt!: Date | null;

  @Column("varchar", { name: "rejection_reason", nullable: true, length: 255 })
  rejectionReason!: string | null;

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
