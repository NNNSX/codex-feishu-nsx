/**
 * Permission Broker — forwards provider permission requests to Feishu
 * and handles user responses via inline buttons.
 *
 * When the provider needs tool approval, the broker:
 * 1. Formats a permission prompt with inline keyboard buttons
 * 2. Sends it via the delivery layer
 * 3. Records the link between permission ID and IM message
 * 4. When a callback arrives, resolves the permission via the gateway
 */
import type { ChannelAddress } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
/**
 * Forward a permission request to Feishu as an interactive message.
 */
export declare function forwardPermissionRequest(adapter: BaseChannelAdapter, address: ChannelAddress, permissionRequestId: string, toolName: string, toolInput: Record<string, unknown>, sessionId?: string, suggestions?: unknown[], replyToMessageId?: string): Promise<void>;
/**
 * Handle a permission callback from an inline button press.
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled.
 */
export declare function handlePermissionCallback(callbackData: string, callbackChatId: string, callbackMessageId?: string): boolean;
//# sourceMappingURL=permission-broker.d.ts.map