// userActionsConsumer.ts
import amqp, { Channel, ConsumeMessage } from "amqplib";
import { AppDataSource } from "../db/config";
import { UserController } from "../controllers/userController";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const QUEUE = "user_actions_queue";
const DLQ = "user_actions_dlq";
const DLX = "user_actions.dlx";
const DLQ_ROUTING_KEY = "user_actions.dlq";
const MAX_RETRIES = Number(process.env.USER_ACTIONS_MAX_RETRIES || 3);

async function setupQueues(channel: Channel) {
  await channel.assertExchange(DLX, "direct", { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, DLQ_ROUTING_KEY);
  try {
    await channel.assertQueue(QUEUE, {
      durable: true,
      deadLetterExchange: DLX,
      deadLetterRoutingKey: DLQ_ROUTING_KEY,
    });
  } catch (err) {
    // Existing queue may lack DLX args (PRECONDITION_FAILED). Keep consuming;
    // publishRetry still writes to DLQ manually after max retries.
    console.warn(
      `user_actions queue assert with DLX failed — falling back to plain durable queue:`,
      err instanceof Error ? err.message : err
    );
    await channel.assertQueue(QUEUE, { durable: true });
  }
}

function retryCount(msg: ConsumeMessage): number {
  const header = msg.properties.headers?.["x-retry"];
  const n = typeof header === "number" ? header : parseInt(String(header ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function publishRetry(channel: Channel, msg: ConsumeMessage, err: unknown) {
  const next = retryCount(msg) + 1;
  const headers = {
    ...(msg.properties.headers || {}),
    "x-retry": next,
    "x-last-error": String(err instanceof Error ? err.message : err).slice(0, 500),
  };

  if (next > MAX_RETRIES) {
    channel.sendToQueue(DLQ, msg.content, {
      persistent: true,
      headers: { ...headers, "x-dead-lettered-at": new Date().toISOString() },
      contentType: msg.properties.contentType,
    });
    console.error(`❌ user_actions moved to DLQ after ${MAX_RETRIES} retries`);
    channel.ack(msg);
    return;
  }

  // Delayed retry via requeue to main queue with incremented header
  channel.sendToQueue(QUEUE, msg.content, {
    persistent: true,
    headers,
    contentType: msg.properties.contentType,
  });
  channel.ack(msg);
}

export async function startConsumer() {
  const rabbitMqUrl = process.env.RABBITMQ_URL || "amqp://127.0.0.1:5672";
  const connection = await amqp.connect(rabbitMqUrl);
  const channel = await connection.createChannel();
  await setupQueues(channel);
  await channel.prefetch(1);
  console.log(`Waiting for messages in ${QUEUE} (DLQ=${DLQ}, maxRetries=${MAX_RETRIES})...`);

  channel.consume(QUEUE, async (msg) => {
    if (msg === null) return;

    let message: any;
    try {
      message = JSON.parse(msg.content.toString());
    } catch (err) {
      console.error("Invalid JSON in user_actions message — sending to DLQ", err);
      channel.sendToQueue(DLQ, msg.content, {
        persistent: true,
        headers: { "x-parse-error": "invalid_json", "x-dead-lettered-at": new Date().toISOString() },
      });
      channel.ack(msg);
      return;
    }

    try {
      if (message.action === "disconnectAndCompleteSession") {
        const { username, ip, code, port } = message;
        const result = await UserController.disconnectUser(
          username,
          ip,
          code,
          typeof port === "number" ? port : undefined
        );
        if (!result.ok) {
          throw new Error(result.error || `disconnect failed for ${username}`);
        }
        await delay(5000);

        const staleSecondsRaw = parseInt(process.env.ONLINE_SESSION_STALE_SECONDS || "300", 10);
        const staleSeconds = Number.isFinite(staleSecondsRaw) && staleSecondsRaw > 0 ? staleSecondsRaw : 300;
        const staleCutoff = new Date(Date.now() - staleSeconds * 1000);

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          const stillOnlineRow = await queryRunner.query(
            `
            SELECT 1 AS ok
            FROM radacct ra
            WHERE ra.username = ?
              AND ra.acctstoptime IS NULL
              AND COALESCE(ra.acctupdatetime, ra.acctstarttime) >= ?
            LIMIT 1;
            `,
            [username, staleCutoff]
          );

          const stillOnline = Array.isArray(stillOnlineRow) && stillOnlineRow.length > 0;
          if (stillOnline) {
            console.warn(
              `⚠️ Skipping session_tracking completion for ${username}: radacct still online (fresh).`
            );
            channel.ack(msg);
            return;
          }

          await queryRunner.query(
            `UPDATE session_tracking 
             SET daily_bytes_in = 0, daily_bytes_out = 0, daily_session_time = 0,
             bytes_in = 0, bytes_out = 0, session_time = 0, last_update = NOW(), end_time = NOW(), status = 'completed'
             WHERE username = ? AND status = 'active' AND end_time IS NULL`,
            [username]
          );
        } finally {
          await queryRunner.release();
        }
      }

      channel.ack(msg);
    } catch (err) {
      console.error("user_actions handler failed:", err);
      try {
        await publishRetry(channel, msg, err);
      } catch (publishErr) {
        console.error("Failed to retry/DLQ message — nacking", publishErr);
        channel.nack(msg, false, false);
      }
    }
  });
}
