/**
 * Ticketing.
 *
 * A ticket carries its own SLA deadlines (set from the priority at creation
 * time) so a later policy change cannot move the target of a ticket that is
 * already running. The SLA job only records breaches — the deadlines
 * themselves are never rewritten.
 */
import { AppDataSource } from "../db/config";
import {
  Ticket,
  type TicketCategory,
  type TicketPriority,
  type TicketSource,
  type TicketStatus,
} from "../db/entities/Ticket";
import { TicketComment, type TicketCommentVisibility } from "../db/entities/TicketComment";
import { notifyTicketSlaBreach } from "./pushNotificationService";

export type TicketInput = {
  subject: string;
  description?: string | null;
  priority?: TicketPriority;
  category?: TicketCategory;
  source?: TicketSource;
  requester?: string | null;
  assignee?: string | null;
};

export type TicketFilters = {
  status?: string;
  priority?: string;
  assignee?: string;
  requester?: string;
  search?: string;
  breachedOnly?: boolean;
  page?: number;
  limit?: number;
};

/** Statuses in which a ticket is still being worked on. */
export const ACTIVE_STATUSES: TicketStatus[] = ["open", "in_progress", "waiting"];

const STATUSES: TicketStatus[] = ["open", "in_progress", "waiting", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];
const CATEGORIES: TicketCategory[] = ["network", "billing", "installation", "service", "other"];
const SOURCES: TicketSource[] = ["phone", "whatsapp", "email", "walk_in", "portal"];

/** First-response and resolution targets per priority, in minutes. */
const SLA_POLICY: Record<TicketPriority, { firstResponse: number; resolve: number }> = {
  urgent: { firstResponse: 15, resolve: 4 * 60 },
  high: { firstResponse: 60, resolve: 8 * 60 },
  normal: { firstResponse: 4 * 60, resolve: 24 * 60 },
  low: { firstResponse: 8 * 60, resolve: 72 * 60 },
};

export const MAX_PAGE_SIZE = 100;

function minutesFromNow(minutes: number, from: Date): Date {
  return new Date(from.getTime() + minutes * 60 * 1000);
}

/** Deadlines a ticket created right now would carry for this priority. */
export function computeSlaDeadlines(
  priority: TicketPriority,
  from: Date = new Date()
): { firstResponseDueAt: Date; resolveDueAt: Date } {
  const policy = SLA_POLICY[priority];
  return {
    firstResponseDueAt: minutesFromNow(policy.firstResponse, from),
    resolveDueAt: minutesFromNow(policy.resolve, from),
  };
}

export function slaPolicySummary(): Array<{
  priority: TicketPriority;
  firstResponseMinutes: number;
  resolveMinutes: number;
}> {
  return PRIORITIES.map((priority) => ({
    priority,
    firstResponseMinutes: SLA_POLICY[priority].firstResponse,
    resolveMinutes: SLA_POLICY[priority].resolve,
  }));
}

function asEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  const normalized = String(value ?? "").trim() as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

/** Validates a create payload, returning the first problem found. */
export function validateTicketInput(input: TicketInput): string | null {
  if (!input.subject?.trim()) return "subject is required";
  if (input.subject.trim().length > 200) return "subject must be 200 characters or fewer";
  if (input.priority && !PRIORITIES.includes(input.priority)) {
    return `priority must be one of: ${PRIORITIES.join(", ")}`;
  }
  if (input.category && !CATEGORIES.includes(input.category)) {
    return `category must be one of: ${CATEGORIES.join(", ")}`;
  }
  if (input.source && !SOURCES.includes(input.source)) {
    return `source must be one of: ${SOURCES.join(", ")}`;
  }
  return null;
}

export async function createTicket(input: TicketInput, actor?: string): Promise<Ticket> {
  const problem = validateTicketInput(input);
  if (problem) throw new Error(problem);

  const priority = input.priority ?? "normal";
  const created = new Date();
  const deadlines = computeSlaDeadlines(priority, created);

  const repo = AppDataSource.getRepository(Ticket);
  const ticket = repo.create({
    subject: input.subject.trim(),
    description: input.description?.trim() || null,
    status: "open",
    priority,
    category: input.category ?? "other",
    source: input.source ?? "phone",
    requester: input.requester?.trim() || null,
    assignee: input.assignee?.trim() || null,
    firstResponseDueAt: deadlines.firstResponseDueAt,
    resolveDueAt: deadlines.resolveDueAt,
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    slaBreachedAt: null,
    createdBy: actor ?? null,
  });

  return repo.save(ticket);
}

export type TicketListResult = {
  data: Ticket[];
  total: number;
  page: number;
  totalPages: number;
  metrics: {
    open: number;
    inProgress: number;
    waiting: number;
    resolved: number;
    closed: number;
    breached: number;
  };
};

