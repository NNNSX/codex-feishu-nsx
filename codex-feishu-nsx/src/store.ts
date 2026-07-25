/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.codex-feishu-nsx/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
  BridgeJobAttachment,
  BridgeJobRecord,
  BridgeJobState,
} from 'codex-feishu-nsx-core/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType, InboundMessage } from 'codex-feishu-nsx-core/src/lib/bridge/types.js';
import { CFN_HOME } from './config.js';

const DATA_DIR = path.join(CFN_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const JOB_FILES_DIR = path.join(DATA_DIR, 'job-files');

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string | Buffer): void {
  // A unique temporary path prevents concurrent writers from sharing the
  // same .tmp file. fsync makes the rename durable across a sudden restart.
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filePath);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error(`Persistent bridge data is unreadable: ${filePath}`, { cause: error });
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

type PersistedInboundMessage = Omit<InboundMessage, 'attachments'> & {
  attachments?: BridgeJobAttachment[];
};

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private jobs = new Map<string, BridgeJobRecord>();
  private inbox = new Map<string, PersistedInboundMessage>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    ensureDir(JOB_FILES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);

    // Durable bridge jobs
    const jobs = readJson<Record<string, BridgeJobRecord>>(
      path.join(DATA_DIR, 'jobs.json'),
      {},
    );
    for (const [id, job] of Object.entries(jobs)) {
      this.jobs.set(id, job);
    }

    const inbox = readJson<Record<string, PersistedInboundMessage>>(
      path.join(DATA_DIR, 'inbox.json'),
      {},
    );
    for (const [id, message] of Object.entries(inbox)) {
      this.inbox.set(id, message);
    }
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistJobs(): void {
    writeJson(path.join(DATA_DIR, 'jobs.json'), Object.fromEntries(this.jobs));
  }

  private persistInbox(): void {
    writeJson(path.join(DATA_DIR, 'inbox.json'), Object.fromEntries(this.inbox));
  }

  private persistJobAttachments(jobId: string, attachments: BridgeJobAttachment[]): BridgeJobAttachment[] {
    if (attachments.length === 0) return [];
    const jobDir = path.join(
      JOB_FILES_DIR,
      crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 24),
    );
    ensureDir(jobDir);

    return attachments.map((attachment) => {
      if (!attachment.data) return { ...attachment };
      const safeName = path.basename(attachment.name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment.bin';
      const fileName = `${crypto.createHash('sha256').update(attachment.id).digest('hex').slice(0, 16)}-${safeName}`;
      const filePath = path.join(jobDir, fileName);
      if (!fs.existsSync(filePath)) {
        atomicWrite(filePath, Buffer.from(attachment.data, 'base64'));
      }
      return { ...attachment, data: undefined, filePath };
    });
  }

  private normalizeJob(job: BridgeJobRecord): BridgeJobRecord {
    return {
      ...job,
      inputAttachments: this.persistJobAttachments(job.id, job.inputAttachments || []),
      outputAttachments: this.persistJobAttachments(job.id, job.outputAttachments || []),
    };
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    if (data.channelType !== 'feishu') {
      throw new Error(`Unsupported channel type: ${data.channelType}`);
    }
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        codepilotSessionId: data.codepilotSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (this.settings.get('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        this.bindings.set(key, { ...b, ...updates, updatedAt: now() });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Store sdkSessionId on the session object
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
      createdAt: link.createdAt || now(),
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  prunePermissionLinks(beforeIso: string): number {
    let removed = 0;
    for (const [id, link] of this.permissionLinks) {
      if (link.resolved && (link.createdAt || '') < beforeIso) {
        this.permissionLinks.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.persistPermissions();
    return removed;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }

  // ── Durable task ledger ──

  getBridgeJob(id: string): BridgeJobRecord | null {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  upsertBridgeJob(job: BridgeJobRecord): BridgeJobRecord {
    const normalized = this.normalizeJob(job);
    this.jobs.set(job.id, normalized);
    this.persistJobs();
    return structuredClone(normalized);
  }

  updateBridgeJob(id: string, updates: Partial<BridgeJobRecord>): BridgeJobRecord | null {
    const existing = this.jobs.get(id);
    if (!existing) return null;
    const updated = this.normalizeJob({
      ...existing,
      ...updates,
      id,
      updatedAt: updates.updatedAt || now(),
    });
    this.jobs.set(id, updated);
    this.persistJobs();
    return structuredClone(updated);
  }

  listBridgeJobs(states?: BridgeJobState[]): BridgeJobRecord[] {
    const allowed = states ? new Set(states) : null;
    return Array.from(this.jobs.values())
      .filter((job) => !allowed || allowed.has(job.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((job) => structuredClone(job));
  }

  pruneBridgeJobs(beforeIso: string): number {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.state === 'delivered' && job.updatedAt < beforeIso) {
        this.jobs.delete(id);
        const jobDir = path.join(
          JOB_FILES_DIR,
          crypto.createHash('sha256').update(id).digest('hex').slice(0, 24),
        );
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* best effort */ }
        removed++;
      }
    }
    if (removed > 0) this.persistJobs();
    return removed;
  }

  // ── Durable inbound queue ──

  enqueueInboundMessage(message: InboundMessage): boolean {
    if (this.inbox.has(message.messageId)) return false;
    const attachments = this.persistJobAttachments(message.messageId, message.attachments || []);
    this.inbox.set(message.messageId, { ...message, attachments });
    this.persistInbox();
    return true;
  }

  listInboundMessages(channelType?: ChannelType): InboundMessage[] {
    const messages: InboundMessage[] = [];
    for (const message of this.inbox.values()) {
      if (channelType && message.address.channelType !== channelType) continue;
      const attachments = (message.attachments || []).flatMap((attachment) => {
        try {
          const data = attachment.data || (attachment.filePath
            ? fs.readFileSync(attachment.filePath).toString('base64')
            : '');
          return data ? [{ ...attachment, data }] : [];
        } catch {
          return [];
        }
      });
      messages.push({
        ...message,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    }
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  removeInboundMessage(messageId: string): void {
    if (!this.inbox.delete(messageId)) return;
    this.persistInbox();
  }
}
