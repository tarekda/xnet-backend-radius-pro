jest.mock("../../redisClient", () => ({
  redisClient: {
    isOpen: false,
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}));

import {
  clearStaffLoginFailures,
  getStaffLoginLock,
  recordStaffLoginFailure,
} from "../staffLoginLockout";

describe("staffLoginLockout", () => {
  const prevAttempts = process.env.AUTH_LOCKOUT_MAX_ATTEMPTS;
  const prevLock = process.env.AUTH_LOCKOUT_SECONDS;
  const username = `lockout-test-${Date.now()}`;

  beforeEach(async () => {
    process.env.AUTH_LOCKOUT_MAX_ATTEMPTS = "3";
    process.env.AUTH_LOCKOUT_SECONDS = "900";
    await clearStaffLoginFailures(username);
  });

  afterEach(async () => {
    await clearStaffLoginFailures(username);
    if (prevAttempts === undefined) delete process.env.AUTH_LOCKOUT_MAX_ATTEMPTS;
    else process.env.AUTH_LOCKOUT_MAX_ATTEMPTS = prevAttempts;
    if (prevLock === undefined) delete process.env.AUTH_LOCKOUT_SECONDS;
    else process.env.AUTH_LOCKOUT_SECONDS = prevLock;
  });

  it("is unlocked before any failures", async () => {
    expect(await getStaffLoginLock(username)).toEqual({ locked: false });
  });

  it("locks after the configured number of failures", async () => {
    expect((await recordStaffLoginFailure(username)).locked).toBe(false);
    expect((await recordStaffLoginFailure(username)).locked).toBe(false);
    const third = await recordStaffLoginFailure(username);
    expect(third.locked).toBe(true);
    expect(third.message).toMatch(/Account locked/i);
    expect((await getStaffLoginLock(username)).locked).toBe(true);
  });

  it("clears the lock after a successful login helper call", async () => {
    await recordStaffLoginFailure(username);
    await recordStaffLoginFailure(username);
    await recordStaffLoginFailure(username);
    await clearStaffLoginFailures(username);
    expect((await getStaffLoginLock(username)).locked).toBe(false);
  });
});
