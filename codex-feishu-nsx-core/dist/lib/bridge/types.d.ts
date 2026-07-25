/**
 * Bridge system types — shared across all bridge modules.
 *
 * The bridge connects Feishu to local Codex sessions.
 */
export type { FileAttachment } from './host.js';
/**
 * The slimmed skill supports Feishu only.
 */
export type ChannelType = 'feishu';
/** Unique address of a user within a channel */
export interface ChannelAddress {
    channelType: ChannelType;
    chatId: string;
    userId?: string;
    displayName?: string;
}
/** Composite key for routing: channelType + chatId */
export interface SessionKey {
    channelType: ChannelType;
    chatId: string;
}
/** Inbound message from an IM channel */
export interface InboundMessage {
    /** Platform-specific message ID (for dedup and reference) */
    messageId: string;
    /** Address of the sender */
    address: ChannelAddress;
    /** Plain text content of the message */
    text: string;
    /** Timestamp of the message (ISO string or unix epoch ms) */
    timestamp: number;
    /** If this is a callback query (inline button press), the callback data */
    callbackData?: string;
    /** For callback queries: the message ID of the original message that triggered the callback */
    callbackMessageId?: string;
    /** Platform-specific raw update object (for adapter-specific handling) */
    raw?: unknown;
    /** Adapter-specific update ID for deferred offset acknowledgement */
    updateId?: number;
    /** File attachments (images, documents) from the IM channel */
    attachments?: import('./host.js').FileAttachment[];
}
/** Outbound message to send to an IM channel */
export interface OutboundMessage {
    /** Target address */
    address: ChannelAddress;
    /** Message text */
    text: string;
    /** Parse mode for the text */
    parseMode?: 'HTML' | 'Markdown' | 'plain';
    /** Inline keyboard buttons */
    inlineButtons?: InlineButton[][];
    /** If replying to a specific message */
    replyToMessageId?: string;
    /** Binary attachments to upload and send through the channel */
    attachments?: import('./host.js').FileAttachment[];
    /** Stable platform idempotency key used to suppress duplicate retries. */
    idempotencyKey?: string;
}
/** Inline keyboard button for permission prompts */
export interface InlineButton {
    text: string;
    callbackData: string;
}
/** Result of sending a message via an adapter */
export interface SendResult {
    ok: boolean;
    /** Platform-specific message ID of the sent message */
    messageId?: string;
    error?: string;
}
/** Links an IM chat to a CodePilot session */
export interface ChannelBinding {
    id: string;
    channelType: ChannelType;
    chatId: string;
    /** CodePilot session ID this chat is bound to */
    codepilotSessionId: string;
    /** SDK session ID for resume (cached from last conversation) */
    sdkSessionId: string;
    /** Working directory for this binding */
    workingDirectory: string;
    /** Model override for this binding */
    model: string;
    /** Chat mode */
    mode: 'code' | 'plan' | 'ask';
    /** Whether this binding is currently active */
    active: boolean;
    createdAt: string;
    updatedAt: string;
}
/** Overall bridge system status */
export interface BridgeStatus {
    running: boolean;
    startedAt: string | null;
    adapters: AdapterStatus[];
}
/** Status of a single channel adapter */
export interface AdapterStatus {
    channelType: ChannelType;
    running: boolean;
    connectedAt: string | null;
    lastMessageAt: string | null;
    error: string | null;
    connectionState?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
    reconnectAttempts?: number;
    lastConnectionChangeAt?: string | null;
}
/** Audit log entry */
export interface AuditLogEntry {
    id: string;
    channelType: ChannelType;
    chatId: string;
    direction: 'inbound' | 'outbound';
    messageId: string;
    summary: string;
    createdAt: string;
}
/** Permission link: maps permissionRequestId to an IM message for callback handling */
export interface PermissionLink {
    id: string;
    permissionRequestId: string;
    channelType: ChannelType;
    chatId: string;
    messageId: string;
    createdAt: string;
}
/** Capabilities of a channel adapter's streaming preview support */
export interface PreviewCapabilities {
    supported: boolean;
    privateOnly: boolean;
}
/** Mutable state for an in-flight streaming preview */
export interface StreamingPreviewState {
    draftId: number;
    chatId: string;
    lastSentText: string;
    lastSentAt: number;
    degraded: boolean;
    throttleTimer: ReturnType<typeof setTimeout> | null;
    pendingText: string;
}
/** Tool call tracking for streaming card progress display */
export interface ToolCallInfo {
    id: string;
    name: string;
    status: 'running' | 'complete' | 'error';
}
/** Platform-specific message length limits */
export declare const PLATFORM_LIMITS: Record<string, number>;
//# sourceMappingURL=types.d.ts.map