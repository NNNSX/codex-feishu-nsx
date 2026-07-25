/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeJobRecord, BridgeStore, LifecycleHooks } from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });

  it('maps adapter transport health into bridge status', async () => {
    const manager = await import('../../lib/bridge/bridge-manager');
    manager.registerAdapter({
      channelType: 'feishu',
      isRunning: () => true,
      getConnectionHealth: () => ({
        state: 'connected',
        reconnectAttempts: 2,
        lastConnectionChangeAt: '2026-01-01T00:00:00.000Z',
        error: null,
      }),
    } as unknown as BaseChannelAdapter);

    const adapter = manager.getStatus().adapters[0];
    assert.equal(adapter.connectionState, 'connected');
    assert.equal(adapter.reconnectAttempts, 2);
    assert.equal(adapter.lastConnectionChangeAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('bridge-manager durable recovery', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('keeps failed delivery pending and completes it after the channel recovers', async () => {
    const timestamp = new Date().toISOString();
    let job: BridgeJobRecord = {
      id: 'om-recovery-test',
      channelType: 'feishu',
      chatId: 'oc-recovery-test',
      sessionId: 'session-recovery-test',
      requestText: 'hello',
      replyToMessageId: 'om-recovery-test',
      inputAttachments: [],
      state: 'codex_completed',
      responseText: 'completed response',
      outputAttachments: [],
      hasError: false,
      errorMessage: '',
      textDelivered: false,
      attachmentsDelivered: true,
      deliveryAttempts: 0,
      recoveryNoticeDelivered: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const store = createMinimalStore() as BridgeStore;
    store.getBridgeJob = () => structuredClone(job);
    store.updateBridgeJob = (_id, updates) => {
      job = { ...job, ...updates, updatedAt: new Date().toISOString() };
      return structuredClone(job);
    };
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    let channelAvailable = false;
    const adapter = {
      channelType: 'feishu',
      send: async () => channelAvailable
        ? { ok: true, messageId: 'om-delivered' }
        : { ok: false, error: 'invalid request', httpStatus: 400 },
    } as unknown as BaseChannelAdapter;
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    assert.equal(await _testOnly.deliverBridgeJob(adapter, job), false);
    assert.equal(job.state, 'codex_completed');
    assert.equal(job.deliveryAttempts, 1);
    assert.ok(job.nextAttemptAt);

    channelAvailable = true;
    job.nextAttemptAt = undefined;
    assert.equal(await _testOnly.deliverBridgeJob(adapter, job), true);
    assert.equal(job.state, 'delivered');
    assert.equal(job.textDelivered, true);
  });

  it('marks in-flight work interrupted instead of rerunning it at startup', async () => {
    const timestamp = new Date().toISOString();
    let job = {
      id: 'om-running-test',
      channelType: 'feishu' as const,
      chatId: 'oc-running-test',
      sessionId: 'session-running-test',
      requestText: 'change a file',
      inputAttachments: [],
      state: 'running' as const,
      responseText: '',
      outputAttachments: [],
      hasError: false,
      errorMessage: '',
      textDelivered: false,
      attachmentsDelivered: false,
      deliveryAttempts: 0,
      recoveryNoticeDelivered: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies BridgeJobRecord;
    const store = createMinimalStore() as BridgeStore;
    store.listBridgeJobs = (states) => states?.includes(job.state) ? [structuredClone(job)] : [];
    store.updateBridgeJob = (_id, updates) => {
      job = { ...job, ...updates, updatedAt: new Date().toISOString() } as typeof job;
      return structuredClone(job);
    };
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = {
      channelType: 'feishu',
      send: async () => ({ ok: true, messageId: 'om-notice' }),
    } as unknown as BaseChannelAdapter;
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    _testOnly.markStartupJobsInterrupted();
    await _testOnly.reconcileBridgeJobs(adapter);
    assert.equal(job.state, 'interrupted');
    assert.equal(job.recoveryNoticeDelivered, true);
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}
