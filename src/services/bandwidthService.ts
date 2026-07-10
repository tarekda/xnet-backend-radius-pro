// Try to load node-routeros at runtime. If it fails (e.g. missing in container) we stay in mock mode.
let RouterOSAPI: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RouterOSAPI = require('node-routeros').RouterOSAPI;
} catch (err) {
  // Module not present – will run in mock mode
}

import { Logger } from '../logging/logging';
import { getMikroTikPassword } from '../config/requireSecrets';

const logger = Logger.getInstance();

export interface BandwidthData {
  interface: string;
  rxByte: number;
  txByte: number;
  rxPacket: number;
  txPacket: number;
  rxRate: number;
  txRate: number;
  timestamp: Date;
}

export interface BandwidthSummary {
  totalRxBytes: number;
  totalTxBytes: number;
  totalRxRate: number;
  totalTxRate: number;
  interfaces: BandwidthData[];
  timestamp: Date;
}

export class BandwidthService {
  private routerIP: string;
  private username: string;
  private password: string;
  private apiPort: number;
  private monitorInterface: string;
  private conn: any; // RouterOSAPI instance or null in mock mode
  private readonly mockMode: boolean;
  private connecting: Promise<void> | null = null;
  private lastConnectFailureAtMs: number | null = null;
  private readonly connectCooldownMs: number;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly cacheTtlMs: number;

  private cache: {
    interfaceTraffic: { value: BandwidthData[]; ts: number } | null;
    systemResources: { value: any; ts: number } | null;
  } = {
    interfaceTraffic: null,
    systemResources: null,
  };

  constructor() {
    this.routerIP = process.env.MIKROTIK_IP || '172.9.16.2';
    // Backwards-compat: some envs use MIKROTIK_USER
    this.username = process.env.MIKROTIK_USERNAME || process.env.MIKROTIK_USER || 'apiuser';
    this.password = getMikroTikPassword() || '';
    this.apiPort = parseInt(process.env.MIKROTIK_API_PORT || '8728');
    this.monitorInterface = process.env.MIKROTIK_MONITOR_INTERFACE || 'ether6-OUT';

    // Fast defaults for a polling dashboard:
    // - keep requests snappy even if router is slow/unreachable
    // - cache results briefly to avoid hammering RouterOS every second
    this.connectCooldownMs = parseInt(process.env.MIKROTIK_CONNECT_COOLDOWN_MS || '5000', 10);
    this.connectTimeoutMs = parseInt(process.env.MIKROTIK_CONNECT_TIMEOUT_MS || '2000', 10);
    this.commandTimeoutMs = parseInt(process.env.MIKROTIK_COMMAND_TIMEOUT_MS || '2500', 10);
    this.cacheTtlMs = parseInt(process.env.MIKROTIK_CACHE_TTL_MS || '1500', 10);

    this.mockMode = !RouterOSAPI;

    if (this.mockMode) {
      this.conn = null;
      logger.warn('BandwidthService running in MOCK MODE – node-routeros module not available');
    } else {
      this.createConnection();
      logger.info('BandwidthService initialised in REAL MODE – MikroTik integration enabled');
    }
  }

  private createConnection(): void {
    this.conn = new RouterOSAPI({
      host: this.routerIP,
      user: this.username,
      password: this.password,
      port: this.apiPort,
      timeout: this.commandTimeoutMs,
      // Send periodic pings so idle connections aren't silently dropped by
      // the router / NAT, which previously left us with a socket that still
      // reported connected=true but timed out on every command.
      keepalive: true
    });

    // --------------------------------------------------------------------
    // Attach low-level error & timeout handlers
    // --------------------------------------------------------------------
    // The node-routeros connector emits an "error" event (and sometimes a
    // RosException) when the underlying socket times out or encounters
    // another fatal issue.  If no listener is registered, Node treats it as
    // an unhandled exception and the whole process crashes.  By attaching a
    // defensive listener we make sure the error is logged and let the
    // higher-level promise rejection flow handle it gracefully.
    this.conn.on('error', (err: any) => {
      // Log and swallow – callers will also receive a rejected promise.
      logger.error('RouterOSAPI emitted an error event:', err?.message || err);

      // Ensure we are in a clean state – close the connection so the next
      // operation can trigger a fresh reconnect via ensureConnection().
      if (this.conn.connected) {
        this.conn.close();
      }
    });

    // "timeout" events are not always re-emitted as errors by the library
    // but can still crash the process if unhandled.
    this.conn.on('timeout', () => {
      logger.warn('RouterOSAPI connection timed out');
    });
  }

