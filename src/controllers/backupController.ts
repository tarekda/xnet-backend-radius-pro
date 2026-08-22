import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { RouterOSAPI } from "node-routeros";
import os from "os";

type BackupKind = "db" | "mikrotik-export";
type BackupStatus = "running" | "success" | "failed";

export type BackupMeta = {
  id: string;
  kind: BackupKind;
  createdAt: string;
  status: BackupStatus;
  finishedAt?: string;
  filename: string;
  absolutePath: string;
  sizeBytes: number;
  details?: Record<string, any>;
  error?: string;
};

const sendResponse = (res: Response, success: boolean, status: number, message: string, data: any = null) => {
  res.status(status).json({ success, message, data });
};

function getBackupDir(): string {
  const dir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.resolve(process.cwd(), "backups");
  return dir;
}

async function ensureBackupDir(): Promise<string> {
  const dir = getBackupDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function safeTimestamp(): string {
  const d = new Date();
  // YYYYMMDD_HHMMSS
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeHost(host: string): string {
  return String(host || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
}

async function loadIndex(): Promise<BackupMeta[]> {
  const dir = await ensureBackupDir();
  const indexPath = path.join(dir, "index.json");
  try {
    const raw = await fsp.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BackupMeta[]) : [];
  } catch {
    return [];
  }
}

async function saveIndex(entries: BackupMeta[]): Promise<void> {
  const dir = await ensureBackupDir();
  const indexPath = path.join(dir, "index.json");
  await fsp.writeFile(indexPath, JSON.stringify(entries.slice(0, 500), null, 2), "utf8");
}

async function appendIndex(meta: BackupMeta): Promise<void> {
  const entries = await loadIndex();
  entries.unshift(meta);
  await saveIndex(entries);
}

async function updateIndex(id: string, patch: Partial<BackupMeta>): Promise<void> {
  const entries = await loadIndex();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return;
  entries[idx] = { ...entries[idx], ...patch };
  await saveIndex(entries);
}

function getDbBackupMaxSeconds(): number {
  const raw = Number(process.env.BACKUP_DB_TIMEOUT_SECONDS ?? 1800);
  if (!Number.isFinite(raw) || raw <= 0) return 1800;
  return Math.min(Math.max(raw, 30), 24 * 60 * 60);
}

function getRunningStaleSeconds(): number {
  const raw = Number(process.env.BACKUP_JOB_STALE_SECONDS ?? 4 * 60 * 60);
  if (!Number.isFinite(raw) || raw <= 0) return 4 * 60 * 60;
  return Math.min(Math.max(raw, 60), 7 * 24 * 60 * 60);
}

async function killProcessTree(pid: number): Promise<void> {
  if (!pid || !Number.isFinite(pid)) return;
  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        p.on("close", () => resolve());
        p.on("error", () => resolve());
      });
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  } catch {}
}

async function reconcileRunningJobs(): Promise<void> {
  const entries = await loadIndex();
  const staleSeconds = getRunningStaleSeconds();
  const now = Date.now();
  let changed = false;

  for (const e of entries) {
    if (e.status !== "running") continue;
    const created = Date.parse(e.createdAt);
    if (!Number.isFinite(created)) continue;
    const ageSec = (now - created) / 1000;
    if (ageSec <= staleSeconds) continue;

    // Server likely restarted or job hung. Mark as failed; keep file if it exists (admin can delete manually).
    e.status = "failed";
    e.finishedAt = new Date().toISOString();
    e.error = e.error || `Stale running job (>${staleSeconds}s). ${os.hostname()}`;
    changed = true;
  }

  if (changed) await saveIndex(entries);
}

function resolveDbConfig() {
  const host = String(process.env.DB_HOST ?? process.env.MYSQL_HOST ?? "127.0.0.1");
  const port = Number(process.env.DB_PORT ?? process.env.MYSQL_PORT ?? 3306);
  const user = String(process.env.DB_USER ?? process.env.DB_USERNAME ?? process.env.MYSQL_USER ?? "root");
  const password = String(process.env.DB_PASSWORD ?? process.env.MYSQL_PASSWORD ?? "");
  const database = String(process.env.DB_NAME ?? process.env.DB_DATABASE ?? process.env.MYSQL_DATABASE ?? "radius");
  return { host, port, user, password, database };
}