export async function listTickets(filters: TicketFilters = {}): Promise<TicketListResult> {
  const repo = AppDataSource.getRepository(Ticket);
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(filters.limit) || 25));

  const buildWhere = (qb: ReturnType<typeof repo.createQueryBuilder>) => {
    const status = String(filters.status ?? "").trim();
    if (status === "active") {
      qb.andWhere("t.status IN (:...activeStatuses)", { activeStatuses: ACTIVE_STATUSES });
    } else if (status && status !== "all" && STATUSES.includes(status as TicketStatus)) {
      qb.andWhere("t.status = :status", { status });
    }

    const priority = String(filters.priority ?? "").trim();
    if (priority && priority !== "all" && PRIORITIES.includes(priority as TicketPriority)) {
      qb.andWhere("t.priority = :priority", { priority });
    }

    if (filters.assignee) qb.andWhere("t.assignee = :assignee", { assignee: filters.assignee });
    if (filters.requester) qb.andWhere("t.requester = :requester", { requester: filters.requester });
    if (filters.breachedOnly) qb.andWhere("t.slaBreachedAt IS NOT NULL");

    const search = String(filters.search ?? "").trim();
    if (search) {
      qb.andWhere(
        "(t.subject LIKE :search OR t.description LIKE :search OR t.requester LIKE :search)",
        { search: `%${search}%` }
      );
    }
    return qb;
  };

  // Open and breached tickets first, then the most urgent, then newest.
  const rowsQuery = buildWhere(repo.createQueryBuilder("t"))
    .orderBy("CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END", "ASC")
    .addOrderBy("CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END", "ASC")
    .addOrderBy("t.createdAt", "DESC")
    .skip((page - 1) * limit)
    .take(limit);

  const [data, total] = await rowsQuery.getManyAndCount();

  const counts = await repo
    .createQueryBuilder("t")
    .select("t.status", "status")
    .addSelect("COUNT(*)", "count")
    .groupBy("t.status")
    .getRawMany<{ status: string; count: string }>();

  const byStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));
  const breached = await repo
    .createQueryBuilder("t")
    .where("t.slaBreachedAt IS NOT NULL")
    .andWhere("t.status IN (:...activeStatuses)", { activeStatuses: ACTIVE_STATUSES })
    .getCount();

  return {
    data,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    metrics: {
      open: byStatus.get("open") ?? 0,
      inProgress: byStatus.get("in_progress") ?? 0,
      waiting: byStatus.get("waiting") ?? 0,
      resolved: byStatus.get("resolved") ?? 0,
      closed: byStatus.get("closed") ?? 0,
      breached,
    },
  };
}

export async function getTicketById(id: number): Promise<Ticket> {
  const ticket = await AppDataSource.getRepository(Ticket).findOne({ where: { id } });
  if (!ticket) throw new Error("NOT_FOUND");
  return ticket;
}

export async function listTicketComments(ticketId: number): Promise<TicketComment[]> {
  return AppDataSource.getRepository(TicketComment).find({
    where: { ticketId },
    order: { createdAt: "ASC", id: "ASC" },
  });
}

export async function getTicketDetail(
  id: number
): Promise<{ ticket: Ticket; comments: TicketComment[] }> {
  const ticket = await getTicketById(id);
  const comments = await listTicketComments(id);
  return { ticket, comments };
}

/** Records the first staff reply, which is what the response SLA measures. */
async function markFirstResponse(ticket: Ticket, author?: string): Promise<void> {
  if (ticket.firstRespondedAt) return;
  if (author && ticket.requester && author === ticket.requester) return;
  ticket.firstRespondedAt = new Date();
  await AppDataSource.getRepository(Ticket).save(ticket);
}

export async function addTicketComment(
  ticketId: number,
  input: { body: string; author?: string; visibility?: TicketCommentVisibility }
): Promise<TicketComment> {
  const body = String(input.body ?? "").trim();
  if (!body) throw new Error("body is required");

  const ticket = await getTicketById(ticketId);
  const repo = AppDataSource.getRepository(TicketComment);

  const comment = await repo.save(
    repo.create({
      ticketId,
      body,
      author: input.author ?? null,
      visibility: input.visibility === "internal" ? "internal" : "public",
    })
  );

  // A public reply keeps a waiting ticket moving again.
  if (comment.visibility === "public") {
    await markFirstResponse(ticket, input.author);
    if (ticket.status === "waiting") {
      ticket.status = "in_progress";
      await AppDataSource.getRepository(Ticket).save(ticket);
    }
  }

  return comment;
}

