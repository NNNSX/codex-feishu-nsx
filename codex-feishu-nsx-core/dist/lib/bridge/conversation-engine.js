/**
 * Conversation Engine — processes inbound Feishu messages through Codex.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */
import fs from 'fs';
import path from 'path';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';
const OUTBOX_DIRECTORY = '.codex-feishu-nsx-outbox';
const MAX_OUTBOUND_ATTACHMENT_SIZE = 30 * 1024 * 1024;
const MAX_OUTBOUND_ATTACHMENT_TOTAL = 60 * 1024 * 1024;
const MAX_OUTBOUND_ATTACHMENT_COUNT = 10;
const ATTACHMENT_MARKER = /\[\[cti-attachment:([^\]\r\n]+)\]\]/g;
function isPathInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function mimeFromPath(filePath) {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mimeTypes = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        json: 'application/json',
        zip: 'application/zip',
        mp3: 'audio/mpeg',
        opus: 'audio/opus',
        ogg: 'audio/ogg',
        mp4: 'video/mp4',
    };
    return mimeTypes[extension] || 'application/octet-stream';
}
function cleanupExpiredUploads(uploadDirectory) {
    const rawRetention = getBridgeContext().store.getSetting('bridge_attachment_retention_days');
    const parsedRetention = rawRetention == null ? 30 : Number(rawRetention);
    if (!Number.isFinite(parsedRetention) || parsedRetention <= 0)
        return;
    const retentionDays = Math.min(parsedRetention, 3650);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    try {
        for (const entry of fs.readdirSync(uploadDirectory, { withFileTypes: true })) {
            if (!entry.isFile())
                continue;
            const filePath = path.join(uploadDirectory, entry.name);
            try {
                if (fs.statSync(filePath).mtimeMs < cutoff)
                    fs.unlinkSync(filePath);
            }
            catch { /* best-effort cleanup */ }
        }
    }
    catch { /* best-effort cleanup */ }
}
function buildProviderPrompt(userText, files, workingDirectory) {
    const sections = [userText];
    const persistedFiles = files?.filter((file) => file.filePath) || [];
    if (persistedFiles.length > 0) {
        const fileList = persistedFiles.map((file) => `- ${JSON.stringify(file.name)} (${file.type}, ${file.size} bytes): ${file.filePath}`);
        sections.push([
            '[Bridge attachment context]',
            'The user attached the following local files. Inspect them with the available local tools when relevant:',
            ...fileList,
        ].join('\n'));
    }
    if (workingDirectory) {
        const outbox = path.join(workingDirectory, OUTBOX_DIRECTORY);
        sections.push([
            '[Bridge file delivery]',
            `To return a generated non-image file to the user, place or copy it under ${outbox}.`,
            'Then include one exact marker per file in the final response: [[cti-attachment:<absolute-path>]].',
            'Do not use this marker for source files or files outside that outbox.',
        ].join('\n'));
    }
    return sections.filter(Boolean).join('\n\n');
}
export function collectOutboxAttachments(responseText, workingDirectory) {
    const warnings = [];
    const attachments = [];
    const requestedPaths = [];
    let match;
    ATTACHMENT_MARKER.lastIndex = 0;
    while ((match = ATTACHMENT_MARKER.exec(responseText)) !== null) {
        requestedPaths.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
    }
    const cleanedText = responseText.replace(ATTACHMENT_MARKER, '').replace(/\n{3,}/g, '\n\n').trim();
    if (requestedPaths.length === 0 || !workingDirectory) {
        return { text: cleanedText, attachments, warnings };
    }
    const outboxRoot = path.resolve(workingDirectory, OUTBOX_DIRECTORY);
    let canonicalOutbox;
    try {
        canonicalOutbox = fs.realpathSync(outboxRoot);
    }
    catch {
        return {
            text: cleanedText,
            attachments,
            warnings: ['Generated file delivery failed because the bridge outbox does not exist.'],
        };
    }
    let totalSize = 0;
    for (const requestedPath of requestedPaths.slice(0, MAX_OUTBOUND_ATTACHMENT_COUNT)) {
        const candidate = path.resolve(outboxRoot, requestedPath);
        try {
            const canonicalPath = fs.realpathSync(candidate);
            if (!isPathInside(canonicalOutbox, canonicalPath)) {
                warnings.push(`Blocked attachment outside the bridge outbox: ${path.basename(requestedPath)}`);
                continue;
            }
            const stat = fs.statSync(canonicalPath);
            if (!stat.isFile()) {
                warnings.push(`Attachment is not a regular file: ${path.basename(requestedPath)}`);
                continue;
            }
            if (stat.size === 0 || stat.size > MAX_OUTBOUND_ATTACHMENT_SIZE) {
                warnings.push(`Attachment must be between 1 byte and 30 MB: ${path.basename(requestedPath)}`);
                continue;
            }
            if (totalSize + stat.size > MAX_OUTBOUND_ATTACHMENT_TOTAL) {
                warnings.push('Generated attachments exceed the 60 MB total limit.');
                break;
            }
            const buffer = fs.readFileSync(canonicalPath);
            const id = crypto.createHash('sha256').update(buffer).digest('hex');
            if (attachments.some((attachment) => attachment.id === id))
                continue;
            attachments.push({
                id,
                name: path.basename(canonicalPath),
                type: mimeFromPath(canonicalPath),
                size: buffer.length,
                data: buffer.toString('base64'),
                filePath: canonicalPath,
            });
            totalSize += buffer.length;
        }
        catch (error) {
            warnings.push(`Unable to read generated attachment ${path.basename(requestedPath)}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (requestedPaths.length > MAX_OUTBOUND_ATTACHMENT_COUNT) {
        warnings.push(`Only the first ${MAX_OUTBOUND_ATTACHMENT_COUNT} generated attachments were considered.`);
    }
    return { text: cleanedText, attachments, warnings };
}
/**
 * Process an inbound message: send to Codex, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(binding, text, onPermissionRequest, abortSignal, files, onPartialText, onToolEvent) {
    const { store, llm } = getBridgeContext();
    const sessionId = binding.codepilotSessionId;
    // Acquire session lock
    const lockId = crypto.randomBytes(8).toString('hex');
    const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
    if (!lockAcquired) {
        return {
            responseText: '',
            attachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Session is busy processing another request',
            permissionRequests: [],
            sdkSessionId: null,
        };
    }
    store.setSessionRuntimeStatus(sessionId, 'running');
    // Lock renewal interval
    const renewalInterval = setInterval(() => {
        try {
            store.renewSessionLock(sessionId, lockId, 600);
        }
        catch { /* best effort */ }
    }, 60_000);
    try {
        // Resolve session early — needed for workingDirectory and provider resolution
        const session = store.getSession(sessionId);
        const workingDirectory = binding.workingDirectory || session?.working_directory || '';
        let providerFiles = files;
        // Save user message — persist file attachments to disk using the same
        // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
        let savedContent = text;
        if (files && files.length > 0) {
            if (workingDirectory) {
                try {
                    const uploadDir = path.join(workingDirectory, '.codepilot-uploads');
                    if (!fs.existsSync(uploadDir)) {
                        fs.mkdirSync(uploadDir, { recursive: true });
                    }
                    cleanupExpiredUploads(uploadDir);
                    const fileMeta = files.map((f) => {
                        const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment.bin';
                        const filePath = path.join(uploadDir, `${crypto.randomUUID()}-${safeName}`);
                        const buffer = Buffer.from(f.data, 'base64');
                        fs.writeFileSync(filePath, buffer);
                        return { ...f, size: buffer.length, filePath };
                    });
                    providerFiles = fileMeta;
                    const persistedMeta = fileMeta.map(({ data: _data, ...metadata }) => metadata);
                    savedContent = `<!--files:${JSON.stringify(persistedMeta)}-->${text}`;
                }
                catch (err) {
                    console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
                    savedContent = `[${files.length} attachment(s) attached] ${text}`;
                }
            }
            else {
                savedContent = `[${files.length} attachment(s) attached] ${text}`;
            }
        }
        store.addMessage(sessionId, 'user', savedContent);
        // Resolve provider
        let resolvedProvider;
        const providerId = session?.provider_id || '';
        if (providerId && providerId !== 'env') {
            resolvedProvider = store.getProvider(providerId);
        }
        if (!resolvedProvider) {
            const defaultId = store.getDefaultProviderId();
            if (defaultId)
                resolvedProvider = store.getProvider(defaultId);
        }
        // Effective model
        const effectiveModel = binding.model || session?.model || store.getSetting('default_model') || undefined;
        // Permission mode from binding mode
        let permissionMode;
        switch (binding.mode) {
            case 'plan':
                permissionMode = 'plan';
                break;
            case 'ask':
                permissionMode = 'default';
                break;
            default:
                permissionMode = 'acceptEdits';
                break;
        }
        // Load conversation history for context
        const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
        const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
            role: m.role,
            content: m.content,
        }));
        const abortController = new AbortController();
        if (abortSignal) {
            if (abortSignal.aborted) {
                abortController.abort();
            }
            else {
                abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
            }
        }
        if (workingDirectory) {
            try {
                fs.mkdirSync(path.join(workingDirectory, OUTBOX_DIRECTORY), { recursive: true });
            }
            catch { /* provider can still reply with text */ }
        }
        const stream = llm.streamChat({
            prompt: buildProviderPrompt(text, providerFiles, workingDirectory),
            sessionId,
            sdkSessionId: binding.sdkSessionId || undefined,
            model: effectiveModel,
            systemPrompt: session?.system_prompt || undefined,
            workingDirectory: workingDirectory || undefined,
            abortController,
            permissionMode,
            provider: resolvedProvider,
            conversationHistory: historyMsgs,
            files: providerFiles,
            onRuntimeStatusChange: (status) => {
                try {
                    store.setSessionRuntimeStatus(sessionId, status);
                }
                catch { /* best effort */ }
            },
        });
        // Consume the stream server-side (replicate collectStreamResponse pattern).
        // Permission requests are forwarded immediately via the callback during streaming
        // because the stream blocks until permission is resolved — we can't wait until after.
        return await consumeStream(stream, sessionId, workingDirectory, onPermissionRequest, onPartialText, onToolEvent);
    }
    finally {
        clearInterval(renewalInterval);
        store.releaseSessionLock(sessionId, lockId);
        store.setSessionRuntimeStatus(sessionId, 'idle');
    }
}
/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(stream, sessionId, workingDirectory, onPermissionRequest, onPartialText, onToolEvent) {
    const { store } = getBridgeContext();
    const reader = stream.getReader();
    const contentBlocks = [];
    let currentText = '';
    const responseAttachments = [];
    const attachmentWarnings = [];
    /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
    let previewText = '';
    let tokenUsage = null;
    let hasError = false;
    let errorMessage = '';
    const seenToolResultIds = new Set();
    const permissionRequests = [];
    let capturedSdkSessionId = null;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const lines = value.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                let event;
                try {
                    event = JSON.parse(line.slice(6));
                }
                catch {
                    continue;
                }
                switch (event.type) {
                    case 'text':
                        currentText += event.data;
                        if (onPartialText) {
                            previewText += event.data;
                            try {
                                onPartialText(previewText);
                            }
                            catch { /* non-critical */ }
                        }
                        break;
                    case 'attachment': {
                        try {
                            const attachment = JSON.parse(event.data);
                            if (attachment.id &&
                                attachment.name &&
                                attachment.type.startsWith('image/') &&
                                attachment.size > 0 &&
                                attachment.data) {
                                responseAttachments.push(attachment);
                            }
                        }
                        catch { /* skip malformed attachment events */ }
                        break;
                    }
                    case 'attachment_error':
                        if (event.data)
                            attachmentWarnings.push(event.data);
                        break;
                    case 'tool_use': {
                        if (currentText.trim()) {
                            contentBlocks.push({ type: 'text', text: currentText });
                            currentText = '';
                        }
                        try {
                            const toolData = JSON.parse(event.data);
                            contentBlocks.push({
                                type: 'tool_use',
                                id: toolData.id,
                                name: toolData.name,
                                input: toolData.input,
                            });
                            if (onToolEvent) {
                                try {
                                    onToolEvent(toolData.id, toolData.name, 'running');
                                }
                                catch { /* non-critical */ }
                            }
                        }
                        catch { /* skip */ }
                        break;
                    }
                    case 'tool_result': {
                        try {
                            const resultData = JSON.parse(event.data);
                            const newBlock = {
                                type: 'tool_result',
                                tool_use_id: resultData.tool_use_id,
                                content: resultData.content,
                                is_error: resultData.is_error || false,
                            };
                            if (seenToolResultIds.has(resultData.tool_use_id)) {
                                const idx = contentBlocks.findIndex((b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id);
                                if (idx >= 0)
                                    contentBlocks[idx] = newBlock;
                            }
                            else {
                                seenToolResultIds.add(resultData.tool_use_id);
                                contentBlocks.push(newBlock);
                            }
                            if (onToolEvent) {
                                try {
                                    onToolEvent(resultData.tool_use_id, '', // name not available in tool_result, adapter tracks by id
                                    resultData.is_error ? 'error' : 'complete');
                                }
                                catch { /* non-critical */ }
                            }
                        }
                        catch { /* skip */ }
                        break;
                    }
                    case 'permission_request': {
                        try {
                            const permData = JSON.parse(event.data);
                            const perm = {
                                permissionRequestId: permData.permissionRequestId,
                                toolName: permData.toolName,
                                toolInput: permData.toolInput,
                                suggestions: permData.suggestions,
                            };
                            permissionRequests.push(perm);
                            // Forward immediately — the stream blocks until the permission is
                            // resolved, so we must send the IM prompt *now*, not after the stream ends.
                            if (onPermissionRequest) {
                                onPermissionRequest(perm).catch((err) => {
                                    console.error('[conversation-engine] Failed to forward permission request:', err);
                                });
                            }
                        }
                        catch { /* skip */ }
                        break;
                    }
                    case 'status': {
                        try {
                            const statusData = JSON.parse(event.data);
                            if (statusData.session_id) {
                                capturedSdkSessionId = statusData.session_id;
                                store.updateSdkSessionId(sessionId, statusData.session_id);
                            }
                            if (statusData.model) {
                                store.updateSessionModel(sessionId, statusData.model);
                            }
                        }
                        catch { /* skip */ }
                        break;
                    }
                    case 'task_update': {
                        try {
                            const taskData = JSON.parse(event.data);
                            if (taskData.session_id && taskData.todos) {
                                store.syncSdkTasks(taskData.session_id, taskData.todos);
                            }
                        }
                        catch { /* skip */ }
                        break;
                    }
                    case 'error':
                        hasError = true;
                        errorMessage = event.data || 'Unknown error';
                        break;
                    case 'result': {
                        try {
                            const resultData = JSON.parse(event.data);
                            if (resultData.usage)
                                tokenUsage = resultData.usage;
                            if (resultData.is_error)
                                hasError = true;
                            if (resultData.session_id) {
                                capturedSdkSessionId = resultData.session_id;
                                store.updateSdkSessionId(sessionId, resultData.session_id);
                            }
                        }
                        catch { /* skip */ }
                        break;
                    }
                    // tool_output, tool_timeout, mode_changed, done — ignored for bridge
                }
            }
        }
        // Flush remaining text
        if (currentText.trim()) {
            contentBlocks.push({ type: 'text', text: currentText });
        }
        const rawResponseText = contentBlocks
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
        const outboxResult = collectOutboxAttachments(rawResponseText, workingDirectory);
        responseAttachments.push(...outboxResult.attachments.filter((candidate) => !responseAttachments.some((existing) => existing.id === candidate.id)));
        const responseText = [
            outboxResult.text,
            ...[...attachmentWarnings, ...outboxResult.warnings].map((warning) => `[Attachment warning] ${warning}`),
        ]
            .filter(Boolean)
            .join('\n\n')
            .trim();
        // Save assistant message without attachment markers or binary data.
        if (contentBlocks.length > 0) {
            const hasToolBlocks = contentBlocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
            const content = hasToolBlocks
                ? JSON.stringify(contentBlocks.map((block) => block.type === 'text'
                    ? { ...block, text: block.text.replace(ATTACHMENT_MARKER, '').trim() }
                    : block))
                : responseText;
            if (content) {
                store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
            }
        }
        return {
            responseText,
            attachments: responseAttachments,
            tokenUsage,
            hasError,
            errorMessage,
            permissionRequests,
            sdkSessionId: capturedSdkSessionId,
        };
    }
    catch (e) {
        // Best-effort save on stream error
        if (currentText.trim()) {
            contentBlocks.push({ type: 'text', text: currentText });
        }
        if (contentBlocks.length > 0) {
            const hasToolBlocks = contentBlocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
            const content = hasToolBlocks
                ? JSON.stringify(contentBlocks)
                : contentBlocks
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n\n')
                    .trim();
            if (content) {
                store.addMessage(sessionId, 'assistant', content);
            }
        }
        const isAbort = e instanceof DOMException && e.name === 'AbortError'
            || e instanceof Error && e.name === 'AbortError';
        return {
            responseText: '',
            attachments: responseAttachments,
            tokenUsage,
            hasError: true,
            errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
            permissionRequests,
            sdkSessionId: capturedSdkSessionId,
        };
    }
}
//# sourceMappingURL=conversation-engine.js.map