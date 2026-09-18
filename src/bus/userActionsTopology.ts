/**
 * The single definition of the `user_actions` messaging topology.
 *
 * Both the publisher (EventBus) and the consumer assert this queue, so the
 * arguments must come from one place: RabbitMQ rejects a declare that conflicts
 * with an existing queue (406) and closes the whole channel when it does.
 */
import type { Channel, ChannelModel } from "amqplib";

export const USER_ACTIONS_QUEUE = "user_actions_queue";
export const USER_ACTIONS_DLQ = "user_actions_dlq";
export const USER_ACTIONS_DLX = "user_actions.dlx";
export const USER_ACTIONS_DLQ_ROUTING_KEY = "user_actions.dlq";

/** Declares the dead-letter exchange, its queue, and the bound work queue. */
export async function assertUserActionsTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(USER_ACTIONS_DLX, "direct", { durable: true });
  await channel.assertQueue(USER_ACTIONS_DLQ, { durable: true });
  await channel.bindQueue(USER_ACTIONS_DLQ, USER_ACTIONS_DLX, USER_ACTIONS_DLQ_ROUTING_KEY);
  await channel.assertQueue(USER_ACTIONS_QUEUE, {
    durable: true,
    deadLetterExchange: USER_ACTIONS_DLX,
    deadLetterRoutingKey: USER_ACTIONS_DLQ_ROUTING_KEY,
  });
}

/**
 * Opens a channel with the topology asserted.
 *
 * A queue that predates the dead-letter wiring cannot be re-declared with it —
 * RabbitMQ answers 406 and closes the channel — so that case falls back to the
 * plain durable queue, which still works because failed messages are published
 * to the dead-letter queue by hand.
 */
export async function openUserActionsChannel(connection: ChannelModel): Promise<Channel> {
  const open = async (): Promise<Channel> => {
    const channel = await connection.createChannel();
    channel.on("error", (err: unknown) => {
      console.error("user_actions channel error:", err);
    });
    return channel;
  };

  const channel = await open();
  try {
    await assertUserActionsTopology(channel);
    return channel;
  } catch (err) {
    console.warn(
      "user_actions queue exists with different arguments — falling back to a plain durable queue. " +
        "Delete the 'user_actions_queue' to enable automatic dead-lettering:",
      err instanceof Error ? err.message : err
    );
    try {
      await channel.close();
    } catch {}
    const fallback = await open();
    await fallback.assertQueue(USER_ACTIONS_QUEUE, { durable: true });
    return fallback;
  }
}