  /**
   * Tear down a (possibly wedged) connection and build a fresh instance so
   * the next ensureConnection() performs a clean reconnect. Called when a
   * command fails even though the socket claims to be connected — the
   * classic "stale connection" state after long idle periods.
   */
  private resetConnection(): void {
    if (this.mockMode) return;
    logger.warn('Resetting MikroTik connection after command failure');
    try {
      this.conn?.removeAllListeners?.();
      this.conn?.close?.();
    } catch {
      // ignore – socket may already be dead
    }
    this.connecting = null;
    this.createConnection();
  }

  /* ------------------------------------------------------------------
   * Connection handling (real mode only)
   * ------------------------------------------------------------------*/
  private async ensureConnection(): Promise<void> {
    if (this.mockMode) return; // nothing to do

    try {
      if (this.conn.connected) return;

      // If we recently failed to connect, fail fast to keep APIs responsive.
      if (this.lastConnectFailureAtMs && Date.now() - this.lastConnectFailureAtMs < this.connectCooldownMs) {
        throw new Error(`MikroTik connect cooldown (${this.connectCooldownMs}ms)`);
      }

      // Deduplicate concurrent connect() calls (common when /metrics does Promise.all).
      if (!this.connecting) {
        this.connecting = (async () => {
          logger.debug(`Connecting to MikroTik ${this.routerIP}:${this.apiPort}`);
          await this.withTimeout(this.conn.connect(), this.connectTimeoutMs, 'mikrotik connect');
          logger.info('Connected to MikroTik');
          this.lastConnectFailureAtMs = null;
        })().catch((err: any) => {
          this.lastConnectFailureAtMs = Date.now();
          // Ensure we are in a clean state for the next attempt.
          try {
            if (this.conn.connected) this.conn.close();
          } catch {
            // ignore
          }
          throw err;
        }).finally(() => {
          this.connecting = null;
        });
      }

      await this.connecting;
    } catch (error: any) {
      logger.error('Failed to connect to MikroTik:', error.message || error);
      throw new Error('MikroTik connection failed');
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let t: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_resolve, reject) => {
          t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (t) clearTimeout(t);
    }
  }

