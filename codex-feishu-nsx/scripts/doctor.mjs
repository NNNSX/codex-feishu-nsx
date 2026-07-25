import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataHome = process.env.CFN_HOME || path.join(os.homedir(), '.codex-feishu-nsx');
const configFile = path.join(dataHome, 'config.env');
const bundleFile = path.join(skillDir, 'dist', 'daemon.mjs');
const pidFile = path.join(dataHome, 'runtime', 'bridge.pid');
const statusFile = path.join(dataHome, 'runtime', 'status.json');
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

function parseConfig(file) {
  const result = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+)=(.*)$/);
    if (match) result.set(match[1].trim(), match[2].trim());
  }
  return result;
}

check('Node.js available', Number(process.versions.node.split('.')[0]) >= 20, process.version);
check('Configuration exists', fs.existsSync(configFile), configFile);
if (fs.existsSync(configFile)) {
  const config = parseConfig(configFile);
  check('Feishu App ID configured', Boolean(config.get('CFN_FEISHU_APP_ID')));
  check('Feishu App Secret configured', Boolean(config.get('CFN_FEISHU_APP_SECRET')));
  check('No legacy Claude configuration', ![...config.keys()].some((key) => /^(CTI_|ANTHROPIC_)/.test(key)));
}
check('Codex SDK installed', fs.existsSync(path.join(skillDir, 'node_modules', '@openai', 'codex-sdk')));
check('Daemon bundle built', fs.existsSync(bundleFile), bundleFile);

if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  let running = false;
  try { process.kill(pid, 0); running = true; } catch { /* not running */ }
  check('Bridge process running', running, `PID ${pid}`);
  if (fs.existsSync(statusFile)) {
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      check('Bridge status reports running', status.running === true);
      check('Feishu adapter running', status.adapterRunning !== false);
      if (status.adapterConnectionState) {
        check('Feishu WebSocket connected', status.adapterConnectionState === 'connected', status.adapterConnectionState);
      }
      if (status.adapterLastError) {
        check('Feishu adapter has no transport error', false, status.adapterLastError);
      }
      const healthAt = Date.parse(status.lastHealthCheckAt || status.startedAt || '');
      if (Number.isFinite(healthAt)) {
        check('Bridge health is fresh', Date.now() - healthAt < 120_000, new Date(healthAt).toISOString());
      }
      try {
        const entries = fs.readdirSync(path.join(dataHome, 'data'), { recursive: true, withFileTypes: true });
        let bytes = 0;
        for (const entry of entries) {
          if (entry.isFile()) {
            try { bytes += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size; } catch { /* best effort */ }
          }
        }
        check('Bridge data usage below 1 GB', bytes < 1024 ** 3, `${(bytes / 1024 / 1024).toFixed(1)} MB`);
      } catch { /* optional diagnostic */ }
    } catch (error) {
      check('Status file is valid JSON', false, error instanceof Error ? error.message : String(error));
    }
  }
} else {
  console.log('[INFO] Bridge is not running');
}

if (failures > 0) {
  console.error(`Diagnostics found ${failures} issue(s).`);
  process.exit(1);
}
console.log('Diagnostics passed.');
