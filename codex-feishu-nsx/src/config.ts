import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: 'code' | 'plan' | 'ask';
  attachmentRetentionDays?: number;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
}

export const CFN_HOME = process.env.CFN_HOME || path.join(os.homedir(), '.codex-feishu-nsx');
export const CONFIG_PATH = path.join(CFN_HOME, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function applyRuntimeEnv(env: Map<string, string>): void {
  for (const [key, value] of env) {
    if (key.startsWith('CFN_') || key === 'CODEX_API_KEY' || key === 'OPENAI_API_KEY') {
      process.env[key] = value;
    }
  }
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    env = parseEnvFile(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    // Required fields are reported through adapter validation.
  }
  applyRuntimeEnv(env);

  const rawMode = env.get('CFN_DEFAULT_MODE') || 'code';
  const defaultMode = (['code', 'plan', 'ask'].includes(rawMode) ? rawMode : 'code') as Config['defaultMode'];

  return {
    defaultWorkDir: env.get('CFN_DEFAULT_WORKDIR') || process.cwd(),
    defaultModel: env.get('CFN_DEFAULT_MODEL') || undefined,
    defaultMode,
    attachmentRetentionDays: env.get('CFN_ATTACHMENT_RETENTION_DAYS') != null
      ? Number(env.get('CFN_ATTACHMENT_RETENTION_DAYS'))
      : undefined,
    feishuAppId: env.get('CFN_FEISHU_APP_ID') || undefined,
    feishuAppSecret: env.get('CFN_FEISHU_APP_SECRET') || undefined,
    feishuDomain: env.get('CFN_FEISHU_DOMAIN') || undefined,
    feishuAllowedUsers: splitCsv(env.get('CFN_FEISHU_ALLOWED_USERS')),
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = '';
  out += formatEnvLine('CFN_DEFAULT_WORKDIR', config.defaultWorkDir);
  out += formatEnvLine('CFN_DEFAULT_MODEL', config.defaultModel);
  out += formatEnvLine('CFN_DEFAULT_MODE', config.defaultMode);
  if (config.attachmentRetentionDays !== undefined) {
    out += formatEnvLine('CFN_ATTACHMENT_RETENTION_DAYS', String(config.attachmentRetentionDays));
  }
  out += formatEnvLine('CFN_FEISHU_APP_ID', config.feishuAppId);
  out += formatEnvLine('CFN_FEISHU_APP_SECRET', config.feishuAppSecret);
  out += formatEnvLine('CFN_FEISHU_DOMAIN', config.feishuDomain);
  out += formatEnvLine('CFN_FEISHU_ALLOWED_USERS', config.feishuAllowedUsers?.join(','));

  fs.mkdirSync(CFN_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
  // Windows ignores POSIX modes; on Unix this also repairs permissions when
  // an existing config file was created with broader access.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort */ }
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const settings = new Map<string, string>();
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_feishu_enabled', 'true');
  if (config.feishuAppId) settings.set('bridge_feishu_app_id', config.feishuAppId);
  if (config.feishuAppSecret) settings.set('bridge_feishu_app_secret', config.feishuAppSecret);
  if (config.feishuDomain) settings.set('bridge_feishu_domain', config.feishuDomain);
  if (config.feishuAllowedUsers) settings.set('bridge_feishu_allowed_users', config.feishuAllowedUsers.join(','));
  settings.set('bridge_default_work_dir', config.defaultWorkDir);
  if (config.defaultModel) {
    settings.set('bridge_default_model', config.defaultModel);
    settings.set('default_model', config.defaultModel);
  }
  settings.set('bridge_default_mode', config.defaultMode);
  if (config.attachmentRetentionDays !== undefined) {
    settings.set('bridge_attachment_retention_days', String(config.attachmentRetentionDays));
  }
  return settings;
}
