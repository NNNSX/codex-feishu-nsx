/**
 * Bridge Manager — singleton orchestrator for the Feishu bridge.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */
import type { BridgeStatus, InboundMessage } from './types.js';
import type { BridgeJobRecord } from './host.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import './adapters/index.js';
declare function deliverBridgeJob(adapter: BaseChannelAdapter, job: BridgeJobRecord): Promise<boolean>;
declare function markStartupJobsInterrupted(): void;
declare function reconcileBridgeJobs(adapter: BaseChannelAdapter): Promise<void>;
/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export declare function start(): Promise<void>;
/**
 * Stop the bridge system gracefully.
 */
export declare function stop(): Promise<void>;
/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export declare function tryAutoStart(): void;
/**
 * Get the current bridge status.
 */
export declare function getStatus(): BridgeStatus;
/**
 * Register a channel adapter.
 */
export declare function registerAdapter(adapter: BaseChannelAdapter): void;
/**
 * Handle a single inbound message.
 */
declare function handleMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void>;
/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export declare function computeSdkSessionUpdate(sdkSessionId: string | null | undefined, hasError: boolean): string | null;
/** @internal */
export declare const _testOnly: {
    handleMessage: typeof handleMessage;
    deliverBridgeJob: typeof deliverBridgeJob;
    markStartupJobsInterrupted: typeof markStartupJobsInterrupted;
    reconcileBridgeJobs: typeof reconcileBridgeJobs;
};
export {};
//# sourceMappingURL=bridge-manager.d.ts.map