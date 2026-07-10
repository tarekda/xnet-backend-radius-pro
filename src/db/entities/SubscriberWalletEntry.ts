import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Index("idx_subscriber_wallet_username", ["username"], {})
@Index("idx_subscriber_wallet_ref", ["referenceType", "referenceId"], {})
@Entity("subscriber_wallet_ledger", { schema: "radius" })
export class SubscriberWalletEntry {
  @PrimaryGeneratedColumn({ type: "bigint", name: "id" })
  id!: string;

  @Column("varchar", { name: "username", length: 64 })
  username!: string;

  @Column("decimal", { name: "amount", precision: 12, scale: 2 })
  amount!: string;

  @Column("varchar", { name: "currency", length: 8, default: () => "'USD'" })
  currency!: string;

  @Column("enum", { name: "entry_type", enum: ["credit", "debit"] })
  entryType!: "credit" | "debit";

  @Column("varchar", { name: "reference_type", length: 64, nullable: true })
  referenceType!: string | null;

  @Column("varchar", { name: "reference_id", length: 64, nullable: true })
  referenceId!: string | null;

  @Column("varchar", { name: "note", length: 255, nullable: true })
  note!: string | null;

  @Column("varchar", { name: "created_by", length: 64, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;
}
