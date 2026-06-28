import { Column, Entity, OneToMany, PrimaryGeneratedColumn, DeleteDateColumn } from "typeorm";
import { ModificationLog } from "./ModificationLog";

@Entity("external_invoices", { schema: "radius" })
export class ExternalInvoice {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id?: number;

  @Column("varchar", { name: "username", length: 64 })
  username: string;

  @Column("varchar", { name: "email", length: 128 })
  email: string;

  @Column("text", { name: "address", nullable: true })
  address: string | null;

  @Column("float", { name: "amount", precision: 12 })
  amount: number;

  @Column("varchar", { name: "status", length: 10, default: () => "'unpaid'" })
  status: string;

  @Column("varchar", { name: "fullName", length: 128 })
  fullName: string;

  @Column("varchar", { name: "phoneNumber", length: 32 })
  phoneNumber: string;

  @Column("date", { name: "billingMonth" })
  billingMonth: string;

  /** Target date when payment should be received (editable; used for reminders / tracker). */
  @Column("date", { name: "payDueDate", nullable: true })
  payDueDate: string | null;

  @Column("timestamp", {
    name: "createdAt",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;

  @Column("timestamp", { name: "paidAt", nullable: true })
  paidAt: Date | null;

  @Column("varchar", { name: "paymentMethod", nullable: true, length: 20 })
  paymentMethod: string | null;

  @Column("varchar", { name: "collectedBy", nullable: true, length: 64 })
  collectedBy: string | null;

  @Column("timestamp", { name: "collectedAt", nullable: true })
  collectedAt: Date | null;

  @Column("tinyint", { name: "cashReconciled", width: 1, default: () => "'0'" })
  cashReconciled: boolean;

  @Column("varchar", { name: "reconciledBy", nullable: true, length: 64 })
  reconciledBy: string | null;

  @Column("timestamp", { name: "reconciledAt", nullable: true })
  reconciledAt: Date | null;

  @Column("varchar", { name: "modifiedBy", nullable: true, length: 64 })
  modifiedBy?: string | null;

  @Column("varchar", { name: "deletedBy", nullable: true, length: 64 })
  deletedBy?: string | null;

  @Column("varchar", { name: "lastAction", nullable: true, length: 255 })
  lastAction: string | null;

  /** Last time a WhatsApp payment reminder was sent (single, bulk, or dunning). */
  @Column("timestamp", { name: "lastRemindedAt", nullable: true })
  lastRemindedAt?: Date | null;

  @Column("varchar", { name: "provider", length: 10 })
  provider: string;

  /** Optional line label for multiple charges per user/month (e.g. carryover, second debit). Empty = primary line. */
  @Column("varchar", { name: "debitLabel", length: 64, default: () => "''" })
  debitLabel: string;

  @Column("datetime", {
    name: "modifiedAt",
    nullable: true,
  })
  modifiedAt?: Date | null;

  @DeleteDateColumn({ name: "deletedAt", type: "datetime", nullable: true })
  deletedAt?: Date | null;

  @OneToMany(
    () => ModificationLog,
    (modificationLog) => modificationLog.invoice
  )
  modificationLog?: ModificationLog[];
}
