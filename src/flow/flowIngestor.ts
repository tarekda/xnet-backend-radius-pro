import "dotenv/config";

import { createClient } from "@clickhouse/client";
import Collector from "@gavinaiken/netflowv9";
import dgram from "node:dgram";
import { initializeDB, AppDataSource } from "../db/config";
import { SessionTracking } from "../db/entities/SessionTracking";

type CacheEntry = { username: string; expiresAt: number; sessionId?: string };

function envInt(name: string, def: number) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) ? n : def;
}

function first<T = any>(obj: any, keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

function asUInt(n: any, def = 0) {
  const v = typeof n === "number" ? n : parseInt(String(n ?? ""), 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

async function main() {
  const listenPort = envInt("FLOW_LISTEN_PORT", 2055);

  // ClickHouse connection
  const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
  const clickhouseDb = process.env.CLICKHOUSE_DB || "flow_logs";
  const clickhouseUser = process.env.CLICKHOUSE_USER || "flow";
  const clickhousePassword = process.env.CLICKHOUSE_PASSWORD || "flowpass";

  const ch = createClient({
    url: clickhouseUrl,
    database: clickhouseDb,
    username: clickhouseUser,
    password: clickhousePassword,
  });

  await initializeDB();

  const sessionRepo = AppDataSource.getRepository(SessionTracking);
  const cache = new Map<string, CacheEntry>();
  const cacheTtlMs = envInt("FLOW_USERNAME_CACHE_TTL_MS", 60_000);

  async function resolveUsernameBySrcIp(srcIp: string): Promise<CacheEntry | null> {
    const now = Date.now();
    const cached = cache.get(srcIp);
    if (cached && cached.expiresAt > now) return cached;

    // Prefer currently active session with matching framed IP (PPPoE Framed-IP-Address).
    // If you track stale sessions, optionally enforce recent lastUpdate.
    const row = await sessionRepo
      .createQueryBuilder("st")
      .select(["st.username AS username", "st.sessionId AS sessionId"])
      .where("st.framedIp = :ip", { ip: srcIp })
      .andWhere("st.status = 'active'")
      .orderBy("COALESCE(st.lastUpdate, st.startTime)", "DESC")
      .limit(1)
      .getRawOne<{ username: string; sessionId: string }>();

    if (!row?.username) return null;

    const entry: CacheEntry = {
      username: row.username,
      sessionId: row.sessionId,
      expiresAt: now + cacheTtlMs,
    };
    cache.set(srcIp, entry);
    return entry;
  }

  let inserted = 0;
  let skipped = 0;

  const flushEvery = envInt("FLOW_BATCH_SIZE", 500);
  const buffer: any[] = [];
  let lastFlush = Date.now();
  const flushIntervalMs = envInt("FLOW_FLUSH_INTERVAL_MS", 2000);

  async function flush() {
    if (!buffer.length) return;
    const rows = buffer.splice(0, buffer.length);
    try {
      await ch.insert({
        table: "user_flow_logs",
        format: "JSONEachRow",
        values: rows,
      });
      inserted += rows.length;
    } catch (err: any) {
      console.error("❌ ClickHouse insert failed:", err);
      const errStr = String(err?.message || err) + String(err?.code || "");
      if (errStr.includes("TOO_MANY_UNEXPECTED_DATA_PARTS") || String(err?.code) === "722") {
        try {
          console.log("🛠️ ClickHouse broken parts limit reached. Attaching table with expanded threshold...");
          await ch.command({
            query: `ATTACH TABLE user_flow_logs SETTINGS max_suspicious_broken_parts = 10000;`,
          });
          console.log("✅ ClickHouse table successfully attached and recovered!");
        } catch (repairErr) {
          console.error("❌ Auto-repair attach failed:", repairErr);
        }
      }
    }
  }

  setInterval(() => {
    flush().catch(() => {});
  }, flushIntervalMs).unref();

  // NetFlow v9/IPFIX decoder.
  // NOTE: The library's internal UDP bind can be flaky in containers; we bind our own socket and only use its decoder.
  const decoder = Collector({});

  const server = dgram.createSocket("udp4");
  server.on("error", (err) => {
    console.error("❌ UDP socket error:", err);
  });

  server.on("message", async (msg, rinfo) => {
    try {
      const decoded = (decoder as any).nfPktDecode(msg, rinfo);

      if (decoded?.templates && process.env.FLOW_LOG_TEMPLATES === "true") {
        console.log("📦 NetFlow template packet", decoded.templates);
      }

      const flows: any[] = decoded?.flows || [];
      if (!flows.length) return;

      for (const flow of flows) {
        // Normalize common NetFlow v9 keys
        const srcIp = first<string>(flow, ["ipv4_src_addr", "IPV4_SRC_ADDR", "src_addr", "srcaddr", "srcAddress"]);
        const dstIp = first<string>(flow, ["ipv4_dst_addr", "IPV4_DST_ADDR", "dst_addr", "dstaddr", "dstAddress"]);
        const srcPort = first<any>(flow, ["l4_src_port", "L4_SRC_PORT", "src_port", "srcPort"]);
        const dstPort = first<any>(flow, ["l4_dst_port", "L4_DST_PORT", "dst_port", "dstPort"]);
        const proto = first<any>(flow, ["protocol", "PROTOCOL", "proto"]);
        const bytes = first<any>(flow, ["in_bytes", "IN_BYTES", "octetDeltaCount", "bytes"]);
        const packets = first<any>(flow, ["in_pkts", "IN_PKTS", "packetDeltaCount", "packets"]);

        if (!srcIp || !dstIp) {
          skipped += 1;
          continue;
        }

        // Depending on which interface(s) MikroTik exports, the user IP may appear as src or dst.
        const mappingFromSrc = await resolveUsernameBySrcIp(srcIp);
        const mappingFromDst = mappingFromSrc ? null : await resolveUsernameBySrcIp(dstIp);
        const mapping = mappingFromSrc || mappingFromDst;

        if (!mapping?.username) {
          if (process.env.FLOW_LOG_UNMAPPED === "true") {
            console.log("⚠️ Unmapped flow", { srcIp, dstIp, srcPort, dstPort, proto, bytes, packets });
          }
          skipped += 1;
          continue;
        }

        const clientIp = mappingFromSrc ? srcIp : dstIp;
        const remoteIp = mappingFromSrc ? dstIp : srcIp;
        const remotePort = mappingFromSrc ? dstPort : srcPort;

        // ClickHouse DateTime expects "YYYY-MM-DD HH:MM:SS"
        const ts = new Date().toISOString().slice(0, 19).replace("T", " ");

        buffer.push({
          ts,
          username: mapping.username,
          // Store user/client IP as src_ip, remote as dst_ip
          src_ip: clientIp,
          dst_ip: remoteIp,
          dst_port: asUInt(remotePort, 0),
          proto: asUInt(proto, 0),
          bytes: asUInt(bytes, 0),
          packets: asUInt(packets, 0),
          router_id: process.env.FLOW_ROUTER_ID || "",
          session_id: mapping.sessionId || "",
        });
      }

      // simple flush conditions
      const now = Date.now();
      if (buffer.length >= flushEvery || now - lastFlush > flushIntervalMs) {
        lastFlush = now;
        flush().catch(() => {});
      }
    } catch (err) {
      console.error("Flow decode/handle error:", err);
    }
  });

  server.bind(listenPort);
  console.log(`✅ Flow ingestor listening on UDP :${listenPort}`);

  setInterval(() => {
    console.log(`📊 flow-ingestor inserted=${inserted} skipped=${skipped} buffer=${buffer.length}`);
  }, envInt("FLOW_STATS_INTERVAL_MS", 15000)).unref();
}

main().catch((err) => {
  console.error("Fatal flow ingestor error:", err);
  process.exit(1);
});