function getMysqldumpCommand(): string {
  // Prefer an explicit path on Windows, e.g.:
  // BACKUP_MYSQLDUMP_PATH="C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe"
  const explicit = String(process.env.BACKUP_MYSQLDUMP_PATH ?? "").trim();
  return explicit.length ? explicit : "mysqldump";
}

async function mysqldumpPreflight(): Promise<void> {
  // Fast check to surface "mysqldump not installed" immediately on Windows.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(getMysqldumpCommand(), ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      void killProcessTree(child.pid || 0);
      reject(new Error("mysqldump --version timed out"));
    }, 2000);
    child.on("error", (e: any) => {
      clearTimeout(timer);
      reject(new Error(
        e?.code === "ENOENT"
          ? "mysqldump not found. Install MySQL client tools or set BACKUP_MYSQLDUMP_PATH to mysqldump.exe"
          : (e?.message || "mysqldump preflight failed")
      ));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`mysqldump preflight failed (exit ${code})`));
    });
  });
}

async function runMysqldumpToGzipFile(outPath: string): Promise<{ bytes: number; mode: "local" | "docker" }> {
  const { host, port, user, password, database } = resolveDbConfig();
  const mode = String(process.env.BACKUP_DB_MODE ?? "auto").toLowerCase(); // auto|local|docker
  const dockerContainer = String(process.env.BACKUP_DB_DOCKER_CONTAINER ?? "").trim();
  const timeoutMs = getDbBackupMaxSeconds() * 1000;

  const buildArgs = () => [
    // IMPORTANT (Windows): force TCP. "localhost" can use named pipe/shared memory and hang.
    "--protocol=tcp",
    `--host=${host}`,
    `--port=${port}`,
    `--user=${user}`,
    "--single-transaction",
    "--routines",
    "--events",
    "--triggers",
    database,
  ];

  const tryLocal = async () => {
    const child = spawn(getMysqldumpCommand(), buildArgs(), {
      env: { ...process.env, MYSQL_PWD: password },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // IMPORTANT:
    // Attach exit/error listeners immediately. If mysqldump exits quickly (e.g. can't connect),
    // and we attach the "close" listener only after awaiting pipeline(), we can miss the event
    // and the job will hang forever in "running" state.
    const exitPromise: Promise<number> = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(typeof code === "number" ? code : 0));
    });

    const gzip = createGzip({ level: 9 });
    const file = fs.createWriteStream(outPath);

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (d) => stderrChunks.push(Buffer.from(d)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid || 0);
    }, timeoutMs);

    try {
      await pipeline(child.stdout, gzip, file);
    } finally {
      clearTimeout(timer);
    }
    const exitCode: number = await exitPromise;
    if (timedOut) {
      throw new Error(`mysqldump timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (exitCode !== 0) {
      const err = Buffer.concat(stderrChunks).toString("utf8").trim();
      throw new Error(err || `mysqldump failed (exit ${exitCode})`);
    }

    const st = await fsp.stat(outPath);
    return { bytes: st.size, mode: "local" as const };
  };

  const tryDocker = async () => {
    if (!dockerContainer) throw new Error("BACKUP_DB_DOCKER_CONTAINER is required for docker mode");
    const child = spawn(
      "docker",
      ["exec", "-e", `MYSQL_PWD=${password}`, dockerContainer, "mysqldump", ...buildArgs()],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );

    const exitPromise: Promise<number> = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(typeof code === "number" ? code : 0));
    });

    const gzip = createGzip({ level: 9 });
    const file = fs.createWriteStream(outPath);

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (d) => stderrChunks.push(Buffer.from(d)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid || 0);
    }, timeoutMs);

    try {
      await pipeline(child.stdout, gzip, file);
    } finally {
      clearTimeout(timer);
    }
    const exitCode: number = await exitPromise;
    if (timedOut) {
      throw new Error(`docker mysqldump timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (exitCode !== 0) {
      const err = Buffer.concat(stderrChunks).toString("utf8").trim();
      throw new Error(err || `docker mysqldump failed (exit ${exitCode})`);
    }

    const st = await fsp.stat(outPath);
    return { bytes: st.size, mode: "docker" as const };
  };

  if (mode === "local") return await tryLocal();
  if (mode === "docker") return await tryDocker();

  // auto
  try {
    return await tryLocal();
  } catch (eLocal: any) {
    // If the DB is on the host (common in Windows + Docker Desktop), docker mode is not applicable
    // unless a container name is explicitly provided.
    if (!dockerContainer) {
      throw new Error(`DB backup failed. Local error: ${eLocal?.message || eLocal}`);
    }
    try {
      return await tryDocker();
    } catch (eDocker: any) {
      throw new Error(`DB backup failed. Local error: ${eLocal?.message || eLocal}. Docker error: ${eDocker?.message || eDocker}`);
    }
  }
}

