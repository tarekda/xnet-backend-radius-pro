import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Invoices } from "./Invoices";
import { Radprofile } from "./Radprofile";

@Index("profile_id", ["profileId"], {})
@Index("idx_rup_username", ["username"], {})
@Index("idx_rup_status", ["accountStatus"], {})
@Index("idx_rup_reseller", ["ownerResellerId"], {})
@Entity("raduserprofile", { schema: "radius" })
export class Raduserprofile {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id: number;

  @Column("varchar", { name: "username", length: 64 })
  username: string;

  @Column("int", { name: "profile_id" })
  profileId: number;

  @Column("tinyint", {
    name: "freenight",
    nullable: true,
    width: 1,
    default: () => "'0'",
  })
  freenight: boolean | null;

  @Column("tinyint", {
    name: "is_fallback",
    nullable: true,
    width: 1,
    default: () => "'0'",
  })
  isFallback: boolean | null;

  @Column("tinyint", {
    name: "is_monthly_exceeded",
    nullable: true,
    width: 1,
    default: () => "'0'",
  })
  isMonthlyExceeded: boolean | null;

  @Column("int", {
    name: "quota_reset_day",
    nullable: true,
    default: () => "'1'",
  })
  quotaResetDay: number | null;

  /** Optional manual anchor for the current monthly billing cycle (YYYY-MM-DD). */
  @Column("date", { name: "quota_cycle_start_date", nullable: true })
  quotaCycleStartDate: string | null;

  @Column("varchar", {
    name: "account_status",
    nullable: true,
    length: 20,
    default: () => "'active'",
  })
  accountStatus: string | null;

  /** When set and in the past (with status still active), RADIUS flips user to `expired` and applies walled-garden replies. */
  @Column("datetime", { name: "expires_at", nullable: true })
  expiresAt: Date | null;

  /** Optional per-user framed IP for expired sessions; falls back to EXPIRY_FRAMED_IP on the RADIUS server. */
  @Column("varchar", { name: "expiry_framed_ip", nullable: true, length: 45 })
  expiryFramedIp: string | null;

  @Column("int", { name: "owner_reseller_id", nullable: true })
  ownerResellerId: number | null;

  @OneToMany(() => Invoices, (invoices) => invoices.userProfile)
  invoices: Invoices[];

  @ManyToOne(() => Radprofile, (radprofile) => radprofile.raduserprofiles, {
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  })
  @JoinColumn([{ name: "profile_id", referencedColumnName: "id" }])
  profile: Radprofile;
}
