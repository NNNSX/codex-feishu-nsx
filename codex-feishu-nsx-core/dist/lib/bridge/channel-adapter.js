/**
 * Abstract base class for the Feishu channel adapter.
 *
 * Feishu extends this class to provide message consumption and delivery.
 */
export class BaseChannelAdapter {
    /**
     * Answer an interactive card callback.
     */
    async answerCallback(_callbackQueryId, _text) {
        // No-op by default; override in adapters that support callback queries
    }
}
// ── Adapter Registry ────────────────────────────────────────────
const adapterFactories = new Map();
export function registerAdapterFactory(channelType, factory) {
    adapterFactories.set(channelType, factory);
}
export function createAdapter(channelType) {
    const factory = adapterFactories.get(channelType);
    return factory ? factory() : null;
}
export function getRegisteredTypes() {
    return Array.from(adapterFactories.keys());
}
//# sourceMappingURL=channel-adapter.js.map