import { redisClient } from "../redisClient";

const memory = new Map<string, { fails: number; lockedUntil: number }>();

function maxAttempts(): number {
  const n = Number(process.env.AUTH_LOCKOUT_MAX_ATTEMPTS || 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function windowSeconds(): number {
  const n = Number(process.env.AUTH_LOCKOUT_WINDOW_SECONDS || 900);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

function lockSeconds(): number {
  const n = Number(process.env.AUTH_LOCKOUT_SECONDS || 900);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

function key(username: string): string {
  return `auth:lockout:${username.trim().toLowerCase()}`;
}

function remainingMinutes(lockedUntilMs: number): number {
  return Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 60000));
}

async function readState(username: string): Promise<{ fails: number; lockedUntil: number }> {
  const k = key(username);
  try {
    if (redisClient.isOpen) {
      const raw = await redisClient.get(k);
      if (raw) {
        const parsed = JSON.parse(raw) as { fails?: number; lockedUntil?: number };
        return { fails: Number(parsed.fails || 0), lockedUntil: Number(parsed.lockedUntil || 0) };
      }
    }
  } catch {
    /* fall through to memory */
  }
  return memory.get(k) ?? { fails: 0, lockedUntil: 0 };
}

async function writeState(username: string, state: { fails: number; lockedUntil: number }, ttlSeconds: number): Promise<void> {
  const k = key(username);
  memory.set(k, state);
  try {
    if (redisClient.isOpen) {
      await redisClient.set(k, JSON.stringify(state), { EX: Math.max(60, ttlSeconds) });
    }
  } catch {
    /* memory is enough on a single node */
  }
}

export async function getStaffLoginLock(username: string): Promise<{ locked: boolean; message?: string }> {
  const state = await readState(username);
  if (state.lockedUntil > Date.now()) {
    return {
      locked: true,
      message: `Account locked. Try again in ${remainingMinutes(state.lockedUntil)} minute(s).`,
    };
  }
  return { locked: false };
}

export async function recordStaffLoginFailure(username: string): Promise<{ locked: boolean; message?: string }> {
  const state = await readState(username);
  const fails = state.fails + 1;
  const shouldLock = fails >= maxAttempts();
  const lockedUntil = shouldLock ? Date.now() + lockSeconds() * 1000 : 0;
  await writeState(username, { fails, lockedUntil }, shouldLock ? lockSeconds() : windowSeconds());
  if (shouldLock) {
    return {
      locked: true,
      message: `Account locked. Try again in ${remainingMinutes(lockedUntil)} minute(s).`,
    };
  }
  return { locked: false };
}

export async function clearStaffLoginFailures(username: string): Promise<void> {
  const k = key(username);
  memory.delete(k);
  try {
    if (redisClient.isOpen) await redisClient.del(k);
  } catch {
    /* ignore */
  }
}
