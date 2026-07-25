/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from './core/host.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Feishu's message-image API rejects empty images and files larger than 10 MB. */
const MAX_OUTBOUND_IMAGE_SIZE = 10 * 1024 * 1024;

/** Bound rollout reads so a large historical session cannot exhaust bridge memory. */
const MAX_ROLLOUT_SCAN_BYTES = 20 * 1024 * 1024;

interface GeneratedImageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
}

function imageTypeFromBuffer(buffer: Buffer): { type: string; ext: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', ext: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { type: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { type: 'image/gif', ext: 'gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { type: 'image/webp', ext: 'webp' };
  }
  return null;
}

function generatedImageAttachment(item: Record<string, unknown>): GeneratedImageAttachment | null {
  if (item.status && item.status !== 'completed') return null;

  let raw = typeof item.result === 'string' ? item.result : '';
  let declaredType: string | null = null;
  const dataUrlMatch = raw.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    declaredType = dataUrlMatch[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    raw = dataUrlMatch[2];
  }

  const data = raw.replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_OUTBOUND_IMAGE_SIZE) return null;

  const detected = imageTypeFromBuffer(buffer);
  if (!detected) return null;
  if (declaredType && declaredType !== detected.type) return null;

  const rawId = typeof item.id === 'string' && item.id ? item.id : `generated-${Date.now()}`;
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    id: rawId,
    name: `${safeId}.${detected.ext}`,
    type: detected.type,
    size: buffer.length,
    data,
  };
}

function generatedImageFailure(item: Record<string, unknown>): string | null {
  if (item.status && item.status !== 'completed') return null;
  const raw = typeof item.result === 'string' ? item.result : '';
  if (!raw) return 'Codex completed image generation without returning image data.';
  const dataUrlMatch = raw.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/i);
  const data = (dataUrlMatch ? dataUrlMatch[2] : raw).replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return 'Codex returned malformed generated-image data.';
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) return 'Codex returned an empty generated image.';
  if (buffer.length > MAX_OUTBOUND_IMAGE_SIZE) {
    return `Generated image is ${buffer.length} bytes and exceeds the 10 MB delivery limit.`;
  }
  if (!imageTypeFromBuffer(buffer)) return 'Codex returned an unsupported generated-image format.';
  return 'Generated image metadata did not match the image content.';
}

function findRolloutFile(threadId: string): string | null {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsRoot = path.join(codexHome, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const pending = [sessionsRoot];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return entryPath;
      }
    }
  }
  return null;
}

function rolloutSize(filePath: string | null): number {
  if (!filePath) return 0;
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function generatedImagesFromRollout(
  filePath: string,
  startOffset: number,
): { attachments: GeneratedImageAttachment[]; warnings: string[] } {
  let handle: number | null = null;
  try {
    const endOffset = fs.statSync(filePath).size;
    if (endOffset <= startOffset) return { attachments: [], warnings: [] };

    const readStart = Math.max(startOffset, endOffset - MAX_ROLLOUT_SCAN_BYTES);
    const buffer = Buffer.alloc(endOffset - readStart);
    handle = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, readStart);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (readStart > startOffset) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    const images: GeneratedImageAttachment[] = [];
    const warnings: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
        if (record.type !== 'response_item' || record.payload?.type !== 'image_generation_call') continue;
        const attachment = generatedImageAttachment(record.payload);
        if (attachment) images.push(attachment);
        else {
          const warning = generatedImageFailure(record.payload);
          if (warning) warnings.push(warning);
        }
      } catch {
        // A partially-flushed final JSONL line is safe to ignore; direct events still work.
      }
    }
    return { attachments: images, warnings };
  } catch (err) {
    console.warn('[codex-provider] Failed to inspect rollout for generated images:', err instanceof Error ? err.message : err);
    return { attachments: [], warnings: [] };
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* ignore */ }
    }
  }
}

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

type CodexSandboxMode = 'read-only' | 'workspace-write';

/**
 * Keep planning/approval modes read-only. Code mode may write only inside the
 * configured working directory, which includes the bridge attachment outbox.
 */
function resolveSandboxMode(permissionMode?: string): CodexSandboxMode {
  const configured = process.env.CFN_CODEX_SANDBOX_MODE?.trim();
  if (configured === 'read-only' || configured === 'workspace-write') {
    return configured;
  }
  return permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only';
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CFN_CODEX_PASS_MODEL === 'true';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CFN_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(_legacyPermissionGateway?: unknown) {}

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CFN_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > login auth.
    const apiKey = process.env.CFN_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CFN_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            let savedThreadId = inMemoryThreadId || params.sdkSessionId || undefined;

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const sandboxMode = resolveSandboxMode(params.permissionMode);
            const passModel = shouldPassModelToCodex();

            const threadOptions: Record<string, unknown> = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              approvalPolicy,
              sandboxMode,
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              for (const file of imageFiles) {
                if (file.filePath && fs.existsSync(file.filePath)) {
                  parts.push({ type: 'local_image', path: file.filePath });
                } else {
                  const ext = MIME_EXT[file.type] || '.png';
                  const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                  fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                  tempFiles.push(tmpPath);
                  parts.push({ type: 'local_image', path: tmpPath });
                }
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            let retryFresh = false;

            while (true) {
              let rolloutPath = savedThreadId ? findRolloutFile(savedThreadId) : null;
              let rolloutOffset = rolloutSize(rolloutPath);
              const emittedImageIds = new Set<string>();
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input);

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);
                      if (!rolloutPath || (savedThreadId && threadId !== savedThreadId)) {
                        rolloutPath = findRolloutFile(threadId);
                        // A new thread contains only this turn; a resumed thread was measured above.
                        rolloutOffset = savedThreadId && threadId === savedThreadId
                          ? rolloutSize(rolloutPath)
                          : 0;
                      }

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      self.handleCompletedItem(controller, item, emittedImageIds);
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      if (threadId) {
                        rolloutPath ||= findRolloutFile(threadId);
                        if (rolloutPath) {
                          const scan = generatedImagesFromRollout(rolloutPath, rolloutOffset);
                          for (const attachment of scan.attachments) {
                            if (emittedImageIds.has(attachment.id)) continue;
                            emittedImageIds.add(attachment.id);
                            controller.enqueue(sseEvent('attachment', attachment));
                          }
                          for (const warning of scan.warnings) {
                            controller.enqueue(sseEvent('attachment_error', warning));
                          }
                        }
                      }

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    emittedImageIds = new Set<string>(),
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'image_generation':
      case 'image_generation_call': {
        const attachment = generatedImageAttachment(item);
        if (attachment && !emittedImageIds.has(attachment.id)) {
          emittedImageIds.add(attachment.id);
          controller.enqueue(sseEvent('attachment', attachment));
        } else if (!attachment) {
          const warning = generatedImageFailure(item);
          if (warning) controller.enqueue(sseEvent('attachment_error', warning));
        }
        break;
      }

      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
