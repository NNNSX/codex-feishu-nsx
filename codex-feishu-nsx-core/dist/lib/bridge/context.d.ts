/**
 * Bridge Context — dependency injection container for host interfaces.
 *
 * All bridge modules access host services through this context instead
 * of importing directly from the host application.
 *
 * The host initializes the context once at startup via `initBridgeContext()`.
 * Bridge modules access it via `getBridgeContext()`.
 */
import type { BridgeStore, LLMProvider, PermissionGateway, LifecycleHooks } from './host.js';
export interface BridgeContext {
    store: BridgeStore;
    llm: LLMProvider;
    permissions: PermissionGateway;
    lifecycle: LifecycleHooks;
}
/**
 * Initialize the bridge context with host-provided implementations.
 * Must be called once before any bridge module is used.
 */
export declare function initBridgeContext(ctx: BridgeContext): void;
/**
 * Get the current bridge context.
 * Throws if the context has not been initialized.
 */
export declare function getBridgeContext(): BridgeContext;
/**
 * Check whether the bridge context has been initialized.
 */
export declare function hasBridgeContext(): boolean;
//# sourceMappingURL=context.d.ts.map