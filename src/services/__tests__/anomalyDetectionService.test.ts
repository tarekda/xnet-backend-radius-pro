import { anomalyDetectionService } from "../anomalyDetectionService";

let mockRadacctStops: any[] = [];
let mockActiveSessions: any[] = [];

jest.mock("../../db/config", () => ({
  AppDataSource: {
    isInitialized: true,
    getRepository: jest.fn(() => ({
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => mockActiveSessions.length > 0 ? mockActiveSessions : mockRadacctStops),
      })),
    })),
  },
}));

jest.mock("../../bus/eventBusSingleton", () => ({
  publish: jest.fn(async () => {}),
}));

describe("AnomalyDetectionService", () => {
  beforeEach(() => {
    mockRadacctStops = [];
    mockActiveSessions = [];
    jest.clearAllMocks();
  });

  it("should detect subscriber line flapping when disconnections exceed threshold", async () => {
    mockRadacctStops = Array.from({ length: 12 }, (_, i) => ({
      acctsessionid: `sess-${i}`,
      username: "flapping_user",
      acctstoptime: new Date(),
    }));

    const result = await anomalyDetectionService.detectLineFlapping("flapping_user", 10, 15);

    expect(result.isFlapping).toBe(true);
    expect(result.disconnectCount).toBe(12);
  });

  it("should detect MAC spoofing when multiple active sessions have different MACs", async () => {
    mockActiveSessions = [
      { callingstationid: "AA:BB:CC:11:22:33", nasipaddress: "10.0.0.1" },
      { callingstationid: "DD:EE:FF:44:55:66", nasipaddress: "10.0.0.2" },
    ];

    const result = await anomalyDetectionService.detectMacSpoofing("shared_user");

    expect(result.isSpoofed).toBe(true);
    expect(result.activeMacs.length).toBe(2);
  });
});
