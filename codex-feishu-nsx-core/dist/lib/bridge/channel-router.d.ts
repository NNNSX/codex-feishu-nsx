/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */
import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export declare function resolve(address: ChannelAddress): ChannelBinding;
/**
 * Create a new binding with a fresh CodePilot session.
 */
export declare function createBinding(address: ChannelAddress, workingDirectory?: string): ChannelBinding;
/**
 * Bind an IM chat to an existing CodePilot session.
 */
export declare function bindToSession(address: ChannelAddress, codepilotSessionId: string): ChannelBinding | null;
/**
 * Update properties of an existing binding.
 */
export declare function updateBinding(id: string, updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>): void;
/**
 * List all bindings, optionally filtered by channel type.
 */
export declare function listBindings(channelType?: ChannelType): ChannelBinding[];
//# sourceMappingURL=channel-router.d.ts.map