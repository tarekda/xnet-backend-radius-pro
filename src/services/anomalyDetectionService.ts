import { AppDataSource } from "../db/config";
import { Radacct } from "../db/entities/Radacct";
import eventBus from "../bus/eventBusSingleton";

export interface LineFlappingResult {
  username: string;
  isFlapping: boolean;
  disconnectCount: number;
  timeframeMinutes: number;
  lastDisconnectAt?: Date;
}

export interface MacSpoofingResult {
  username: string;
  isSpoofed: boolean;
  activeMacs: string[];
  nasAddresses: string[];
}

export class AnomalyDetectionService {
  /**
   * Detect subscribers with frequent disconnections (flapping line)
   */
  async detectLineFlapping(username: string, thresholdCount: number = 10, windowMinutes: number = 15): Promise<LineFlappingResult> {
    if (!username || !AppDataSource.isInitialized) {
      return { username, isFlapping: false, disconnectCount: 0, timeframeMinutes: windowMinutes };
    }

    try {
      const since = new Date(Date.now() - windowMinutes * 60 * 1000);
      const radacctRepo = AppDataSource.getRepository(Radacct);

      const recentStops = await radacctRepo
        .createQueryBuilder("radacct")
        .where("radacct.username = :username", { username: username.trim() })
        .andWhere("radacct.acctstoptime >= :since", { since })
        .orderBy("radacct.acctstoptime", "DESC")
        .getMany();

      const disconnectCount = recentStops.length;
      const isFlapping = disconnectCount >= thresholdCount;

      if (isFlapping && eventBus && typeof (eventBus as any).publish === "function") {
        await (eventBus as any).publish({
          type: "LINE_FLAPPING",
          severity: "high",
          username: username.trim(),
          message: `Subscriber '${username}' disconnected ${disconnectCount} times in the last ${windowMinutes} minutes.`,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      return {
        username: username.trim(),
        isFlapping,
        disconnectCount,
        timeframeMinutes: windowMinutes,
        lastDisconnectAt: recentStops[0]?.acctstoptime || undefined,
      };
    } catch (err) {
      console.error(`[AnomalyDetection] Error checking line flapping for ${username}:`, err);
      return { username: username.trim(), isFlapping: false, disconnectCount: 0, timeframeMinutes: windowMinutes };
    }
  }

  /**
   * Detect potential MAC spoofing / concurrent logins with different MAC addresses
   */
  async detectMacSpoofing(username: string, currentMac?: string): Promise<MacSpoofingResult> {
    if (!username || !AppDataSource.isInitialized) {
      return { username, isSpoofed: false, activeMacs: [], nasAddresses: [] };
    }

    try {
      const radacctRepo = AppDataSource.getRepository(Radacct);
      // Active sessions have acctstoptime IS NULL
      const activeSessions = await radacctRepo
        .createQueryBuilder("radacct")
        .where("radacct.username = :username", { username: username.trim() })
        .andWhere("radacct.acctstoptime IS NULL")
        .getMany();

      const macs = new Set<string>();
      const nasIps = new Set<string>();

      for (const sess of activeSessions) {
        if (sess.callingstationid) macs.add(sess.callingstationid.trim().toUpperCase());
        if (sess.nasipaddress) nasIps.add(sess.nasipaddress.trim());
      }

      if (currentMac) {
        macs.add(currentMac.trim().toUpperCase());
      }

      const activeMacs = Array.from(macs);
      const nasAddresses = Array.from(nasIps);
      const isSpoofed = activeMacs.length > 1 || nasAddresses.length > 1;

      if (isSpoofed && eventBus && typeof (eventBus as any).publish === "function") {
        await (eventBus as any).publish({
          type: "MAC_SPOOFING",
          severity: "critical",
          username: username.trim(),
          message: `Subscriber '${username}' has concurrent active sessions across ${activeMacs.length} distinct MAC addresses (${activeMacs.join(", ")}).`,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      return {
        username: username.trim(),
        isSpoofed,
        activeMacs,
        nasAddresses,
      };
    } catch (err) {
      console.error(`[AnomalyDetection] Error checking MAC spoofing for ${username}:`, err);
      return { username: username.trim(), isSpoofed: false, activeMacs: [], nasAddresses: [] };
    }
  }
}

export const anomalyDetectionService = new AnomalyDetectionService();
