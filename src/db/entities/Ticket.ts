import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type TicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketCategory = "network" | "billing" | "installation" | "service" | "other";
export type TicketSource = "phone" | "whatsapp" | "email" | "walk_in" | "portal";

/**
 * A support ticket.
 *
 * The SLA deadlines are stored on the row (rather than derived on read) so a
 * later change to the policy cannot retroactively move the target of a ticket
 * that is already running.
 */
@Entity("tickets", { schema: "radius" })
@Index("idx_tickets_status", ["status"])
@Index("idx_tickets_assignee", ["assignee"])
@Index("idx_tickets_requester", ["requester"])
@Index("idx_tickets_resolve_due", ["resolveDueAt"])
export class Ticket {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id?: number;

  @Column("varchar", { name: "subject", length: 200 })
  subject: string;

  @Column("text", { name: "description", nullable: true })
  description: string | null;

  @Column("varchar", { name: "status", length: 20, default: () => "'open'" })
  status: TicketStatus;

  @Column("varchar", { name: "priority", length: 10, default: () => "'normal'" })
  priority: TicketPriority;

  @Column("varchar", { name: "category", length: 24, default: () => "'other'" })
  category: TicketCategory;

  @Column("varchar", { name: "source", length: 20, default: () => "'phone'" })
  source: TicketSource;

  /** Subscriber username when the ticket is tied to one; null for general tickets. */
  @Column("varchar", { name: "requester", length: 64, nullable: true })
  requester: string | null;

  @Column("varchar", { name: "assignee", length: 64, nullable: true })
  assignee: string | null;

  @Column("timestamp", { name: "first_response_due_at", nullable: true })
  firstResponseDueAt: Date | null;

  @Column("timestamp", { name: "resolve_due_at", nullable: true })
  resolveDueAt: Date | null;

  @Column("timestamp", { name: "first_responded_at", nullable: true })
  firstRespondedAt: Date | null;

  @Column("timestamp", { name: "resolved_at", nullable: true })
  resolvedAt: Date | null;

  @Column("timestamp", { name: "closed_at", nullable: true })
  closedAt: Date | null;

  /** Set by the SLA job the first time a deadline is missed. */
  @Column("timestamp", { name: "sla_breached_at", nullable: true })
  slaBreachedAt: Date | null;

  @Column("varchar", { name: "created_by", length: 64, nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamp" })
  updatedAt: Date;
}
