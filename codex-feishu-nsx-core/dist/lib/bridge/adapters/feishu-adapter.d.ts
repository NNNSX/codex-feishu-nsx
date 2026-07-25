/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from '../types.js';
import type { ToolCallInfo } from '../types.js';
import { BaseChannelAdapter } from '../channel-adapter.js';
export declare class FeishuAdapter extends BaseChannelAdapter {
    readonly channelType: ChannelType;
    private running;
    private queue;
    private waiters;
    private wsClient;
    private restClient;
    private seenMessageIds;
    private botOpenId;
    /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
    private botIds;
    /** Track last incoming message ID per chat for typing indicator. */
    private lastIncomingMessageId;
    /** Track active typing reaction IDs per chat for cleanup. */
    private typingReactions;
    /** Active streaming card state per chatId. */
    private activeCards;
    /** In-flight card creation promises per chatId — prevents duplicate creation. */
    private cardCreatePromises;
    private currentTaskIds;
    private connectionState;
    private reconnectAttempts;
    private lastConnectionChangeAt;
    private lastConnectionError;
    start(): Promise<void>;
    stop(): Promise<void>;
    isRunning(): boolean;
    getConnectionHealth(): {
        state: lark.WSConnectionState;
        reconnectAttempts: number;
        lastConnectionChangeAt: string | null;
        error: string | null;
    };
    consumeOne(): Promise<InboundMessage | null>;
    private enqueue;
    /**
     * Add a "Typing" emoji reaction to the user's message and create streaming card.
     * Called by bridge-manager via onMessageStart().
     */
    onMessageStart(chatId: string, taskId?: string): void;
    /**
     * Remove the "Typing" emoji reaction and clean up card state.
     * Called by bridge-manager via onMessageEnd().
     */
    onMessageEnd(chatId: string): void;
    /**
     * Handle card.action.trigger events (button clicks on permission cards).
     * Converts button clicks to synthetic InboundMessage with callbackData.
     * Must return within 3 seconds (Feishu timeout), so uses a 2.5s race.
     */
    private handleCardAction;
    /**
     * Create a new streaming card and send it as a message.
     * Returns true if card was created successfully.
     */
    private createStreamingCard;
    private _doCreateStreamingCard;
    /**
     * Update streaming card content with throttling.
     */
    private updateCardContent;
    /**
     * Flush pending card update to Feishu API.
     */
    private flushCardUpdate;
    /**
     * Update tool progress in the streaming card.
     */
    private updateToolProgress;
    /**
     * Finalize the streaming card: close streaming mode, update with final content + footer.
     */
    private finalizeCard;
    /**
     * Clean up card state without finalizing (e.g. on unexpected errors).
     */
    private cleanupCard;
    /**
     * Check if there is an active streaming card for a given chat.
     */
    hasActiveCard(chatId: string): boolean;
    /**
     * Called by bridge-manager on each text SSE event.
     * Creates streaming card on first call, then updates content.
     */
    onStreamText(chatId: string, fullText: string): void;
    onToolEvent(chatId: string, tools: ToolCallInfo[]): void;
    onStreamEnd(chatId: string, status: 'completed' | 'interrupted' | 'error', responseText: string): Promise<boolean>;
    finalizeRecoveredTask(job: import('../host.js').BridgeJobRecord): Promise<void>;
    send(message: OutboundMessage): Promise<SendResult>;
    private sendAttachments;
    /**
     * Send text as an interactive card (schema 2.0 markdown).
     * Used for code blocks and tables — card renders them properly.
     */
    private sendAsCard;
    /**
     * Send text as a post message (msg_type: 'post') with md tag.
     * Used for simple text — renders bold, italic, inline code, links.
     */
    private sendAsPost;
    /**
     * Send a permission card with real Feishu card action buttons.
     * Button clicks trigger card.action.trigger events handled by handleCardAction().
     * Falls back to text-based /perm commands if button card fails.
     */
    private sendPermissionCard;
    validateConfig(): string | null;
    isAuthorized(userId: string, chatId: string): boolean;
    private handleIncomingEvent;
    private processIncomingEvent;
    private parseTextContent;
    /**
     * Extract file key from message content JSON.
     * Handles multiple key names: image_key, file_key, imageKey, fileKey.
     */
    private extractFileKey;
    private extractResourceMetadata;
    /**
     * Parse rich text (post) content.
     * Extracts plain text from text elements and image keys from img elements.
     */
    private parsePostContent;
    /**
     * Resolve bot identity via the Feishu REST API /bot/v3/info/.
     * Collects all available bot IDs for comprehensive mention matching.
     */
    private resolveBotIdentity;
    /**
     * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
     */
    private isBotMentioned;
    private stripMentionMarkers;
    /**
     * Download a message resource (image/file/audio/video) via SDK.
     * Returns null on failure (caller decides fallback behavior).
     */
    private downloadResource;
    private addToDedup;
}
//# sourceMappingURL=feishu-adapter.d.ts.map