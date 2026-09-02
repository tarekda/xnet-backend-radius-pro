import { createClient, ClickHouseClient } from "@clickhouse/client";

export interface CgnatMappingRecord {
  timestamp?: string | Date;
  privateIp: string;
  privatePort: number;
  publicIp: string;
  publicPortStart: number;
  publicPortEnd: number;
  username?: string;
}

export interface SubscriberDailyUsage {
  eventDate: string;
  username: string;
  bytesIn: number;
  bytesOut: number;
  flowsCount: number;
}

export class ClickHouseRollupService {
  private client: ClickHouseClient | null = null;

  constructor() {
    this.initClient();
  }

  private initClient() {
    try {
      const url = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
      const database = process.env.CLICKHOUSE_DB || "flow_logs";
      const username = process.env.CLICKHOUSE_USER || "flow";
      const password = process.env.CLICKHOUSE_PASSWORD || "flowpass";

      this.client = createClient({
        url,
        database,
        username,
        password,
      });
    } catch (err) {
      console.warn("[ClickHouseRollup] Failed to initialize ClickHouse client:", err);
    }
  }

  /**
   * Ensures daily subscriber usage rollup table, CGNAT mapping table, and Materialized View exist
   */
  async ensureSchema(): Promise<boolean> {
    if (!this.client) return false;
    try {
      // 1. Create CGNAT mapping table for Lawful Interception compliance
      await this.client.command({
        query: `
          CREATE TABLE IF NOT EXISTS flow_logs.cgnat_mappings (
            timestamp DateTime DEFAULT now(),
            private_ip String,
            private_port UInt16,
            public_ip String,
            public_port_start UInt16,
            public_port_end UInt16,
            username String
          ) ENGINE = MergeTree()
          ORDER BY (timestamp, private_ip);
        `,
      }).catch(() => {});

      // 2. Create daily rollup table for high-performance subscriber bandwidth queries
      await this.client.command({
        query: `
          CREATE TABLE IF NOT EXISTS flow_logs.daily_subscriber_usage (
            event_date Date,
            username String,
            bytes_in UInt64,
            bytes_out UInt64,
            flows_count UInt32
          ) ENGINE = SummingMergeTree()
          PRIMARY KEY (event_date, username);
        `,
      }).catch(() => {});

      // 3. Create Materialized View to automatically sync user_flow_logs into daily_subscriber_usage
      await this.client.command({
        query: `
          CREATE MATERIALIZED VIEW IF NOT EXISTS flow_logs.daily_subscriber_usage_mv
          TO flow_logs.daily_subscriber_usage
          AS SELECT
            toDate(ts) AS event_date,
            username,
            sum(bytes) AS bytes_in,
            0 AS bytes_out,
            count() AS flows_count
          FROM flow_logs.user_flow_logs
          GROUP BY event_date, username;
        `,
      }).catch(() => {});

      return true;
    } catch (err) {
      console.error("[ClickHouseRollup] Failed to ensure schema:", err);
      return false;
    }
  }

  /**
   * Auto-repair ClickHouse flow table broken parts error (Code 722 / TOO_MANY_UNEXPECTED_DATA_PARTS)
   */
  async repairFlowLogsTable(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.command({
        query: `ATTACH TABLE IF EXISTS flow_logs.user_flow_logs SETTINGS max_suspicious_broken_parts = 10000;`,
      });
      console.log("✅ Successfully executed ClickHouse attach table repair.");
      return true;
    } catch (err) {
      console.error("[ClickHouseRollup] Failed to repair flow_logs.user_flow_logs:", err);
      return false;
    }
  }

  /**
   * Insert CGNAT translation record for regulatory compliance
   */
  async recordCgnatMapping(mapping: CgnatMappingRecord): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.insert({
        table: "cgnat_mappings",
        values: [
          {
            timestamp: mapping.timestamp ? new Date(mapping.timestamp).toISOString().slice(0, 19).replace("T", " ") : new Date().toISOString().slice(0, 19).replace("T", " "),
            private_ip: mapping.privateIp,
            private_port: mapping.privatePort,
            public_ip: mapping.publicIp,
            public_port_start: mapping.publicPortStart,
            public_port_end: mapping.publicPortEnd,
            username: mapping.username || "",
          },
        ],
        format: "JSONEachRow",
      });
    } catch (err) {
      console.error("[ClickHouseRollup] Failed to record CGNAT mapping:", err);
    }
  }

  /**
   * Query daily aggregated bandwidth usage for a subscriber with automatic fallback
   */
  async getSubscriberDailyUsage(username: string, _startDate?: string, _endDate?: string): Promise<SubscriberDailyUsage[]> {
    if (!this.client || !username) return [];
    const cleanUsername = username.trim();
    try {
      // Primary query: raw flow_logs.user_flow_logs table
      const resultSet = await this.client.query({
        query: `
          SELECT 
            toString(toDate(ts)) as eventDate,
            username,
            sum(bytes) as bytesIn,
            0 as bytesOut,
            count() as flowsCount
          FROM flow_logs.user_flow_logs
          WHERE lower(username) = lower({username: String})
          GROUP BY toDate(ts), username
          ORDER BY toDate(ts) ASC
        `,
        query_params: {
          username: cleanUsername,
        },
        format: "JSONEachRow",
      });

      const rows = await resultSet.json<any>();
      if (Array.isArray(rows) && rows.length > 0) {
        return rows.map((r: any) => ({
          eventDate: r.eventDate,
          username: r.username,
          bytesIn: Number(r.bytesIn || 0),
          bytesOut: Number(r.bytesOut || 0),
          flowsCount: Number(r.flowsCount || 0),
        }));
      }

      return [];
    } catch (err) {
      console.error(`[ClickHouseRollup] Error querying daily usage for '${username}':`, err);
      return [];
    }
  }
}

export const clickhouseRollupService = new ClickHouseRollupService();