  /* ------------------------------------------------------------------
   * Interface traffic
   * ------------------------------------------------------------------*/
  async getInterfaceTraffic(): Promise<BandwidthData[]> {
    if (this.mockMode) return this.generateMockInterfaceTraffic();

    const now = Date.now();
    if (this.cache.interfaceTraffic && now - this.cache.interfaceTraffic.ts <= this.cacheTtlMs) {
      return this.cache.interfaceTraffic.value;
    }

    await this.ensureConnection();

    // We only care about one interface (default: ether6-OUT).
    // /interface/monitor-traffic returns *rates* (packets/sec, bits/sec), not cumulative bytes.
    const ifaceName = this.monitorInterface || 'ether6-OUT';

    const stats = (await this.withTimeout(
      this.conn.write('/interface/monitor-traffic', [
        `=interface=${ifaceName}`,
        '=once=yes',
      ]),
      this.commandTimeoutMs,
      'interface monitor-traffic'
    ).catch((e: any) => {
      logger.warn('getInterfaceTraffic failed:', e?.message || e);
      this.resetConnection();
      return [];
    })) as any[];

    if (!stats.length) {
      // If router is flapping, serve stale cache if available.
      if (this.cache.interfaceTraffic) return this.cache.interfaceTraffic.value;
      return [];
    }
    const s = stats[0];

    // Parse RouterOS rate strings like "17.7Mbps", "0bps", "11 117"
    // We return Mbps (number) because UI only needs Mbps.
    const parseRateToMbps = (value: any): number => {
      if (value === null || value === undefined) return 0;
      if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
      const raw = String(value).trim();
      if (!raw) return 0;
      const s0 = raw.replace(/\s+/g, '');
      const m = /^([0-9]*\.?[0-9]+)([kKmMgGtT]?)(?:b(?:it)?s)?(?:\/s)?(?:ps)?$/i.exec(s0);
      if (!m) {
        const n = Number.parseFloat(s0);
        return Number.isFinite(n) ? n : 0;
      }
      const num = Number.parseFloat(m[1]);
      if (!Number.isFinite(num)) return 0;
      const unit = (m[2] || '').toUpperCase();
      // interpret value as bits per second with unit suffix, convert to Mbps
      // K -> Kbps, M -> Mbps, G -> Gbps, T -> Tbps, '' -> bps
      const bps =
        unit === 'K' ? num * 1e3 :
        unit === 'M' ? num * 1e6 :
        unit === 'G' ? num * 1e9 :
        unit === 'T' ? num * 1e12 :
        num;
      return bps / 1e6;
    };

    const downloadMbps = parseRateToMbps(
      s['fp-rx-bits-per-second'] ?? s['rx-bits-per-second'] ?? s['rx-bps'] ?? 0
    );
    const uploadMbps = parseRateToMbps(
      s['tx-bits-per-second'] ?? s['tx-bps'] ?? s['fp-tx-bits-per-second'] ?? 0
    );

    // packets/sec are plain numbers (may contain spaces)
    const rxPacketsPerSec = Number.parseFloat(String(s['rx-packets-per-second'] ?? '0').replace(/\s+/g, '')) || 0;
    const txPacketsPerSec = Number.parseFloat(String(s['tx-packets-per-second'] ?? '0').replace(/\s+/g, '')) || 0;

    const result: BandwidthData[] = [
      {
        interface: ifaceName,
        // monitor-traffic doesn't provide cumulative bytes; keep 0 for now
        rxByte: 0,
        txByte: 0,
        // packets per second
        rxPacket: Math.floor(rxPacketsPerSec),
        txPacket: Math.floor(txPacketsPerSec),
        // Mbps (download/upload)
        rxRate: downloadMbps,
        txRate: uploadMbps,
        timestamp: new Date(),
      },
    ];
    this.cache.interfaceTraffic = { value: result, ts: Date.now() };
    return result;
  }

  /* ------------------------------------------------------------------
   * System resources
   * ------------------------------------------------------------------*/
  async getSystemResources(): Promise<any> {
    if (this.mockMode) return this.generateMockSystemResources();

    const now = Date.now();
    if (this.cache.systemResources && now - this.cache.systemResources.ts <= this.cacheTtlMs) {
      return this.cache.systemResources.value;
    }

    await this.ensureConnection();
    const res = (await this.withTimeout(
      this.conn.write('/system/resource/print'),
      this.commandTimeoutMs,
      'system resource'
    ).catch((e: any) => {
      logger.warn('getSystemResources failed:', e?.message || e);
      this.resetConnection();
      return [];
    })) as any[];
    if (!res.length) {
      // Router is flapping — serve stale cache if we have one so the
      // dashboard keeps rendering instead of turning into a 500.
      if (this.cache.systemResources) return this.cache.systemResources.value;
      throw new Error('No system resource data');
    }
    const r = res[0];
    const out = {
      cpuLoad: r['cpu-load'] || '0%',
      freeMemory: r['free-memory'] || '0',
      totalMemory: r['total-memory'] || '0',
      freeHddSpace: r['free-hdd-space'] || '0',
      totalHddSpace: r['total-hdd-space'] || '0',
      uptime: r.uptime || '0s',
      version: r.version || 'Unknown',
      platform: r.platform || 'Unknown',
      boardName: r['board-name'] || 'Unknown',
      architecture: r['architecture-name'] || 'Unknown',
      timestamp: new Date()
    };
    this.cache.systemResources = { value: out, ts: Date.now() };
    return out;
  }

