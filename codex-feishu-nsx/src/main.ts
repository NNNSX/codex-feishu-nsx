/** Codex-to-Feishu daemon entry point. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { initBridgeContext } from './core/context.js';
import * as bridgeManager from './core/bridge-manager.js';
import './core/adapters/index.js';

import { CFN_HOME, configToSettings, loadConfig } from './config.js';
import { CodexProvider } from './codex-provider.js';
import { setupLogger } from './logger.js';
import { PendingPermissions } from './permission-gateway.js';
import { JsonFileStore } from './store.js';

const RUNTIME_DIR = path.join(CFN_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
const LOCK_FILE = path.join(RUNTIME_DIR, 'bridge.lock');
let processLockFd: number | null = null;

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channel?: 'feishu';
  runtime?: 'codex';
  adapterRunning?: boolean;
  adapterConnectionState?: string;
  adapterReconnectAttempts?: number;
  adapterLastConnectionChangeAt?: string | null;
  adapterLastError?: string | null;
  lastHealthCheckAt?: string;
  lastExitReason?: string;
}

function acquireProcessLock(runId: string): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      processLockFd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeFileSync(processLockFd, payload, 'utf-8');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error;
      let existingPid = 0;
      try {
        existingPid = Number(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')).pid);
      } catch { /* stale or partially written lock */ }
      let alive = false;
      if (existingPid > 0) {
        try { process.kill(existingPid, 0); alive = true; } catch { /* stale PID */ }
      }
      if (alive) throw new Error(`Another bridge instance is already running (PID ${existingPid})`);
      fs.unlinkSync(LOCK_FILE);
    }
  }
}

function releaseProcessLock(): void {
  if (processLockFd === null) return;
  try { fs.closeSync(processLockFd); } catch { /* best effort */ }
  processLockFd = null;
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already removed */ }
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...existing, ...info }, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();
  const runId = crypto.randomUUID();
  acquireProcessLock(runId);
  console.log(`[codex-feishu-nsx] Starting bridge (run_id: ${runId})`);

  const store = new JsonFileStore(configToSettings(config));
  const retentionDays = config.attachmentRetentionDays ?? 30;
  if (retentionDays > 0) {
    const beforeIso = new Date(Date.now() - Math.min(retentionDays, 3650) * 24 * 60 * 60 * 1000).toISOString();
    const removed = store.pruneBridgeJobs(beforeIso);
    const removedPermissions = store.prunePermissionLinks?.(beforeIso) || 0;
    if (removed > 0) console.log(`[codex-feishu-nsx] Pruned ${removed} delivered recovery job(s)`);
    if (removedPermissions > 0) console.log(`[codex-feishu-nsx] Pruned ${removedPermissions} resolved permission link(s)`);
  }
  const pendingPermissions = new PendingPermissions();
  const llm = new CodexProvider();

  initBridgeContext({
    store,
    llm,
    permissions: {
      resolvePendingPermission: (id, resolution) => pendingPermissions.resolve(id, resolution),
    },
    lifecycle: {
      onBridgeStart: () => {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({ running: true, pid: process.pid, runId, startedAt: new Date().toISOString(), channel: 'feishu', runtime: 'codex' });
        console.log(`[codex-feishu-nsx] Bridge started (PID: ${process.pid}, channel: feishu, runtime: codex)`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[codex-feishu-nsx] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();
  if (!bridgeManager.getStatus().running) {
    throw new Error('Bridge did not start: no Feishu adapter is running');
  }

  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[codex-feishu-nsx] Shutting down (${reason})...`);
    pendingPermissions.denyAll();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    releaseProcessLock();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error('[codex-feishu-nsx] unhandledRejection:', message);
    void shutdown(`unhandledRejection: ${message}`);
  });
  process.on('uncaughtException', (err) => {
    console.error('[codex-feishu-nsx] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    releaseProcessLock();
    process.exit(1);
  });

  setInterval(() => {
    const status = bridgeManager.getStatus();
    const adapter = status.adapters[0];
    writeStatus({
      running: status.running,
      adapterRunning: status.adapters.some((item) => item.running),
      adapterConnectionState: adapter?.connectionState,
      adapterReconnectAttempts: adapter?.reconnectAttempts,
      adapterLastConnectionChangeAt: adapter?.lastConnectionChangeAt,
      adapterLastError: adapter?.error,
      lastHealthCheckAt: new Date().toISOString(),
    });
  }, 30_000);
}

main().catch((err) => {
  console.error('[codex-feishu-nsx] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  releaseProcessLock();
  process.exit(1);
});
