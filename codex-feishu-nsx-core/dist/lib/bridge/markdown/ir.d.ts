export type MarkdownStyle = 'bold' | 'italic' | 'strikethrough' | 'code' | 'code_block' | 'blockquote';
export type MarkdownStyleSpan = {
    start: number;
    end: number;
    style: MarkdownStyle;
};
export type MarkdownLinkSpan = {
    start: number;
    end: number;
    href: string;
};
export type MarkdownIR = {
    text: string;
    styles: MarkdownStyleSpan[];
    links: MarkdownLinkSpan[];
};
export type MarkdownParseOptions = {
    linkify?: boolean;
    headingStyle?: 'none' | 'bold';
    blockquotePrefix?: string;
    autolink?: boolean;
    enableTables?: boolean;
};
export declare function markdownToIR(markdown: string, options?: MarkdownParseOptions): MarkdownIR;
export declare function chunkMarkdownIR(ir: MarkdownIR, limit: number): MarkdownIR[];
//# sourceMappingURL=ir.d.ts.map