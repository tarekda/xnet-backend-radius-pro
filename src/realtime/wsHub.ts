type BroadcastFn = (message: unknown) => void;

let broadcastFn: BroadcastFn | null = null;

export function setWsBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

export function broadcastToClients(message: unknown): void {
  try {
    broadcastFn?.(message);
  } catch (err) {
    console.warn("[wsHub] broadcast failed", err);
  }
}
