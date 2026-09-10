import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { UserDetails } from "./UserDetails";
import { Raduserprofile } from "./Raduserprofile";

@Index("idx_user_profile_id", ["userProfileId"], {})
@Index("idx_user_details_id", ["userDetailsId"], {})
@Index("idx_invoices_billing_month", ["billingMonth"], {})
@Index("idx_invoices_status", ["status"], {})
@Entity("invoices", { schema: "radius" })
export class Invoices {
  @PrimaryGeneratedColumn({ type: "int", name: "id", unsigned: true })
  id: number;

  @Column("int", { name: "user_profile_id" })
  userProfileId: number;

  @Column("int", { name: "user_details_id" })
  userDetailsId: number;

  @Column("varchar", { name: "billing_month", nullable: true, length: 20 })
  billingMonth: string | null;

  @Column("float", { name: "amount", precision: 12 })
  amount: number;

  @Column("varchar", { name: "status", length: 10, default: () => "'unpaid'" })
  status: string;

  @Column("timestamp", {
    name: "created_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;

  @Column("timestamp", { name: "paid_at", nullable: true })
  paidAt: Date | null;

  @Column("varchar", { name: "payment_method", nullable: true, length: 20 })
  paymentMethod: string | null;

  @Column("varchar", { name: "collected_by", nullable: true, length: 64 })
  collectedBy: string | null;

  @Column("timestamp", { name: "collected_at", nullable: true })
  collectedAt: Date | null;

  @Column("tinyint", { name: "cash_reconciled", width: 1, default: () => "'0'" })
  cashReconciled: boolean;

  @Column("varchar", { name: "reconciled_by", nullable: true, length: 64 })
  reconciledBy: string | null;

  @Column("timestamp", { name: "reconciled_at", nullable: true })
  reconciledAt: Date | null;

  @ManyToOne(() => UserDetails, (userDetails) => userDetails.invoices, {
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  })
  @JoinColumn([{ name: "user_details_id", referencedColumnName: "id" }])
  userDetails: UserDetails;

  @ManyToOne(
    () => Raduserprofile,
    (raduserprofile) => raduserprofile.invoices,
    { onDelete: "CASCADE", onUpdate: "NO ACTION" }
  )
  @JoinColumn([{ name: "user_profile_id", referencedColumnName: "id" }])
  userProfile: Raduserprofile;
}
