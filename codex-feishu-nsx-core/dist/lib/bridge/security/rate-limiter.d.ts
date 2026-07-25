/**
 * Per-chat sliding window rate limiter.
 *
 * Prevents sending more than `maxMessages` messages per `windowMs` to the
 * same chat. When the limit is hit, `acquire()` delays until the window
 * slides enough to allow the next message.
 */
export declare class ChatRateLimiter {
    private buckets;
    private maxMessages;
    private windowMs;
    constructor(opts?: {
        maxMessages?: number;
        windowMs?: number;
    });
    /**
     * Wait until sending a message to `chatId` is allowed.
     * Registers the send timestamp upon returning.
     */
    acquire(chatId: string): Promise<void>;
    /**
     * Remove buckets that have been idle for longer than 2x the window.
     * Call periodically to prevent memory leaks for long-running processes.
     */
    cleanup(): void;
    private getOrCreate;
    private pruneOld;
}
//# sourceMappingURL=rate-limiter.d.ts.map