/**
 * Expo push delivery for the staff mobile app.
 *
 * Tokens are registered by the app at sign-in. Delivery is best-effort: a
 * failing push must never fail the ticket write that triggered it, so every
 * entry point swallows its errors and only logs them.
 */
import axios from "axios";
import { In } from "typeorm";

import { AppDataSource } from "../db/config";
import { DeviceToken } from "../db/entities/DeviceToken";
import { SystemUsers } from "../db/entities/SystemUsers";
import type { Ticket } from "../db/entities/Ticket";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK_SIZE = 100;
const STAFF_ROLES: Array<"admin" | "manager" | "support"> = ["admin", "manager", "support"];

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound: "default";
  priority: "high";
  channelId: string;
  data?: Record<string, unknown>;
};

export type PushResult = {
  tokens: number;
  sent: number;
  failed: number;
  pruned: number;
};

const EMPTY_RESULT: PushResult = { tokens: 0, sent: 0, failed: 0, pruned: 0 };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One Expo message per token, all carrying the same notification. */
export function buildExpoMessages(tokens: string[], payload: PushPayload): ExpoPushMessage[] {
  return tokens.map((token) => ({
    to: token,
    title: payload.title,
    body: payload.body,
    sound: "default",
    priority: "high",
    channelId: "tickets",
    ...(payload.data ? { data: payload.data } : {}),
  }));
}

export async function registerDeviceToken(input: {
  username: string;
  token: string;
  platform?: string | null;
  deviceName?: string | null;
}): Promise<DeviceToken> {
  const username = String(input.username ?? "").trim();
  const token = String(input.token ?? "").trim();
  if (!username) throw new Error("username is required");
  if (!token) throw new Error("token is required");

  const repo = AppDataSource.getRepository(DeviceToken);
  const existing = await repo.findOne({ where: { token } });

  const row = existing ?? repo.create({ token, username, createdAt: undefined } as Partial<DeviceToken>);
  // The device follows whoever signed in last, so a handover re-points the row.
  row.username = username;
  row.platform = String(input.platform ?? "android").trim() || "android";
  row.deviceName = input.deviceName ? String(input.deviceName).trim().slice(0, 128) : null;
  row.isActive = 1;
  row.lastSeenAt = new Date();

  return repo.save(row);
}

/** Removes the given token, or every token of the user when none is given. */
export async function unregisterDeviceToken(input: {
  username: string;
  token?: string | null;
}): Promise<number> {
  const repo = AppDataSource.getRepository(DeviceToken);
  const username = String(input.username ?? "").trim();
  if (!username) return 0;

  const token = String(input.token ?? "").trim();
  const where = token ? { username, token } : { username };
  const result = await repo.delete(where);
  return result.affected ?? 0;
}

async function activeStaffUsernames(): Promise<string[]> {
  const users = await AppDataSource.getRepository(SystemUsers).find({
    where: { role: In(STAFF_ROLES) },
    select: ["username", "role", "isActive"],
  });
  return users
    .filter((u) => String(u.isActive ?? 1) !== "0" && u.isActive !== false)
    .map((u) => u.username);
}

/**
 * Who should hear about this ticket: the assignee when there is one, otherwise
 * the whole support desk.
 */
export async function resolveTicketRecipients(
  ticket: Pick<Ticket, "assignee">
): Promise<string[]> {
  if (ticket.assignee) return [ticket.assignee];
  return activeStaffUsernames();
}

/** Sends one notification to every device belonging to the given users. */
export async function sendPushToUsernames(
  usernames: string[],
  payload: PushPayload
): Promise<PushResult> {
  const recipients = Array.from(new Set(usernames.map((u) => String(u ?? "").trim()).filter(Boolean)));
  if (recipients.length === 0 || !AppDataSource.isInitialized) return { ...EMPTY_RESULT };

  const rows = await AppDataSource.getRepository(DeviceToken).find({
    where: { username: In(recipients) },
  });
  const tokens = rows.map((r) => r.token);
  if (tokens.length === 0) return { ...EMPTY_RESULT };

  const result: PushResult = { tokens: tokens.length, sent: 0, failed: 0, pruned: 0 };
  const accessToken = String(process.env.EXPO_ACCESS_TOKEN ?? "").trim();

  for (const batch of chunk(buildExpoMessages(tokens, payload), CHUNK_SIZE)) {
    try {
      const response = await axios.post(EXPO_PUSH_URL, batch, {
        timeout: 15_000,
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });

      const receipts: unknown = response.data?.data;
      if (!Array.isArray(receipts)) {
        result.sent += batch.length;
        continue;
      }

      const dead: string[] = [];
      receipts.forEach((receipt: { status?: string; details?: { error?: string } }, index: number) => {
        if (receipt?.status === "error") {
          result.failed += 1;
          if (receipt.details?.error === "DeviceNotRegistered") dead.push(batch[index].to);
        } else {
          result.sent += 1;
        }
      });

      if (dead.length > 0) {
        await AppDataSource.getRepository(DeviceToken).delete({ token: In(dead) });
        result.pruned += dead.length;
      }
    } catch (err) {
      result.failed += batch.length;
      console.error("[push] delivery failed:", err instanceof Error ? err.message : err);
    }
  }

  return result;
}

function ticketData(ticket: Pick<Ticket, "id">): Record<string, unknown> {
  return { type: "ticket", ticketId: String(ticket.id ?? "") };
}

export async function notifyTicketCreated(ticket: Ticket, actor?: string): Promise<void> {
  try {
    const recipients = (await resolveTicketRecipients(ticket)).filter((u) => u !== actor);
    await sendPushToUsernames(recipients, {
      title: `New ${ticket.priority} ticket #${ticket.id}`,
      body: ticket.subject,
      data: ticketData(ticket),
    });
  } catch (err) {
    console.error("[push] ticket-created notification failed:", err instanceof Error ? err.message : err);
  }
}

export async function notifyTicketAssigned(ticket: Ticket, assignee: string, actor?: string): Promise<void> {
  try {
    if (!assignee || assignee === actor) return;
    await sendPushToUsernames([assignee], {
      title: `Ticket #${ticket.id} assigned to you`,
      body: ticket.subject,
      data: ticketData(ticket),
    });
  } catch (err) {
    console.error("[push] ticket-assigned notification failed:", err instanceof Error ? err.message : err);
  }
}

export async function notifyTicketComment(ticket: Ticket, author?: string): Promise<void> {
  try {
    const recipients = (await resolveTicketRecipients(ticket)).filter((u) => u !== author);
    await sendPushToUsernames(recipients, {
      title: `New reply on ticket #${ticket.id}`,
      body: ticket.subject,
      data: ticketData(ticket),
    });
  } catch (err) {
    console.error("[push] ticket-comment notification failed:", err instanceof Error ? err.message : err);
  }
}

/** Pages the desk about a ticket that just missed its SLA target. */
export async function notifyTicketSlaBreach(ticket: Ticket): Promise<void> {
  try {
    await sendPushToUsernames(await resolveTicketRecipients(ticket), {
      title: `SLA breached — ticket #${ticket.id}`,
      body: `${ticket.priority} · ${ticket.subject}`,
      data: ticketData(ticket),
    });
  } catch (err) {
    console.error("[push] sla notification failed:", err instanceof Error ? err.message : err);
  }
}
