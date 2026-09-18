import amqp from "amqplib";

import { startConsumer } from "../userActionsConsumer";
import { openUserActionsChannel } from "../userActionsTopology";

jest.mock("amqplib", () => ({ __esModule: true, default: { connect: jest.fn() } }));
jest.mock("../userActionsTopology", () => ({
  openUserActionsChannel: jest.fn(),
  USER_ACTIONS_QUEUE: "user_actions_queue",
  USER_ACTIONS_DLQ: "user_actions_dlq",
}));
jest.mock("../../controllers/userController", () => ({
  UserController: { disconnectUser: jest.fn() },
}));
jest.mock("../../db/config", () => ({ AppDataSource: { createQueryRunner: jest.fn() } }));

const mockedConnect = amqp.connect as unknown as jest.Mock;
const mockedOpenChannel = openUserActionsChannel as unknown as jest.Mock;

function makeFakes() {
  const channel = {
    on: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue({ consumerTag: "tag" }),
    close: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
  };
  const connection = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection };
}

describe("startConsumer shutdown handle", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it("resolves once consumption has started and exposes the connection", async () => {
    const { channel, connection } = makeFakes();
    mockedConnect.mockResolvedValue(connection);
    mockedOpenChannel.mockResolvedValue(channel);

    const handle = await startConsumer();

    expect(channel.prefetch).toHaveBeenCalledWith(1);
    expect(channel.consume).toHaveBeenCalled();
    expect(handle.connection).toBe(connection);
    expect(handle.channel).toBe(channel);
  });

  it("closes the channel then the connection", async () => {
    const { channel, connection } = makeFakes();
    mockedConnect.mockResolvedValue(connection);
    mockedOpenChannel.mockResolvedValue(channel);

    const handle = await startConsumer();
    await handle.close();

    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("resolves even when the socket is already gone", async () => {
    const { channel, connection } = makeFakes();
    channel.close.mockRejectedValue(new Error("Channel closed"));
    connection.close.mockRejectedValue(new Error("Connection closed"));
    mockedConnect.mockResolvedValue(connection);
    mockedOpenChannel.mockResolvedValue(channel);

    const handle = await startConsumer();

    await expect(handle.close()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
