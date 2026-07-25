/**
 * Conversation Engine — processes inbound Feishu messages through Codex.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */
import type { ChannelBinding } from './types.js';
import type { FileAttachment, TokenUsage } from './host.js';
export interface PermissionRequestInfo {
    permissionRequestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    suggestions?: unknown[];
}
/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;
/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;
/**
 * Callback invoked when tool_use or tool_result SSE events arrive.
 * Used by bridge-manager to forward tool progress to adapters for real-time display.
 */
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;
export interface ConversationResult {
    responseText: string;
    attachments: FileAttachment[];
    tokenUsage: TokenUsage | null;
    hasError: boolean;
    errorMessage: string;
    /** Permission request events that were forwarded during streaming */
    permissionRequests: PermissionRequestInfo[];
    /** SDK session ID captured from status/result events, for session resume */
    sdkSessionId: string | null;
}
export declare function collectOutboxAttachments(responseText: string, workingDirectory: string): {
    text: string;
    attachments: FileAttachment[];
    warnings: string[];
};
/**
 * Process an inbound message: send to Codex, consume the response stream,
 * save to DB, and return the result.
 */
export declare function processMessage(binding: ChannelBinding, text: string, onPermissionRequest?: OnPermissionRequest, abortSignal?: AbortSignal, files?: FileAttachment[], onPartialText?: OnPartialText, onToolEvent?: OnToolEvent): Promise<ConversationResult>;
//# sourceMappingURL=conversation-engine.d.ts.map