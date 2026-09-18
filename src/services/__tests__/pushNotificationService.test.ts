import axios from "axios";
import { AppDataSource } from "../../db/config";
import { DeviceToken } from "../../db/entities/DeviceToken";
import {
  buildExpoMessages,
  notifyTicketSlaBreach,
  registerDeviceToken,
  resolveTicketRecipients,
  sendPushToUsernames,
  unregisterDeviceToken,
} from "../pushNotificationService";

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock("../../db/config", () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const deviceRepo = {
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn((row: unknown) => row),
  save: jest.fn((row: unknown) => Promise.resolve(row)),
  delete: jest.fn(),
};

const userRepo = { find: jest.fn() };

describe("pushNotificationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) =>
      entity === DeviceToken ? deviceRepo : userRepo
    );
  });

  describe("buildExpoMessages", () => {
    it("builds one high-priority message per token", () => {
      const messages = buildExpoMessages(["ExponentPushToken[a]", "ExponentPushToken[b]"], {
        title: "SLA breached — ticket #12",
        body: "urgent · ONT down",
        data: { type: "ticket", ticketId: "12" },
      });

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        to: "ExponentPushToken[a]",
        title: "SLA breached — ticket #12",
        body: "urgent · ONT down",
        sound: "default",
        priority: "high",
        data: { type: "ticket", ticketId: "12" },
      });
    });
  });

  describe("registerDeviceToken", () => {
    it("creates a row for a device that has never been seen", async () => {
      deviceRepo.findOne.mockResolvedValue(null);

      await registerDeviceToken({ username: "tarek", token: "ExponentPushToken[new]", platform: "ios" });

      // The saved row is mutated after create(), so match on the identity only.
      expect(deviceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ token: "ExponentPushToken[new]", username: "tarek" })
      );
      expect(deviceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ username: "tarek", platform: "ios", isActive: 1 })
      );
    });

    it("re-points a known token at whoever signed in last", async () => {
      const existing = {
        id: 7,
        token: "ExponentPushToken[old]",
        username: "previous",
        platform: "android",
      };
      deviceRepo.findOne.mockResolvedValue(existing);

      await registerDeviceToken({ username: "madonna", token: "ExponentPushToken[old]" });

      expect(deviceRepo.create).not.toHaveBeenCalled();
      expect(existing).toMatchObject({ username: "madonna", isActive: 1 });
      expect(existing).toHaveProperty("lastSeenAt");
    });

    it("refuses an empty token", async () => {
      await expect(registerDeviceToken({ username: "tarek", token: "  " })).rejects.toThrow(
        "token is required"
      );
    });
  });

  describe("unregisterDeviceToken", () => {
    it("reports how many rows were removed", async () => {
      deviceRepo.delete.mockResolvedValue({ affected: 2 });

      await expect(unregisterDeviceToken({ username: "tarek" })).resolves.toBe(2);
      expect(deviceRepo.delete).toHaveBeenCalledWith({ username: "tarek" });
    });

    it("scopes the delete to one token when one is given", async () => {
      deviceRepo.delete.mockResolvedValue({ affected: 1 });

      await unregisterDeviceToken({ username: "tarek", token: "ExponentPushToken[x]" });

      expect(deviceRepo.delete).toHaveBeenCalledWith({
        username: "tarek",
        token: "ExponentPushToken[x]",
      });
    });
  });

  describe("resolveTicketRecipients", () => {
    it("prefers the assignee over the whole desk", async () => {
      await expect(resolveTicketRecipients({ assignee: "madonna" })).resolves.toEqual(["madonna"]);
      expect(userRepo.find).not.toHaveBeenCalled();
    });

    it("falls back to the active staff when the ticket is unassigned", async () => {
      userRepo.find.mockResolvedValue([
        { username: "tarek", isActive: 1 },
        { username: "madonna", isActive: true },
        { username: "ghost", isActive: 0 },
        { username: "left", isActive: false },
      ]);

      await expect(resolveTicketRecipients({ assignee: null })).resolves.toEqual(["tarek", "madonna"]);
    });
  });

  describe("sendPushToUsernames", () => {
    it("does nothing when the users have no registered device", async () => {
      deviceRepo.find.mockResolvedValue([]);

      await expect(sendPushToUsernames(["tarek"], { title: "t", body: "b" })).resolves.toEqual({
        tokens: 0,
        sent: 0,
        failed: 0,
        pruned: 0,
      });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("counts receipts and deletes tokens Expo reports as unregistered", async () => {
      deviceRepo.find.mockResolvedValue([
        { token: "ExponentPushToken[live]" },
        { token: "ExponentPushToken[dead]" },
      ]);
      deviceRepo.delete.mockResolvedValue({ affected: 1 });
      mockedAxios.post.mockResolvedValue({
        data: {
          data: [
            { status: "ok", id: "receipt-1" },
            { status: "error", details: { error: "DeviceNotRegistered" } },
          ],
        },
      });

      const result = await sendPushToUsernames(["tarek"], { title: "t", body: "b" });

      expect(result).toMatchObject({ tokens: 2, sent: 1, failed: 1, pruned: 1 });
      expect(deviceRepo.delete).toHaveBeenCalledTimes(1);
    });

    it("swallows a transport failure instead of failing the caller", async () => {
      deviceRepo.find.mockResolvedValue([{ token: "ExponentPushToken[live]" }]);
      mockedAxios.post.mockRejectedValue(new Error("socket hang up"));
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      await expect(sendPushToUsernames(["tarek"], { title: "t", body: "b" })).resolves.toMatchObject({
        failed: 1,
      });

      errorSpy.mockRestore();
    });
  });

  describe("notifyTicketSlaBreach", () => {
    it("never throws, even when the device lookup fails", async () => {
      deviceRepo.find.mockRejectedValue(new Error("db down"));
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        notifyTicketSlaBreach({
          id: 3,
          subject: "ONT down",
          priority: "urgent",
          assignee: "tarek",
        } as never)
      ).resolves.toBeUndefined();

      errorSpy.mockRestore();
    });

    it("pages the assignee with a deep link back to the ticket", async () => {
      deviceRepo.find.mockResolvedValue([{ token: "ExponentPushToken[live]" }]);
      mockedAxios.post.mockResolvedValue({ data: { data: [{ status: "ok" }] } });

      await notifyTicketSlaBreach({
        id: 3,
        subject: "ONT down",
        priority: "urgent",
        assignee: "tarek",
      } as never);

      const body = mockedAxios.post.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(body[0]).toMatchObject({
        to: "ExponentPushToken[live]",
        data: { type: "ticket", ticketId: "3" },
      });
    });
  });
});
