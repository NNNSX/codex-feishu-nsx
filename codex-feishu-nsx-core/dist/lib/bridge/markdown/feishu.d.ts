import type { ToolCallInfo } from '../types.js';
/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */
/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export declare function hasComplexMarkdown(text: string): boolean;
/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export declare function preprocessFeishuMarkdown(text: string): string;
/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export declare function buildCardContent(text: string): string;
/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export declare function buildPostContent(text: string): string;
/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export declare function htmlToFeishuMarkdown(html: string): string;
/**
 * Build tool progress markdown lines.
 * Each tool shows an icon based on status: 🔄 Running, ✅ Complete, ❌ Error.
 */
export declare function buildToolProgressMarkdown(tools: ToolCallInfo[]): string;
/**
 * Format elapsed time for card footer.
 */
export declare function formatElapsed(ms: number): string;
/**
 * Build the body elements array for a streaming card update.
 * Combines main text content with tool progress.
 */
export declare function buildStreamingContent(text: string, tools: ToolCallInfo[]): string;
/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export declare function buildFinalCardJson(text: string, tools: ToolCallInfo[], footer: {
    status: string;
    elapsed: string;
} | null): string;
/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export declare function buildPermissionButtonCard(text: string, permissionRequestId: string, chatId?: string): string;
//# sourceMappingURL=feishu.d.ts.map