export type TicketPatch = {
  subject?: string;
  description?: string | null;
  priority?: TicketPriority;
  category?: TicketCategory;
  source?: TicketSource;
  requester?: string | null;
};

export async function updateTicket(
  id: number,
  patch: TicketPatch,
  _actor?: string
): Promise<Ticket> {
  const repo = AppDataSource.getRepository(Ticket);
  const ticket = await repo.findOne({ where: { id } });
  if (!ticket) throw new Error("NOT_FOUND");

  if (patch.subject !== undefined) {
    const subject = String(patch.subject).trim();
    if (!subject) throw new Error("subject is required");
    ticket.subject = subject;
  }
  if (patch.description !== undefined) {
    ticket.description = patch.description ? String(patch.description).trim() : null;
  }
  if (patch.category !== undefined) {
    ticket.category = asEnum(patch.category, CATEGORIES, ticket.category);
  }
  if (patch.source !== undefined) {
    ticket.source = asEnum(patch.source, SOURCES, ticket.source);
  }
  if (patch.requester !== undefined) {
    ticket.requester = patch.requester ? String(patch.requester).trim() : null;
  }
  if (patch.priority !== undefined && patch.priority !== ticket.priority) {
    const priority = asEnum(patch.priority, PRIORITIES, ticket.priority);
    // Deadlines are re-derived only while the SLA clock is still running, so a
    // ticket that is already resolved keeps the target it was measured against.
    if (ACTIVE_STATUSES.includes(ticket.status)) {
      const deadlines = computeSlaDeadlines(priority, new Date());
      ticket.firstResponseDueAt = ticket.firstRespondedAt ? null : deadlines.firstResponseDueAt;
      ticket.resolveDueAt = deadlines.resolveDueAt;
    }
    ticket.priority = priority;
  }

  return repo.save(ticket);
}

export async function assignTicket(
  id: number,
  assignee: string | null,
  _actor?: string
): Promise<Ticket> {
  const repo = AppDataSource.getRepository(Ticket);
  const ticket = await repo.findOne({ where: { id } });
  if (!ticket) throw new Error("NOT_FOUND");

  ticket.assignee = assignee ? String(assignee).trim() : null;
  // Picking up an unassigned ticket counts as the first response.
  if (ticket.assignee && !ticket.firstRespondedAt && ticket.status === "open") {
    ticket.status = "in_progress";
    ticket.firstRespondedAt = new Date();
  }
  return repo.save(ticket);
}

export async function setTicketStatus(
  id: number,
  status: string,
  _actor?: string
): Promise<Ticket> {
  const repo = AppDataSource.getRepository(Ticket);
  const ticket = await repo.findOne({ where: { id } });
  if (!ticket) throw new Error("NOT_FOUND");

  const next = asEnum(status, STATUSES, ticket.status);
  const now = new Date();

  ticket.status = next;
  ticket.resolvedAt = next === "resolved" ? (ticket.resolvedAt ?? now) : null;
  ticket.closedAt = next === "closed" ? (ticket.closedAt ?? now) : null;
  if (ACTIVE_STATUSES.includes(next)) {
    ticket.resolvedAt = null;
    ticket.closedAt = null;
  }
  if (next !== "open" && !ticket.firstRespondedAt) ticket.firstRespondedAt = now;

  return repo.save(ticket);
}

export type TicketSlaRunResult = {
  checked: number;
  breached: number;
};

/**
 * Flags tickets that have missed their response or resolution deadline.
 * The flag is written once; later runs skip tickets that already carry it.
 */
export async function runTicketSlaJob(): Promise<TicketSlaRunResult> {
  if (!AppDataSource.isInitialized) return { checked: 0, breached: 0 };

  const repo = AppDataSource.getRepository(Ticket);
  const now = new Date();

  const candidates = await repo
    .createQueryBuilder("t")
    .where("t.slaBreachedAt IS NULL")
    .andWhere("t.status IN (:...activeStatuses)", { activeStatuses: ACTIVE_STATUSES })
    .andWhere(
      "((t.firstRespondedAt IS NULL AND t.firstResponseDueAt IS NOT NULL AND t.firstResponseDueAt < :now)" +
        " OR (t.resolveDueAt IS NOT NULL AND t.resolveDueAt < :now))",
      { now }
    )
    .orderBy("t.resolveDueAt", "ASC")
    .take(500)
    .getMany();

  for (const ticket of candidates) {
    ticket.slaBreachedAt = now;
    await repo.save(ticket);
    console.warn(
      `[ticket-sla] ticket #${ticket.id} "${ticket.subject}" breached its ${ticket.priority} SLA`
    );
    // The assignee (or the desk, if it is unassigned) is paged right away.
    void notifyTicketSlaBreach(ticket);
  }

  return { checked: candidates.length, breached: candidates.length };
}
