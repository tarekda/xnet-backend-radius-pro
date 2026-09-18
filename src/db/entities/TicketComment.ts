import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

export type TicketCommentVisibility = "public" | "internal";

/** One entry in a ticket's conversation thread. */
@Entity("ticket_comments", { schema: "radius" })
@Index("idx_ticket_comments_ticket", ["ticketId"])
export class TicketComment {
  @PrimaryGeneratedColumn({ type: "int", name: "id" })
  id?: number;

  @Column("int", { name: "ticket_id" })
  ticketId: number;

  @Column("varchar", { name: "author", length: 64, nullable: true })
  author: string | null;

  @Column("text", { name: "body" })
  body: string;

  /** `internal` notes stay inside the team and are never shown to the subscriber. */
  @Column("varchar", { name: "visibility", length: 10, default: () => "'public'" })
  visibility: TicketCommentVisibility;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;
}