async function startDbBackupJob(): Promise<BackupMeta> {
  const dir = await ensureBackupDir();
  const ts = safeTimestamp();
  const id = randomUUID();
  const { database, host, port, user } = resolveDbConfig();
  const filename = `db_${sanitizeHost(database)}_${ts}.sql.gz`;
  const outPath = path.join(dir, filename);
  const maxSeconds = getDbBackupMaxSeconds();
  const backupMode = String(process.env.BACKUP_DB_MODE ?? "auto").toLowerCase();

  const meta: BackupMeta = {
    id,
    kind: "db",
    createdAt: new Date().toISOString(),
    status: "running",
    filename,
    absolutePath: outPath,
    sizeBytes: 0,
    details: {
      db: database,
      maxSeconds,
      host,
      port,
      user,
      mode: backupMode,
    },
  };
  await appendIndex(meta);

  // IMPORTANT: run in background so proxies don't time out (fixes 524)
  setImmediate(async () => {
    try {
      await mysqldumpPreflight();
    } catch (e: any) {
      await updateIndex(id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: e?.message || "mysqldump preflight failed",
      });
      return;
    }

    const heartbeat = setInterval(async () => {
      try {
        const st = await fsp.stat(outPath);
        await updateIndex(id, {
          sizeBytes: st.size,
          details: { ...(meta.details ?? {}), lastHeartbeatAt: new Date().toISOString() },
        });
      } catch {
        // file may not exist yet
      }
    }, 5000);

    try {
      const result = await runMysqldumpToGzipFile(outPath);
      let offsitePath: string | undefined;
      const offsiteDir = String(process.env.BACKUP_OFFSITE_DIR || "").trim();
      if (offsiteDir) {
        await fsp.mkdir(offsiteDir, { recursive: true });
        offsitePath = path.join(offsiteDir, filename);
        await fsp.copyFile(outPath, offsitePath);
      }
      await updateIndex(id, {
        status: "success",
        finishedAt: new Date().toISOString(),
        sizeBytes: result.bytes,
        details: {
          ...(meta.details ?? {}),
          mode: result.mode,
          lastHeartbeatAt: new Date().toISOString(),
          ...(offsitePath ? { offsitePath } : {}),
        },
      });
    } catch (e: any) {
      try {
        await fsp.unlink(outPath);
      } catch {}
      await updateIndex(id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: e?.message || "DB backup failed",
      });
    } finally {
      clearInterval(heartbeat);
    }
  });

  return meta;
}

async function mikrotikExport(host: string, opts?: { username?: string; password?: string; port?: number }): Promise<string> {
  const routerIP = host;
  const username = String(opts?.username ?? process.env.MIKROTIK_USERNAME ?? "apiuser");
  const password = String(opts?.password ?? process.env.MIKROTIK_PASSWORD ?? "");
  const apiPort = Number(opts?.port ?? process.env.MIKROTIK_API_PORT ?? 8728);
  const timeout = Number(process.env.MIKROTIK_TIMEOUT ?? 10000);

  const conn = new RouterOSAPI({
    host: routerIP,
    user: username,
    password,
    port: apiPort,
    timeout,
  });

  const normalize = (rows: any): string => {
    // node-routeros export shapes vary; normalize into a string
    if (typeof rows === "string") return rows;
    if (Array.isArray(rows)) {
      const parts = rows.map((r) => {
        if (typeof r === "string") return r;
        if (r?.ret) return String(r.ret);
        if (r?.text) return String(r.text);
        if (r?.message) return String(r.message);
        // Some RouterOS sentences return keys like "!re" / "!done" etc; keep best-effort output
        return Object.keys(r || {}).length ? JSON.stringify(r) : "";
      });
      return parts.filter((p) => p.trim().length > 0).join("\n");
    }
    return rows == null ? "" : JSON.stringify(rows);
  };

  try {
    await conn.connect();

    // RouterOS "/export" is not a typical "print" command; some devices/libs return empty for certain flags.
    // Try a couple of variants to maximize compatibility.
    const attempts: Array<() => Promise<any>> = [
      () => conn.write("/export"),
      () => conn.write("/export", ["=terse=yes"]),
    ];

    let last: any = null;
    for (const run of attempts) {
      last = await run();
      const out = normalize(last).trim();
      if (out.length > 0) return out + "\n";
    }

    throw new Error(
      `MikroTik export returned empty output (host=${routerIP}, user=${username}, port=${apiPort}). ` +
        `Last response: ${typeof last === "string" ? last : JSON.stringify(last)}`
    );
  } finally {
    try {
      await conn.close();
    } catch {}
  }
}