  /* ------------------------------------------------------------------
   * Active connections (PPP + DHCP)
   * ------------------------------------------------------------------*/
  async getActiveConnections(): Promise<any> {
    if (this.mockMode) return this.generateMockActiveConnections();

    await this.ensureConnection();
    const pppActive = await this.conn.write('/ppp/active/print').catch(() => []);
    const dhcpLeases = await this.conn.write('/ip/dhcp-server/lease/print', [
      '?status=bound'
    ]).catch(() => []);
    return {
      pppConnections: pppActive,
      dhcpConnections: dhcpLeases,
      totalActiveConnections: pppActive.length + dhcpLeases.length
    };
  }

  /* ------------------------------------------------------------------
   * User traffic
   * ------------------------------------------------------------------*/
  async getUserTraffic(username: string): Promise<any> {
    if (this.mockMode) return this.generateMockUserTraffic(username);

    await this.ensureConnection();
    const pppActive = await this.conn.write('/ppp/active/print', [`?name=${username}`]).catch(() => []);
    if (pppActive.length) {
      const u = pppActive[0];
      return {
        username,
        isOnline: true,
        connectionType: 'ppp',
        address: u.address,
        uptime: u.uptime,
        bytesIn: u['bytes-in'] || 0,
        bytesOut: u['bytes-out'] || 0,
        timestamp: new Date()
      };
    }
    return { username, isOnline: false };
  }

  /* ------------------------------------------------------------------
   * Disconnect user (PPP + Hotspot)
   * ------------------------------------------------------------------*/
  async disconnectUser(username: string): Promise<{ pppRemoved: number; hotspotRemoved: number }> {
    if (!username || !String(username).trim()) {
      throw new Error("username is required");
    }
    if (this.mockMode) {
      logger.warn(`BandwidthService.disconnectUser(${username}) in MOCK MODE – no action taken`);
      return { pppRemoved: 0, hotspotRemoved: 0 };
    }

    await this.ensureConnection();

    let pppRemoved = 0;
    let hotspotRemoved = 0;

    // PPP sessions (PPPoE / PPTP / etc.)
    const pppActive = await this.conn.write('/ppp/active/print', [`?name=${username}`]).catch(() => []);
    for (const s of pppActive) {
      const id = s?.['.id'];
      if (!id) continue;
      await this.conn.write('/ppp/active/remove', [`=.id=${id}`]).catch(() => null);
      pppRemoved += 1;
    }

    // Hotspot sessions
    const hsActive = await this.conn.write('/ip/hotspot/active/print', [`?user=${username}`]).catch(() => []);
    for (const s of hsActive) {
      const id = s?.['.id'];
      if (!id) continue;
      await this.conn.write('/ip/hotspot/active/remove', [`=.id=${id}`]).catch(() => null);
      hotspotRemoved += 1;
    }

    return { pppRemoved, hotspotRemoved };
  }

  /* ------------------------------------------------------------------
   *Helpers: MOCK generators
   * ------------------------------------------------------------------*/
  private generateMockInterfaceTraffic(): BandwidthData[] {
    logger.debug('Generating mock interface stats');
    return [this.generateMockEth(this.monitorInterface || 'ether6-OUT')[0]];
  }

  private generateMockEth(name: string): BandwidthData[] {
    return [{
      interface: name,
      rxByte: Math.floor(Math.random() * 4_000_000) + 500_000,
      txByte: Math.floor(Math.random() * 2_000_000) + 300_000,
      rxPacket: Math.floor(Math.random() * 4_000) + 800,
      txPacket: Math.floor(Math.random() * 2_500) + 400,
      // Mbps (match real mode output)
      rxRate: (Math.random() * 200 + 10), // 10–210 Mbps
      txRate: (Math.random() * 800 + 50), // 50–850 Mbps
      timestamp: new Date()
    }];
  }

