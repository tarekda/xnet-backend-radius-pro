import { WebSocket } from 'ws';

import { getOnlineUsers } from '../repo/onlineUsers';

/** The slice of a socket this broadcaster needs. */
type BroadcastTarget = {
  readyState: number;
  send: (data: string) => void;
};

/**
 * Broadcasts live session metrics to every connected websocket client.
 *
 * A single shared timer polls once and fans the result out. The previous
 * per-connection timer was never cleared on close, so every dashboard tab that
 * was ever opened kept querying the database every 10s and writing to a dead
 * socket.
 */
export class SessionTrackingWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getClients: () => Iterable<BroadcastTarget>,
    private readonly intervalMs: number = 10000
  ) {}

  get started(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.broadcast();
    }, this.intervalMs);
    // Metrics alone must never keep the process alive.
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async broadcast(): Promise<void> {
    try {
      const payload = JSON.stringify(await getOnlineUsers());
      for (const client of this.getClients()) {
        // Skip sockets that are closing or already closed.
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
          client.send(payload);
        } catch {
          // A socket can fail mid-write; its close handler removes it.
        }
      }
    } catch (err) {
      console.error('[ws] session metrics broadcast failed:', err);
    }
  }
}
