/**
 * Per-chat sliding window rate limiter.
 *
 * Prevents sending more than `maxMessages` messages per `windowMs` to the
 * same chat. When the limit is hit, `acquire()` delays until the window
 * slides enough to allow the next message.
 */
const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
export class ChatRateLimiter {
    buckets = new Map();
    maxMessages;
    windowMs;
    constructor(opts) {
        this.maxMessages = opts?.maxMessages ?? DEFAULT_MAX_MESSAGES;
        this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    }
    /**
     * Wait until sending a message to `chatId` is allowed.
     * Registers the send timestamp upon returning.
     */
    async acquire(chatId) {
        const now = Date.now();
        const bucket = this.getOrCreate(chatId);
        this.pruneOld(bucket, now);
        if (bucket.timestamps.length < this.maxMessages) {
            bucket.timestamps.push(now);
            return;
        }
        // Window is full — wait until the oldest entry expires
        const oldest = bucket.timestamps[0];
        const waitMs = oldest + this.windowMs - now;
        if (waitMs > 0) {
            await new Promise(r => setTimeout(r, waitMs));
        }
        // Prune again after waiting and record
        const afterWait = Date.now();
        this.pruneOld(bucket, afterWait);
        bucket.timestamps.push(afterWait);
    }
    /**
     * Remove buckets that have been idle for longer than 2x the window.
     * Call periodically to prevent memory leaks for long-running processes.
     */
    cleanup() {
        const now = Date.now();
        const expiry = this.windowMs * 2;
        for (const [chatId, bucket] of this.buckets) {
            const latest = bucket.timestamps[bucket.timestamps.length - 1];
            if (!latest || now - latest > expiry) {
                this.buckets.delete(chatId);
            }
        }
    }
    getOrCreate(chatId) {
        let bucket = this.buckets.get(chatId);
        if (!bucket) {
            bucket = { timestamps: [] };
            this.buckets.set(chatId, bucket);
        }
        return bucket;
    }
    pruneOld(bucket, now) {
        const cutoff = now - this.windowMs;
        // timestamps are in chronological order; drop from front
        while (bucket.timestamps.length > 0 && bucket.timestamps[0] <= cutoff) {
            bucket.timestamps.shift();
        }
    }
}
//# sourceMappingURL=rate-limiter.js.map