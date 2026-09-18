import { NextFunction, Request, Response } from "express";
import {
  addTicketComment,
  assignTicket,
  createTicket,
  getTicketById,
  getTicketDetail,
  listTickets,
  runTicketSlaJob,
  setTicketStatus,
  slaPolicySummary,
  updateTicket,
} from "../services/ticketService";
import type { TicketInput } from "../services/ticketService";
import {
  notifyTicketAssigned,
  notifyTicketComment,
  notifyTicketCreated,
} from "../services/pushNotificationService";

function readTicketInput(body: Record<string, unknown>): TicketInput {
  return {
    subject: String(body.subject ?? ""),
    description: body.description === undefined ? null : String(body.description ?? ""),
    priority: body.priority as TicketInput["priority"],
    category: body.category as TicketInput["category"],
    source: body.source as TicketInput["source"],
    requester: body.requester === undefined ? null : String(body.requester ?? ""),
    assignee: body.assignee === undefined ? null : String(body.assignee ?? ""),
  };
}

function parseId(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, message: "Invalid ticket ID", data: null });
    return null;
  }
  return id;
}

export const listTicketsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await listTickets({
      status: req.query.status ? String(req.query.status) : undefined,
      priority: req.query.priority ? String(req.query.priority) : undefined,
      assignee: req.query.assignee ? String(req.query.assignee) : undefined,
      requester: req.query.requester ? String(req.query.requester) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      breachedOnly: String(req.query.breachedOnly ?? "") === "true",
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });

    res.status(200).json({ success: true, message: "Tickets listed", data: result });
  } catch (err) {
    next(err);
  }
};

/** Declared before `/:id` so "sla-policy" is never read as an id. */
export const getSlaPolicyHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    res.status(200).json({
      success: true,
      message: "SLA policy",
      data: slaPolicySummary(),
    });
  } catch (err) {
    next(err);
  }
};

export const getTicketHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const detail = await getTicketDetail(id);
    res.status(200).json({ success: true, message: "Ticket loaded", data: detail });
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_FOUND") {
      res.status(404).json({ success: false, message: "Ticket not found", data: null });
      return;
    }
    next(err);
  }
};

export const createTicketHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const ticket = await createTicket(
      readTicketInput((req.body ?? {}) as Record<string, unknown>),
      req.user?.username
    );
    void notifyTicketCreated(ticket, req.user?.username);
    res.status(201).json({ success: true, message: "Ticket created", data: ticket });
  } catch (err) {
    if (err instanceof Error && !/NOT_FOUND/.test(err.message)) {
      res.status(400).json({ success: false, message: err.message, data: null });
      return;
    }
    next(err);
  }
};

export const updateTicketHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ticket = await updateTicket(
      id,
      {
        subject: body.subject === undefined ? undefined : String(body.subject),
        description:
          body.description === undefined
            ? undefined
            : body.description === null
              ? null
              : String(body.description),
        priority: body.priority as TicketInput["priority"],
        category: body.category as TicketInput["category"],
        source: body.source as TicketInput["source"],
        requester: body.requester === undefined ? undefined : String(body.requester ?? ""),
      },
      req.user?.username
    );

    res.status(200).json({ success: true, message: "Ticket updated", data: ticket });
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_FOUND") {
      res.status(404).json({ success: false, message: "Ticket not found", data: null });
      return;
    }
    if (err instanceof Error) {
      res.status(400).json({ success: false, message: err.message, data: null });
      return;
    }
    next(err);
  }
};

export const assignTicketHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const assignee = raw.assignee === undefined ? null : String(raw.assignee ?? "");
    const ticket = await assignTicket(id, assignee, req.user?.username);
    if (ticket.assignee) void notifyTicketAssigned(ticket, ticket.assignee, req.user?.username);

    res.status(200).json({
      success: true,
      message: assignee ? `Assigned to ${assignee}` : "Ticket unassigned",
      data: ticket,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_FOUND") {
      res.status(404).json({ success: false, message: "Ticket not found", data: null });
      return;
    }
    next(err);
  }
};

export const setTicketStatusHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const status = String((req.body ?? {}).status ?? "").trim();
    if (!status) {
      res.status(400).json({ success: false, message: "status is required", data: null });
      return;
    }

    const ticket = await setTicketStatus(id, status, req.user?.username);
    res.status(200).json({ success: true, message: `Ticket is now ${ticket.status}`, data: ticket });
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_FOUND") {
      res.status(404).json({ success: false, message: "Ticket not found", data: null });
      return;
    }
    next(err);
  }
};

export const addTicketCommentHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const comment = await addTicketComment(id, {
      body: String(body.body ?? ""),
      author: req.user?.username,
      visibility: body.visibility === "internal" ? "internal" : "public",
    });
    if (comment.visibility === "public") {
      void notifyTicketComment(await getTicketById(id), req.user?.username);
    }

    res.status(201).json({ success: true, message: "Comment added", data: comment });
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_FOUND") {
      res.status(404).json({ success: false, message: "Ticket not found", data: null });
      return;
    }
    if (err instanceof Error && /required/.test(err.message)) {
      res.status(400).json({ success: false, message: err.message, data: null });
      return;
    }
    next(err);
  }
};

/** Runs the SLA sweep on demand — useful for verifying a policy change. */
export const runTicketSlaHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await runTicketSlaJob();
    res.status(200).json({
      success: true,
      message: `${result.breached} ticket(s) newly flagged`,
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
