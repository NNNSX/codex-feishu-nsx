/**
 * Bridge Manager — singleton orchestrator for the Feishu bridge.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import type { BridgeJobAttachment, BridgeJobRecord } from './host.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverAttachments } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  feishu: { intervalMs: 900, minDeltaChars: 30, maxChars: 29000 },
};

function getStreamConfig(channelType = 'feishu'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.feishu;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * Feishu chats with at least one pending permission.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Deliver response text as Feishu markdown.
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  jobId?: string,
): Promise<SendResult> {
  const deliveryId = jobId
    ? crypto.createHash('sha256').update(`response:${jobId}`).digest('hex')
    : undefined;
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'Markdown',
    replyToMessageId,
    idempotencyKey: deliveryId?.slice(0, 40),
  }, { sessionId, dedupKey: deliveryId ? `response:${deliveryId}` : undefined });
}

const DELIVERY_RETRY_INTERVAL_MS = 30_000;
const DELIVERY_RETRY_MAX_DELAY_MS = 5 * 60_000;

function restoreAttachments(attachments: BridgeJobAttachment[]): import('./host.js').FileAttachment[] {
  const restored: import('./host.js').FileAttachment[] = [];
  for (const attachment of attachments) {
    try {
      const data = attachment.data || (attachment.filePath
        ? fs.readFileSync(attachment.filePath).toString('base64')
        : '');
      if (!data) continue;
      restored.push({ ...attachment, data });
    } catch (error) {
      console.warn(`[bridge-manager] Unable to restore attachment ${attachment.name}:`, error instanceof Error ? error.message : error);
    }
  }
  return restored;
}

function nextDeliveryAttempt(attempt: number): string {
  const delay = Math.min(5_000 * Math.pow(2, Math.max(0, attempt - 1)), DELIVERY_RETRY_MAX_DELAY_MS);
  return new Date(Date.now() + delay).toISOString();
}

async function deliverBridgeJob(adapter: BaseChannelAdapter, job: BridgeJobRecord): Promise<boolean> {
  const { store } = getBridgeContext();
  const managerState = getState();
  if (!store.updateBridgeJob) return false;
  if (managerState.deliveryInFlight.has(job.id)) return false;
  if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now()) return false;

  managerState.deliveryInFlight.add(job.id);
  try {

  const attempts = job.deliveryAttempts + 1;
  let current = store.updateBridgeJob(job.id, {
    state: 'delivering',
    deliveryAttempts: attempts,
    nextAttemptAt: undefined,
  }) || job;
  const address = {
    channelType: current.channelType,
    chatId: current.chatId,
    userId: current.userId,
  };
  let error = '';

  if (!current.textDelivered) {
    if (current.responseText) {
      const result = await deliverResponse(
        adapter,
        address,
        current.responseText,
        current.sessionId,
        current.replyToMessageId,
        current.id,
      );
      if (result.ok) {
        current = store.updateBridgeJob(current.id, { textDelivered: true }) || current;
      } else {
        error = result.error || 'response delivery failed';
      }
    } else {
      current = store.updateBridgeJob(current.id, { textDelivered: true }) || current;
    }
  }

  if (!error && !current.attachmentsDelivered) {
    const attachments = restoreAttachments(current.outputAttachments);
    if (attachments.length !== current.outputAttachments.length) {
      error = 'one or more generated files are no longer available';
    } else if (attachments.length > 0) {
      const result = await deliverAttachments(adapter, {
        address,
        parseMode: 'plain',
        replyToMessageId: current.replyToMessageId,
        attachments,
      }, { sessionId: current.sessionId });
      if (result.ok) {
        current = store.updateBridgeJob(current.id, { attachmentsDelivered: true }) || current;
      } else {
        error = result.error || 'attachment delivery failed';
      }
    } else {
      current = store.updateBridgeJob(current.id, { attachmentsDelivered: true }) || current;
    }
  }

  if (!error && current.textDelivered && current.attachmentsDelivered) {
    store.updateBridgeJob(current.id, {
      state: 'delivered',
      errorMessage: current.hasError ? current.errorMessage : '',
      deliveryError: '',
      nextAttemptAt: undefined,
    });
    return true;
  }

  store.updateBridgeJob(current.id, {
    state: 'codex_completed',
    deliveryError: error,
    nextAttemptAt: nextDeliveryAttempt(attempts),
  });
  console.warn(`[bridge-manager] Delivery queued for retry (job ${current.id}): ${error}`);
  return false;
  } finally {
    managerState.deliveryInFlight.delete(job.id);
  }
}

function markStartupJobsInterrupted(): void {
  const { store } = getBridgeContext();
  if (!store.listBridgeJobs || !store.updateBridgeJob) return;

  for (const job of store.listBridgeJobs(['received', 'running'])) {
    store.updateBridgeJob(job.id, {
      state: 'interrupted',
      errorMessage: 'Bridge stopped before the Codex task completed.',
    });
    for (const permission of store.listPendingPermissionLinksByChat(job.chatId)) {
      store.markPermissionLinkResolved(permission.permissionRequestId);
    }
  }
}

async function reconcileBridgeJobs(adapter: BaseChannelAdapter): Promise<void> {
  const { store } = getBridgeContext();
  if (!store.listBridgeJobs || !store.updateBridgeJob) return;

  for (const job of store.listBridgeJobs()) {
    if (!job.streamingCardId || job.streamingCardFinalized || ['received', 'running'].includes(job.state)) continue;
    try { await adapter.finalizeRecoveredTask?.(job); } catch (error) {
      console.warn(`[bridge-manager] Unable to finalize recovered card for job ${job.id}:`, error instanceof Error ? error.message : error);
    }
  }

  for (const job of store.listBridgeJobs(['codex_completed', 'delivering'])) {
    try { await deliverBridgeJob(adapter, job); } catch (error) {
      console.warn(`[bridge-manager] Recovery delivery failed for job ${job.id}:`, error instanceof Error ? error.message : error);
    }
  }

  for (const job of store.listBridgeJobs(['interrupted', 'failed'])) {
    if (job.recoveryNoticeDelivered) continue;
    const result = await deliver(adapter, {
      address: { channelType: job.channelType, chatId: job.chatId, userId: job.userId },
      text: `Task ${job.id} was interrupted before completion. It was not rerun automatically to avoid repeating side effects. Send /retry ${job.id} to run it again.`,
      parseMode: 'plain',
      replyToMessageId: job.replyToMessageId,
      idempotencyKey: crypto.createHash('sha256').update(`interrupted:${job.id}`).digest('hex').slice(0, 40),
    }, { dedupKey: `interrupted:${job.id}` });
    if (result.ok) store.updateBridgeJob(job.id, { recoveryNoticeDelivered: true });
  }
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  recoveryTimers: Map<string, ReturnType<typeof setInterval>>;
  deliveryInFlight: Set<string>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      recoveryTimers: new Map(),
      deliveryInFlight: new Set(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  if (!g[GLOBAL_KEY].recoveryTimers) {
    g[GLOBAL_KEY].recoveryTimers = new Map();
  }
  if (!g[GLOBAL_KEY].deliveryInFlight) {
    g[GLOBAL_KEY].deliveryInFlight = new Set();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  markStartupJobsInterrupted();
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
      void reconcileBridgeJobs(adapter);
      const timer = setInterval(() => { void reconcileBridgeJobs(adapter); }, DELIVERY_RETRY_INTERVAL_MS);
      timer.unref();
      state.recoveryTimers.set(adapter.channelType, timer);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  for (const timer of state.recoveryTimers.values()) clearInterval(timer);
  state.recoveryTimers.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      const health = adapter.getConnectionHealth?.();
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: health?.error ?? meta?.lastError ?? null,
        connectionState: health?.state,
        reconnectAttempts: health?.reconnectAttempts,
        lastConnectionChangeAt: health?.lastConnectionChangeAt,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for Feishu MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    try { store.removeInboundMessage?.(msg.messageId); } catch { /* best effort */ }
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    // Always acknowledge the callback. After a restart the native Codex
    // approval is gone; make that state explicit instead of silently dropping
    // the user's button press.
    const confirmMsg: OutboundMessage = {
      address: msg.address,
      text: handled
        ? 'Permission response recorded.'
        : 'Permission request is no longer active. Please rerun the task.',
      parseMode: 'plain',
      replyToMessageId: msg.callbackMessageId || msg.messageId,
    };
    await deliver(adapter, confirmMsg, {
      dedupKey: `permission-confirm:${msg.messageId}`,
    });
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // The Feishu message ID is the durable idempotency key. A replay after a
  // reconnect or process restart must not execute the same Codex task twice.
  const existingJob = store.getBridgeJob?.(msg.messageId);
  if (existingJob) {
    console.log(`[bridge-manager] Duplicate inbound message skipped (job ${msg.messageId}, state ${existingJob.state})`);
    ack();
    return;
  }

  const createdAt = new Date().toISOString();
  let durableJob = store.upsertBridgeJob?.({
    id: msg.messageId,
    channelType: msg.address.channelType,
    chatId: msg.address.chatId,
    userId: msg.address.userId,
    sessionId: binding.codepilotSessionId,
    requestText: text,
    replyToMessageId: msg.messageId,
    inputAttachments: msg.attachments || [],
    state: 'received',
    responseText: '',
    outputAttachments: [],
    hasError: false,
    errorMessage: '',
    textDelivered: false,
    attachmentsDelivered: false,
    deliveryAttempts: 0,
    recoveryNoticeDelivered: false,
    createdAt,
    updatedAt: createdAt,
  });
  if (durableJob) {
    durableJob = store.updateBridgeJob?.(durableJob.id, { state: 'running' }) || durableJob;
  }

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId, msg.messageId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or a minimal prompt for attachment-only messages.
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    const deliveryText = result.responseText || (result.hasError
      ? `**Error:** ${result.errorMessage}`
      : '');
    if (durableJob && store.updateBridgeJob) {
      durableJob = store.updateBridgeJob(durableJob.id, {
        state: 'codex_completed',
        responseText: deliveryText,
        outputAttachments: result.attachments,
        hasError: result.hasError,
        errorMessage: result.errorMessage,
        textDelivered: false,
        attachmentsDelivered: result.attachments.length === 0,
      }) || durableJob;
    }

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
        if (cardFinalized && durableJob && store.updateBridgeJob) {
          durableJob = store.updateBridgeJob(durableJob.id, { textDelivered: true }) || durableJob;
        }
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    if (durableJob) {
      await deliverBridgeJob(adapter, durableJob);
    } else {
      // Compatibility path for hosts that have not implemented the durable ledger.
      if (result.responseText && !cardFinalized) {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      } else if (!result.responseText && result.hasError) {
        await deliver(adapter, {
          address: msg.address,
          text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        });
      }
      if (result.attachments.length > 0) {
        await deliverAttachments(adapter, {
          address: msg.address,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
          attachments: result.attachments,
        }, { sessionId: binding.codepilotSessionId });
      }
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bridge-manager] Task ${msg.messageId} failed:`, error);
    if (durableJob && store.updateBridgeJob) {
      store.updateBridgeJob(durableJob.id, {
        state: taskAbort.signal.aborted ? 'interrupted' : 'failed',
        errorMessage: message,
      });
    }
    if (hasStreamingCards && adapter.onStreamEnd) {
      try { await adapter.onStreamEnd(msg.address.chatId, taskAbort.signal.aborted ? 'interrupted' : 'error', ''); } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>Codex Feishu Bridge</b>',
        '',
        'Send any message to interact with Codex.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status [task_id] - Show bridge or task status',
        '/retry last|&lt;task_id&gt; - Retry an interrupted task',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      if (args && store.getBridgeJob) {
        const job = store.getBridgeJob(args);
        if (!job || job.chatId !== msg.address.chatId) {
          response = 'Task not found in this chat.';
          break;
        }
        response = [
          '<b>Task Status</b>',
          '',
          `Task: <code>${escapeHtml(job.id)}</code>`,
          `State: <b>${job.state}</b>`,
          `Delivery attempts: ${job.deliveryAttempts}`,
          job.errorMessage ? `Last error: ${escapeHtml(job.errorMessage)}` : '',
          job.deliveryError ? `Delivery error: ${escapeHtml(job.deliveryError)}` : '',
        ].filter(Boolean).join('\n');
        break;
      }
      const latestJob = store.listBridgeJobs?.()
        .find((job) => job.chatId === msg.address.chatId);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        latestJob ? `Latest task: <b>${latestJob.state}</b> (<code>${escapeHtml(latestJob.id)}</code>)` : '',
      ].filter(Boolean).join('\n');
      break;
    }

    case '/retry': {
      if (!store.listBridgeJobs || !store.getBridgeJob) {
        response = 'Durable task recovery is not available in this installation.';
        break;
      }
      const candidate = !args || args.toLowerCase() === 'last'
        ? store.listBridgeJobs(['interrupted', 'failed']).find((job) => job.chatId === msg.address.chatId)
        : store.getBridgeJob(args);
      if (!candidate || candidate.chatId !== msg.address.chatId) {
        response = 'No matching interrupted task was found in this chat.';
        break;
      }
      if (!['interrupted', 'failed'].includes(candidate.state)) {
        response = `Task cannot be retried from state <b>${candidate.state}</b>.`;
        break;
      }
      const attachments = restoreAttachments(candidate.inputAttachments);
      if (attachments.length !== candidate.inputAttachments.length) {
        response = 'Retry is unavailable because one or more original attachments are missing.';
        break;
      }
      const retryMessage: InboundMessage = {
        messageId: `retry:${msg.messageId}`,
        address: msg.address,
        text: candidate.requestText,
        timestamp: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      const currentBinding = router.resolve(msg.address);
      setTimeout(() => {
        processWithSessionLock(currentBinding.codepilotSessionId, () => handleMessage(adapter, retryMessage))
          .catch((error) => console.error('[bridge-manager] Retried task failed:', error));
      }, 0);
      response = `Retry queued as task <code>${escapeHtml(retryMessage.messageId)}</code>.`;
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>Codex Feishu Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status [task_id] - Show bridge or task status',
        '/retry last|&lt;task_id&gt; - Retry an interrupted task',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (single pending request)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage, deliverBridgeJob, markStartupJobsInterrupted, reconcileBridgeJobs };
