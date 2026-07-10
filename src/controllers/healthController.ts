import { Request, Response, NextFunction } from "express";
import amqp from "amqplib";
import { AppDataSource } from "../db/config";
import { redisClient } from "../redisClient";
import { isShuttingDown } from "../state/shutdown";

export const healthCheck = (_req: Request, res: Response) => {
  res.status(200).json({ status: "UP" });
};

async function checkRabbitMq(): Promise<{ ok: boolean; reason?: string }> {
  const url = process.env.RABBITMQ_URL || "amqp://127.0.0.1:5672";
  let connection: Awaited<ReturnType<typeof amqp.connect>> | null = null;
  try {
    connection = await amqp.connect(url);
    const channel = await connection.createChannel();
    await channel.close();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "connect_failed" };
  } finally {
    try {
      await connection?.close();
    } catch {
      /* ignore */
    }
  }
}

export const readyCheck = async (_req: Request, res: Response, _next: NextFunction): Promise<void> => {
  if (isShuttingDown()) {
    res.status(503).json({ status: "DOWN", reason: "shutting_down" });
    return;
  }

  const requireRabbit = String(process.env.READY_REQUIRE_RABBITMQ ?? "1").toLowerCase();
  const rabbitRequired = requireRabbit !== "0" && requireRabbit !== "false";

  const checks: Record<string, any> = {
    db: { ok: false },
    redis: { ok: false },
    rabbitmq: { ok: false, required: rabbitRequired },
  };

  checks.db.ok = AppDataSource.isInitialized === true;

  try {
    const isOpen = (redisClient as any).isOpen === true;
    if (isOpen) {
      await redisClient.ping();
      checks.redis.ok = true;
    } else {
      checks.redis.ok = false;
      checks.redis.reason = "not_connected";
    }
  } catch (e: any) {
    checks.redis.ok = false;
    checks.redis.reason = e?.message || "ping_failed";
  }

  checks.rabbitmq = { ...checks.rabbitmq, ...(await checkRabbitMq()) };

  const ok =
    Boolean(checks.db.ok && checks.redis.ok) &&
    (rabbitRequired ? Boolean(checks.rabbitmq.ok) : true);

  res.status(ok ? 200 : 503).json({ status: ok ? "UP" : "DOWN", checks });
};
