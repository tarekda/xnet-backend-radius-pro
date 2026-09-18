import { Router } from "express";
import {
  addTicketCommentHandler,
  assignTicketHandler,
  createTicketHandler,
  getSlaPolicyHandler,
  getTicketHandler,
  listTicketsHandler,
  runTicketSlaHandler,
  setTicketStatusHandler,
  updateTicketHandler,
} from "../controllers/ticketController";
import {
  authenticateToken,
  authorizePermissions,
  authorizeRoles,
} from "../middleware/authMiddleware";

const router = Router();

const STAFF_ROLES = ["admin", "manager", "support"] as const;

// Declared before "/:id" so the literal paths are never read as an id.
router.get(
  "/sla-policy",
  authenticateToken,
  authorizePermissions("support.tickets.view"),
  authorizeRoles(...STAFF_ROLES),
  getSlaPolicyHandler
);

router.post(
  "/sla/run",
  authenticateToken,
  authorizePermissions("support.tickets.manage"),
  authorizeRoles("admin", "manager"),
  runTicketSlaHandler
);

router.get(
  "/",
  authenticateToken,
  authorizePermissions("support.tickets.view"),
  authorizeRoles(...STAFF_ROLES),
  listTicketsHandler
);

router.get(
  "/:id",
  authenticateToken,
  authorizePermissions("support.tickets.view"),
  authorizeRoles(...STAFF_ROLES),
  getTicketHandler
);

router.post(
  "/",
  authenticateToken,
  authorizePermissions("support.tickets.manage"),
  authorizeRoles(...STAFF_ROLES),
  createTicketHandler
);

router.patch(
  "/:id",
  authenticateToken,
  authorizePermissions("support.tickets.manage"),
  authorizeRoles(...STAFF_ROLES),
  updateTicketHandler
);

router.post(
  "/:id/assign",
  authenticateToken,
  authorizePermissions("support.tickets.manage"),
  authorizeRoles(...STAFF_ROLES),
  assignTicketHandler
);

router.post(
  "/:id/status",
  authenticateToken,
  authorizePermissions("support.tickets.manage"),
  authorizeRoles(...STAFF_ROLES),
  setTicketStatusHandler
);

router.post(
  "/:id/comments",
  authenticateToken,
  authorizePermissions("support.tickets.manage"),
  authorizeRoles(...STAFF_ROLES),
  addTicketCommentHandler
);

export default router;