  private generateMockSystemResources() {
    return {
      cpuLoad: `${Math.floor(Math.random() * 30) + 5}%`,
      freeMemory: `${Math.floor(Math.random() * 200) + 400}MB`,
      totalMemory: '1024MB',
      freeHddSpace: `${Math.floor(Math.random() * 5) + 85}GB`,
      totalHddSpace: '128GB',
      uptime: `${Math.floor(Math.random() * 30) + 1}d ${Math.floor(Math.random() * 24)}h`,
      version: '6.49.10 (mock)',
      platform: 'MikroTik (mock)',
      boardName: 'RB1100AHx4 (mock)',
      architecture: 'arm (mock)',
      timestamp: new Date()
    };
  }

  private generateMockActiveConnections() {
    const names = ['alice', 'bob', 'charlie', 'dave', 'eve'];
    const ppp = names.slice(0, Math.floor(Math.random() * names.length) + 1).map((n, i) => ({
      name: n,
      address: `10.0.0.${10 + i}`,
      uptime: `${Math.floor(Math.random() * 4) + 1}h`,
      'bytes-in': Math.floor(Math.random() * 50_000_000),
      'bytes-out': Math.floor(Math.random() * 25_000_000)
    }));
    const dhcp = Array.from({ length: Math.floor(Math.random() * 4) + 2 }, (_, i) => ({
      address: `192.168.1.${100 + i}`,
      'mac-address': `00:11:22:33:44:${(50 + i).toString(16).padStart(2, '0')}`
    }));
    return { pppConnections: ppp, dhcpConnections: dhcp, totalActiveConnections: ppp.length + dhcp.length };
  }

  private generateMockUserTraffic(username: string) {
    const online = Math.random() > 0.3;
    return {
      username,
      isOnline: online,
      connectionType: online ? 'ppp' : null,
      address: online ? `10.0.0.${Math.floor(Math.random() * 50)}` : null,
      uptime: online ? `${Math.floor(Math.random() * 5)}h` : null,
      bytesIn: online ? Math.floor(Math.random() * 50_000_000) : 0,
      bytesOut: online ? Math.floor(Math.random() * 20_000_000) : 0,
      timestamp: new Date()
    };
  }

  async disconnect(): Promise<void> {
    if (!this.mockMode && this.conn?.connected) {
      await this.conn.close();
    }
  }

  async cleanup(): Promise<void> {
    await this.disconnect();
  }

  /* ------------------------------------------------------------------
   * Bandwidth summary
   * ------------------------------------------------------------------*/
  async getBandwidthSummary(): Promise<BandwidthSummary> {
    const interfaces = await this.getInterfaceTraffic();

    const summary: BandwidthSummary = {
      totalRxBytes: 0,
      totalTxBytes: 0,
      totalRxRate: 0,
      totalTxRate: 0,
      interfaces,
      timestamp: new Date()
    };

    interfaces.forEach((iface) => {
      summary.totalRxBytes += iface.rxByte;
      summary.totalTxBytes += iface.txByte;
      summary.totalRxRate += iface.rxRate;
      summary.totalTxRate += iface.txRate;
    });

    return summary;
  }

  /* ------------------------------------------------------------------
   * Historical traffic (simple: current snapshot)
   * ------------------------------------------------------------------*/
  async getHistoricalTraffic(interfaceName: string, duration: number = 3600): Promise<BandwidthData[]> {
    // In a real implementation we would query stored historical data.
    // For now we just return the current snapshot for the requested interface.
    const interfaces = await this.getInterfaceTraffic();
    return interfaces.filter((i) => i.interface === interfaceName);
  }

  /* ------------------------------------------------------------------
   * Simple connectivity test
   * ------------------------------------------------------------------*/
  async testConnection(): Promise<boolean> {
    if (this.mockMode) return true;
    try {
      await this.ensureConnection();
      // A lightweight command just to verify auth & connectivity
      await this.conn.write('/system/identity/print');
      return true;
    } catch (err) {
      logger.warn('MikroTik testConnection failed:', err);
      return false;
    }
  }
}

export const bandwidthService = new BandwidthService(); 