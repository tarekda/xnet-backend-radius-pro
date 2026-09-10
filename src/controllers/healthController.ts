import { Request, Response, NextFunction } from "express";
import amqp from "amqplib";
import { AppDataSource } from "../db/config";
import { redisClient } from "../redisClient";
import { isShuttingDown } from "../state/shutdown";
import { radiusAccountingQueueService } from "../services/radiusAccountingQueueService";
import { getVersionInfo } from "../utils/version";

export const healthCheck = (_req: Request, res: Response) => {
  res.status(200).json({
    status: "UP",
    ...getVersionInfo(),
    uptime: Math.floor(process.uptime()),
  });
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
    radiusQueue: { ok: true, queue: 0, dlq: 0 },
  };

  checks.db.ok = AppDataSource.isInitialized === true;

  try {
    const isOpen = (redisClient as any).isOpen === true;
    if (isOpen) {
      await redisClient.ping();
      checks.redis.ok = true;

      // Fetch queue depths (informational — never makes the endpoint return 503)
      const depths = await radiusAccountingQueueService.getQueueDepths();
      checks.radiusQueue = {
        ok: depths.dlq === 0,
        queue: depths.queue,
        dlq: depths.dlq,
        ...(depths.dlq > 0 ? { warning: `${depths.dlq} item(s) in dead-letter queue` } : {}),
      };
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

  res.status(ok ? 200 : 503).json({
    status: ok ? "UP" : "DOWN",
    ...getVersionInfo(),
    uptime: Math.floor(process.uptime()),
    checks,
  });
};

export const circuitBreakersCheck = (_req: Request, res: Response): void => {
  const { CircuitBreakerRegistry } = require("../utils/circuitBreaker");
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    circuitBreakers: CircuitBreakerRegistry.getAllMetrics(),
  });
};