async function createMikrotikBackup(host: string): Promise<BackupMeta> {
  const dir = await ensureBackupDir();
  const ts = safeTimestamp();
  const id = randomUUID();
  const safeHost = sanitizeHost(host);
  const filename = `mikrotik_${safeHost}_${ts}.rsc`;
  const outPath = path.join(dir, filename);

  const content = await mikrotikExport(host);
  if (!content.trim().length) {
    // Safety net: never create empty export files (these confuse users on download).
    throw new Error("MikroTik export produced empty output");
  }
  await fsp.writeFile(outPath, content, "utf8");
  const st = await fsp.stat(outPath);

  const meta: BackupMeta = {
    id,
    kind: "mikrotik-export",
    createdAt: new Date().toISOString(),
    status: "success",
    finishedAt: new Date().toISOString(),
    filename,
    absolutePath: outPath,
    sizeBytes: st.size,
    details: { host },
  };
  await appendIndex(meta);
  return meta;
}

export async function listBackups(req: Request, res: Response) {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50) || 50));
  await reconcileRunningJobs();
  const entries = await loadIndex();
  sendResponse(res, true, 200, "Backups fetched", { backups: entries.slice(0, limit) });
}

export async function downloadBackup(req: Request, res: Response) {
  const id = String(req.params.id || "").trim();
  if (!id) return sendResponse(res, false, 400, "id is required");

  const entries = await loadIndex();
  const meta = entries.find((e) => e.id === id);
  if (!meta) return sendResponse(res, false, 404, "Backup not found");

  try {
    await fsp.access(meta.absolutePath);
  } catch {
    return sendResponse(res, false, 404, "Backup file missing on disk");
  }

  res.download(meta.absolutePath, meta.filename);
}

export async function runDbBackup(req: Request, res: Response) {
  try {
    const meta = await startDbBackupJob();
    sendResponse(res, true, 202, "DB backup started", meta);
  } catch (e: any) {
    sendResponse(res, false, 500, e?.message || "DB backup failed");
  }
}

export async function runMikrotikBackup(req: Request, res: Response) {
  try {
    const host = String(req.body?.host ?? process.env.MIKROTIK_IP ?? "").trim();
    if (!host) return sendResponse(res, false, 400, "host is required (or set MIKROTIK_IP)");
    const meta = await createMikrotikBackup(host);
    sendResponse(res, true, 201, "MikroTik backup created", meta);
  } catch (e: any) {
    sendResponse(res, false, 500, e?.message || "MikroTik backup failed");
  }
}

export async function cleanupOldBackups(): Promise<void> {
  const daysRaw = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 14;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const dir = await ensureBackupDir();
  const entries = await loadIndex();
  const keep: BackupMeta[] = [];

  for (const e of entries) {
    const created = Date.parse(e.createdAt);
    if (!Number.isFinite(created) || created >= cutoff) {
      keep.push(e);
      continue;
    }
    try {
      await fsp.unlink(e.absolutePath);
    } catch {}
  }

  await saveIndex(keep);

  // Best-effort: remove stray files (leave index.json)
  try {
    const files = await fsp.readdir(dir);
    for (const f of files) {
      if (f === "index.json") continue;
      const full = path.join(dir, f);
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs < cutoff) {
        await fsp.unlink(full).catch(() => null);
      }
    }
  } catch {}
}

