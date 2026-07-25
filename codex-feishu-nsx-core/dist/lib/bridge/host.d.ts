/**
 * Host Interfaces — abstractions for host-application dependencies.
 *
 * These interfaces decouple the bridge system from any specific host
 * (e.g., CodePilot). A host must provide implementations of these
 * interfaces to use the bridge.
 */
import type { ChannelBinding, ChannelType, InboundMessage } from './types.js';
/** File attachment from an IM channel (images, documents). */
export interface FileAttachment {
    id: string;
    name: string;
    type: string;
    size: number;
    data: string;
    filePath?: string;
}
/** Server-Sent Event from the LLM stream. */
export interface SSEEvent {
    type: SSEEventType;
    data: string;
}
export type SSEEventType = 'text' | 'attachment' | 'attachment_error' | 'tool_use' | 'tool_result' | 'tool_output' | 'tool_timeout' | 'status' | 'result' | 'error' | 'permission_request' | 'mode_changed' | 'task_update' | 'keep_alive' | 'done';
/** Content block in an LLM response message. */
export type MessageContentBlock = {
    type: 'text';
    text: string;
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
} | {
    type: 'code';
    language: string;
    code: string;
};
/** Token usage statistics from an LLM response. */
export interface TokenUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cost_usd?: number;
}
/** API provider configuration (opaque to the bridge). */
export interface BridgeApiProvider {
    id: string;
    [key: string]: unknown;
}
/** Minimal session object returned by the store. */
export interface BridgeSession {
    id: string;
    working_directory: string;
    model: string;
    system_prompt?: string;
    provider_id?: string;
}
/** Minimal message object returned by the store. */
export interface BridgeMessage {
    role: string;
    content: string;
}
export type BridgeJobState = 'received' | 'running' | 'codex_completed' | 'delivering' | 'delivered' | 'failed' | 'interrupted';
/** Attachment metadata stored without requiring binary data in the job ledger. */
export interface BridgeJobAttachment {
    id: string;
    name: string;
    type: string;
    size: number;
    data?: string;
    filePath?: string;
}
/** Durable record for one inbound Feishu task and its outbound result. */
export interface BridgeJobRecord {
    id: string;
    channelType: ChannelType;
    chatId: string;
    userId?: string;
    sessionId: string;
    requestText: string;
    replyToMessageId?: string;
    inputAttachments: BridgeJobAttachment[];
    state: BridgeJobState;
    responseText: string;
    outputAttachments: BridgeJobAttachment[];
    hasError: boolean;
    errorMessage: string;
    deliveryError?: string;
    textDelivered: boolean;
    attachmentsDelivered: boolean;
    deliveryAttempts: number;
    nextAttemptAt?: string;
    recoveryNoticeDelivered: boolean;
    streamingCardId?: string;
    streamingMessageId?: string;
    streamingSequence?: number;
    streamingStartedAt?: string;
    streamingCardFinalized?: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface SettingsProvider {
    getSetting(key: string): string | null;
}
/** Input for creating an audit log entry. */
export interface AuditLogInput {
    channelType: string;
    chatId: string;
    direction: 'inbound' | 'outbound';
    messageId: string;
    summary: string;
}
/** Input for inserting a permission link. */
export interface PermissionLinkInput {
    permissionRequestId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    toolName: string;
    suggestions: string;
    createdAt?: string;
}
/** Stored permission link record. */
export interface PermissionLinkRecord {
    permissionRequestId: string;
    chatId: string;
    messageId: string;
    resolved: boolean;
    suggestions: string;
    createdAt?: string;
}
/** Input for inserting an outbound reference. */
export interface OutboundRefInput {
    channelType: string;
    chatId: string;
    codepilotSessionId: string;
    platformMessageId: string;
    purpose: string;
}
/** Input for upserting a channel binding. */
export interface UpsertChannelBindingInput {
    channelType: ChannelType;
    chatId: string;
    codepilotSessionId: string;
    sdkSessionId?: string;
    workingDirectory: string;
    model: string;
    mode?: string;
}
/**
 * Persistence layer for the bridge system.
 * All database operations are abstracted through this interface.
 */
export interface BridgeStore {
    getSetting(key: string): string | null;
    getChannelBinding(channelType: string, chatId: string): ChannelBinding | null;
    upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding;
    updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void;
    listChannelBindings(channelType?: ChannelType): ChannelBinding[];
    getSession(id: string): BridgeSession | null;
    createSession(name: string, model: string, systemPrompt?: string, cwd?: string, mode?: string): BridgeSession;
    updateSessionProviderId(sessionId: string, providerId: string): void;
    addMessage(sessionId: string, role: string, content: string, usage?: string | null): void;
    getMessages(sessionId: string, opts?: {
        limit?: number;
    }): {
        messages: BridgeMessage[];
    };
    acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
    renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
    releaseSessionLock(sessionId: string, lockId: string): void;
    setSessionRuntimeStatus(sessionId: string, status: string): void;
    updateSdkSessionId(sessionId: string, sdkSessionId: string): void;
    updateSessionModel(sessionId: string, model: string): void;
    syncSdkTasks(sessionId: string, todos: unknown): void;
    getProvider(id: string): BridgeApiProvider | undefined;
    getDefaultProviderId(): string | null;
    insertAuditLog(entry: AuditLogInput): void;
    checkDedup(key: string): boolean;
    insertDedup(key: string): void;
    cleanupExpiredDedup(): void;
    insertOutboundRef(ref: OutboundRefInput): void;
    insertPermissionLink(link: PermissionLinkInput): void;
    getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
    markPermissionLinkResolved(permissionRequestId: string): boolean;
    /** List unresolved permission links for a given chat. */
    listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[];
    /** Remove old resolved permission links. */
    prunePermissionLinks?(beforeIso: string): number;
    getChannelOffset(key: string): string;
    setChannelOffset(key: string, offset: string): void;
    getBridgeJob?(id: string): BridgeJobRecord | null;
    upsertBridgeJob?(job: BridgeJobRecord): BridgeJobRecord;
    updateBridgeJob?(id: string, updates: Partial<BridgeJobRecord>): BridgeJobRecord | null;
    listBridgeJobs?(states?: BridgeJobState[]): BridgeJobRecord[];
    pruneBridgeJobs?(beforeIso: string): number;
    enqueueInboundMessage?(message: InboundMessage): boolean;
    listInboundMessages?(channelType?: ChannelType): InboundMessage[];
    removeInboundMessage?(messageId: string): void;
}
/** Parameters for starting an LLM stream. */
export interface StreamChatParams {
    prompt: string;
    sessionId: string;
    sdkSessionId?: string;
    model?: string;
    systemPrompt?: string;
    workingDirectory?: string;
    abortController?: AbortController;
    permissionMode?: string;
    provider?: BridgeApiProvider;
    conversationHistory?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    files?: FileAttachment[];
    onRuntimeStatusChange?: (status: string) => void;
}
export interface LLMProvider {
    /**
     * Start a streaming chat with the LLM.
     * Returns a ReadableStream of SSE-formatted strings.
     */
    streamChat(params: StreamChatParams): ReadableStream<string>;
}
/** Resolution result for a pending permission. */
export interface PermissionResolution {
    behavior: 'allow' | 'deny';
    message?: string;
    updatedPermissions?: unknown[];
}
export interface PermissionGateway {
    /**
     * Resolve a pending permission request.
     * Returns true if the permission was found and resolved.
     */
    resolvePendingPermission(permissionRequestId: string, resolution: PermissionResolution): boolean;
}
export interface LifecycleHooks {
    /** Called when the bridge system starts (e.g., to suppress competing polling). */
    onBridgeStart?(): void;
    /** Called when the bridge system stops. */
    onBridgeStop?(): void;
}
//# sourceMappingURL=host.d.ts.map