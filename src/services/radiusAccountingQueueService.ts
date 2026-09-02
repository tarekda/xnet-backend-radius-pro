import { redisClient } from "../redisClient";
import { AppDataSource } from "../db/config";
import { Radacct } from "../db/entities/Radacct";

export interface AccountingUpdatePayload {
  radacctid?: number;
  acctsessionid: string;
  acctuniqueid: string;
  username: string;
  nasipaddress: string;
  acctsessiontime?: number;
  acctinputoctets?: number;
  acctoutputoctets?: number;
  framedipaddress?: string;
  acctstatustype: "Start" | "Interim-Update" | "Stop";
  timestamp: string;
}

const REDIS_QUEUE_KEY = "radius:accounting:queue";

export class RadiusAccountingQueueService {
  private isProcessing: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private flushIntervalMs: number = 5000; // 5 seconds interval
  private batchSizeThreshold: number = 50;

  constructor() {
    this.startAutoFlush();
  }

  /**
   * Enqueue an accounting packet update
   */
  async enqueue(payload: AccountingUpdatePayload): Promise<void> {
    try {
      if (redisClient && redisClient.isOpen) {
        await redisClient.rPush(REDIS_QUEUE_KEY, JSON.stringify(payload));
        const queueLen = await redisClient.lLen(REDIS_QUEUE_KEY);
        if (queueLen >= this.batchSizeThreshold) {
          this.flushQueue();
        }
      } else {
        // Fallback: direct write to DB if Redis is unavailable
        await this.processBatch([payload]);
      }
    } catch (err) {
      console.error("[RadiusAccountingQueue] Error pushing payload to queue:", err);
      await this.processBatch([payload]).catch(() => {});
    }
  }

  /**
   * Periodically flush queued accounting updates
   */
  startAutoFlush() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.flushQueue();
    }, this.flushIntervalMs);
  }

  stopAutoFlush() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Flushes up to 100 items from Redis queue and batch upserts into radacct table
   */
  async flushQueue(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    let processedCount = 0;
    try {
      if (!redisClient || !redisClient.isOpen) {
        this.isProcessing = false;
        return 0;
      }

      const rawItems: string[] = [];
      for (let i = 0; i < 100; i++) {
        const item = await redisClient.lPop(REDIS_QUEUE_KEY);
        if (!item) break;
        rawItems.push(item);
      }

      if (rawItems.length === 0) {
        this.isProcessing = false;
        return 0;
      }

      const payloads: AccountingUpdatePayload[] = [];
      for (const raw of rawItems) {
        try {
          payloads.push(JSON.parse(raw));
        } catch {
          // ignore corrupted payload
        }
      }

      if (payloads.length > 0) {
        await this.processBatch(payloads);
        processedCount = payloads.length;
      }
    } catch (err) {
      console.error("[RadiusAccountingQueue] Error during queue flush:", err);
    } finally {
      this.isProcessing = false;
    }

    return processedCount;
  }

  /**
   * Process a batch of accounting updates into database
   */
  private async processBatch(batch: AccountingUpdatePayload[]): Promise<void> {
    if (!AppDataSource.isInitialized) return;
    const radacctRepo = AppDataSource.getRepository(Radacct);

    for (const item of batch) {
      try {
        let existing = await radacctRepo.findOne({
          where: {
            acctsessionid: item.acctsessionid,
            username: item.username,
          },
        });

        if (existing) {
          if (item.acctsessiontime !== undefined) existing.acctsessiontime = item.acctsessiontime;
          if (item.acctinputoctets !== undefined) existing.acctinputoctets = String(item.acctinputoctets);
          if (item.acctoutputoctets !== undefined) existing.acctoutputoctets = String(item.acctoutputoctets);
          if (item.framedipaddress) existing.framedipaddress = item.framedipaddress;
          if (item.acctstatustype === "Stop") {
            existing.acctstoptime = new Date(item.timestamp);
          }
          await radacctRepo.save(existing);
        } else if (item.acctstatustype === "Start" || item.acctstatustype === "Interim-Update") {
          const newSession = new Radacct();
          newSession.acctsessionid = item.acctsessionid;
          newSession.acctuniqueid = item.acctuniqueid || `${item.acctsessionid}-${Date.now()}`;
          newSession.username = item.username;
          newSession.nasipaddress = item.nasipaddress;
          newSession.framedipaddress = item.framedipaddress || "";
          newSession.acctstarttime = new Date(item.timestamp);
          newSession.acctsessiontime = item.acctsessiontime || 0;
          newSession.acctinputoctets = String(item.acctinputoctets || 0);
          newSession.acctoutputoctets = String(item.acctoutputoctets || 0);
          
          await radacctRepo.save(newSession);
        }
      } catch (err) {
        console.error(`[RadiusAccountingQueue] Failed to update radacct record for ${item.username}:`, err);
      }
    }
  }
}

export const radiusAccountingQueueService = new RadiusAccountingQueueService();
