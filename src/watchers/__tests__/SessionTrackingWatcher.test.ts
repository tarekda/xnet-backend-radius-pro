import { WebSocket } from "ws";

import { getOnlineUsers } from "../../repo/onlineUsers";
import { SessionTrackingWatcher } from "../SessionTrackingWatcher";

jest.mock("../../repo/onlineUsers", () => ({ getOnlineUsers: jest.fn() }));

const mockedGetOnlineUsers = getOnlineUsers as jest.MockedFunction<typeof getOnlineUsers>;

const openSocket = () => ({ readyState: WebSocket.OPEN, send: jest.fn() });

describe("SessionTrackingWatcher", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockedGetOnlineUsers.mockResolvedValue([{ online: 3 }] as never);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    errorSpy.mockRestore();
  });

  it("polls once per interval and fans the payload out to every open socket", async () => {
    const a = openSocket();
    const b = openSocket();
    const watcher = new SessionTrackingWatcher(() => [a, b], 10_000);

    watcher.start();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedGetOnlineUsers).toHaveBeenCalledTimes(1);
    expect(a.send).toHaveBeenCalledWith(JSON.stringify([{ online: 3 }]));
    expect(b.send).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockedGetOnlineUsers).toHaveBeenCalledTimes(2);
  });

  it("ignores repeat start() calls instead of stacking timers", async () => {
    const watcher = new SessionTrackingWatcher(() => [], 10_000);

    watcher.start();
    watcher.start();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedGetOnlineUsers).toHaveBeenCalledTimes(1);
  });

  it("stops polling after stop()", async () => {
    const watcher = new SessionTrackingWatcher(() => [openSocket()], 10_000);

    watcher.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(watcher.started).toBe(true);

    watcher.stop();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockedGetOnlineUsers).toHaveBeenCalledTimes(1);
    expect(watcher.started).toBe(false);
  });

  it("skips sockets that are not open", async () => {
    const open = openSocket();
    const closed = { readyState: WebSocket.CLOSED, send: jest.fn() };
    const watcher = new SessionTrackingWatcher(() => [open, closed], 10_000);

    watcher.start();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(open.send).toHaveBeenCalledTimes(1);
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("survives a dead socket and a failing query without dropping the timer", async () => {
    const bad = {
      readyState: WebSocket.OPEN,
      send: jest.fn(() => {
        throw new Error("socket is gone");
      }),
    };
    const good = openSocket();
    const watcher = new SessionTrackingWatcher(() => [bad, good], 10_000);

    watcher.start();
    await jest.advanceTimersByTimeAsync(10_000);

    // One bad socket must not stop the others from being served.
    expect(good.send).toHaveBeenCalledTimes(1);

    mockedGetOnlineUsers.mockRejectedValueOnce(new Error("db down"));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(errorSpy).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockedGetOnlineUsers).toHaveBeenCalledTimes(3);
  });
});
