import {
  Column,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Radcheck } from "./Radcheck";
import { Invoices } from "./Invoices";

@Index("username", ["username"], { unique: true })
@Entity("user_details", { schema: "radius" })
export class UserDetails {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id!: number;

  @Column("varchar", { name: "username", unique: true, length: 64 })
  username!: string;

  @Column("varchar", { name: "full_name", nullable: true, length: 255 })
  fullName!: string | null;

  @Column("text", { name: "address", nullable: true })
  address!: string | null;

  @Column("varchar", { name: "phone_number", nullable: true, length: 20 })
  phoneNumber!: string | null;

  @Column("varchar", { name: "email", nullable: true, length: 255 })
  email!: string | null;

  @OneToOne(() => Radcheck, (radcheck) => radcheck.userDetails, {
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  })
  @JoinColumn([{ name: "username", referencedColumnName: "username" }])
  username2!: Radcheck;

  @OneToMany(() => Invoices, (invoice) => invoice.userDetails)
  invoices!: Invoices[];

}
