/**
 * Input validation and sanitization for bridge IM commands.
 *
 * Prevents path traversal, command injection, and other dangerous inputs
 * from reaching the conversation engine or file system operations.
 */
/**
 * Validate a working directory path.
 * Must be an absolute path without traversal or shell metacharacters.
 * Returns sanitized path or null if invalid.
 */
export declare function validateWorkingDirectory(rawPath: string): string | null;
/**
 * Validate a session ID format.
 * Must be a hex string or UUID, 32-64 characters.
 */
export declare function validateSessionId(id: string): boolean;
/**
 * Check if input contains dangerous patterns (path traversal, command injection, etc.).
 * Returns { dangerous: false } for safe inputs or { dangerous: true, reason } for threats.
 */
export declare function isDangerousInput(input: string): {
    dangerous: boolean;
    reason?: string;
};
/**
 * Sanitize general text input: strip control characters (except newline/tab)
 * and enforce max length.
 * Returns { text, truncated } — truncated is true if the input was shortened.
 */
export declare function sanitizeInput(text: string, maxLength?: number): {
    text: string;
    truncated: boolean;
};
/**
 * Validate /mode parameter.
 */
export declare function validateMode(mode: string): mode is 'plan' | 'code' | 'ask';
//# sourceMappingURL=validators.d.ts.map