/**
 * Delivery Layer — reliable outbound message delivery with chunking,
 * dedup, retry, error classification, and reference tracking.
 */
import type { ChannelAddress, OutboundMessage, SendResult } from './types.js';
import type { FileAttachment } from './host.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
/**
 * Send a message through an adapter with chunking, dedup, retry, and auditing.
 */
export declare function deliver(adapter: BaseChannelAdapter, message: OutboundMessage, opts?: {
    sessionId?: string;
    dedupKey?: string;
}): Promise<SendResult>;
/**
 * Deliver attachments one at a time. A partial batch failure can therefore be
 * retried without resending files that the platform already accepted.
 */
export declare function deliverAttachments(adapter: BaseChannelAdapter, message: Omit<OutboundMessage, 'text' | 'attachments' | 'idempotencyKey'> & {
    attachments: FileAttachment[];
}, opts?: {
    sessionId?: string;
}): Promise<SendResult>;
/**
 * Deliver pre-rendered chunks (from Markdown renderer).
 * Each chunk already has HTML and plain text fallback.
 */
export declare function deliverRendered(adapter: BaseChannelAdapter, address: ChannelAddress, chunks: Array<{
    html: string;
    text: string;
}>, opts?: {
    sessionId?: string;
    dedupKey?: string;
    replyToMessageId?: string;
}): Promise<SendResult>;
//# sourceMappingURL=delivery-layer.d.ts.map