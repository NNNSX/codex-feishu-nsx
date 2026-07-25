import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function createStore(workingDirectory = ''): BridgeStore {
  return {
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as ChannelBinding),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => ({ id: 'session-1', working_directory: workingDirectory, model: '' }),
    createSession: () => ({ id: 'session-1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

describe('generated image delivery', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('collects attachment SSE events without putting base64 in response text', async () => {
    const attachment = {
      id: 'ig-1',
      name: 'ig-1.png',
      type: 'image/png',
      size: Buffer.from(PNG_BASE64, 'base64').length,
      data: PNG_BASE64,
    };
    initBridgeContext({
      store: createStore(),
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'attachment', data: JSON.stringify(attachment) })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: '{}' })}\n`);
            controller.close();
          },
        }),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const binding: ChannelBinding = {
      id: 'binding-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: '',
      workingDirectory: '',
      model: '',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await processMessage(binding, 'draw an image');
    assert.equal(result.responseText, '');
    assert.deepEqual(result.attachments, [attachment]);
  });

  it('uploads generated images and replies with a Feishu image message', async () => {
    const adapter = new FeishuAdapter();
    let uploaded: Buffer | undefined;
    let replyPayload: any;
    (adapter as any).restClient = {
      im: {
        image: {
          create: async ({ data }: any) => {
            uploaded = data.image;
            return { image_key: 'img_key_1' };
          },
        },
        message: {
          reply: async (payload: any) => {
            replyPayload = payload;
            return { data: { message_id: 'msg-image-1' } };
          },
          create: async () => ({ data: { message_id: 'msg-image-1' } }),
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      replyToMessageId: 'source-message-1',
      attachments: [{
        id: 'ig-1',
        name: 'ig-1.png',
        type: 'image/png',
        size: Buffer.from(PNG_BASE64, 'base64').length,
        data: PNG_BASE64,
      }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'msg-image-1');
    assert.deepEqual(uploaded, Buffer.from(PNG_BASE64, 'base64'));
    assert.equal(replyPayload.path.message_id, 'source-message-1');
    assert.equal(replyPayload.data.msg_type, 'image');
    assert.deepEqual(JSON.parse(replyPayload.data.content), { image_key: 'img_key_1' });
  });

  it('uploads generated PDF files and replies with a Feishu file message', async () => {
    const adapter = new FeishuAdapter();
    let uploaded: any;
    let replyPayload: any;
    (adapter as any).restClient = {
      im: {
        file: {
          create: async ({ data }: any) => {
            uploaded = data;
            return { file_key: 'file_key_1' };
          },
        },
        image: { create: async () => ({ image_key: 'unused' }) },
        message: {
          reply: async (payload: any) => {
            replyPayload = payload;
            return { data: { message_id: 'msg-file-1' } };
          },
          create: async () => ({ data: { message_id: 'msg-file-1' } }),
        },
      },
    };

    const data = Buffer.from('%PDF-test');
    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      replyToMessageId: 'source-message-1',
      idempotencyKey: 'stable-file-key',
      attachments: [{
        id: 'pdf-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: data.length,
        data: data.toString('base64'),
      }],
    });

    assert.equal(result.ok, true);
    assert.equal(uploaded.file_type, 'pdf');
    assert.equal(uploaded.file_name, 'report.pdf');
    assert.deepEqual(uploaded.file, data);
    assert.equal(replyPayload.data.msg_type, 'file');
    assert.equal(replyPayload.data.uuid, 'stable-file-key');
    assert.deepEqual(JSON.parse(replyPayload.data.content), { file_key: 'file_key_1' });
  });

  it('uses the reply target and idempotency key for text messages', async () => {
    const adapter = new FeishuAdapter();
    let replyPayload: any;
    (adapter as any).restClient = {
      im: {
        message: {
          reply: async (payload: any) => {
            replyPayload = payload;
            return { data: { message_id: 'msg-text-1' } };
          },
          create: async () => ({ data: { message_id: 'unexpected-create' } }),
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: 'Recovered response',
      parseMode: 'plain',
      replyToMessageId: 'source-message-1',
      idempotencyKey: 'stable-text-key',
    });

    assert.equal(result.ok, true);
    assert.equal(replyPayload.path.message_id, 'source-message-1');
    assert.equal(replyPayload.data.uuid, 'stable-text-key');
    assert.equal(replyPayload.data.msg_type, 'post');
  });

  it('uses the reply target and idempotency key for permission cards', async () => {
    const adapter = new FeishuAdapter();
    let replyPayload: any;
    (adapter as any).restClient = {
      im: {
        message: {
          reply: async (payload: any) => {
            replyPayload = payload;
            return { data: { message_id: 'permission-card-1' } };
          },
          create: async () => ({ data: { message_id: 'unexpected-create' } }),
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '<b>Permission Required</b>',
      parseMode: 'HTML',
      replyToMessageId: 'source-message-1',
      idempotencyKey: 'stable-permission-key',
      inlineButtons: [[{ text: 'Allow', callbackData: 'perm:allow:permission-1' }]],
    });

    assert.equal(result.ok, true);
    assert.equal(replyPayload.path.message_id, 'source-message-1');
    assert.equal(replyPayload.data.uuid, 'stable-permission-key');
    assert.equal(replyPayload.data.msg_type, 'interactive');
  });

  it('passes persisted non-image attachment paths to the provider', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-inbound-'));
    let captured: any;
    try {
      initBridgeContext({
        store: createStore(workDir),
        llm: {
          streamChat: (params) => {
            captured = params;
            return new ReadableStream<string>({
              start(controller) {
                controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Read it' })}\n`);
                controller.close();
              },
            });
          },
        },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });
      const binding = createBinding(workDir);
      const pdf = Buffer.from('%PDF-inbound');
      await processMessage(binding, 'Summarize this file', undefined, undefined, [{
        id: 'inbound-pdf',
        name: 'input.pdf',
        type: 'application/pdf',
        size: pdf.length,
        data: pdf.toString('base64'),
      }]);

      assert.ok(captured.files[0].filePath.endsWith('-input.pdf'));
      assert.ok(fs.existsSync(captured.files[0].filePath));
      assert.match(captured.prompt, /Bridge attachment context/);
      assert.ok(captured.prompt.includes(captured.files[0].filePath));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('removes expired inbound upload cache files before persisting new attachments', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-retention-'));
    const uploadDir = path.join(workDir, '.codepilot-uploads');
    fs.mkdirSync(uploadDir);
    const expiredPath = path.join(uploadDir, 'expired.txt');
    fs.writeFileSync(expiredPath, 'old');
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(expiredPath, oldDate, oldDate);
    try {
      initBridgeContext({
        store: createStore(workDir),
        llm: {
          streamChat: () => new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Done' })}\n`);
              controller.close();
            },
          }),
        },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });
      await processMessage(createBinding(workDir), 'Read this', undefined, undefined, [{
        id: 'new-file',
        name: 'new.txt',
        type: 'text/plain',
        size: 3,
        data: Buffer.from('new').toString('base64'),
      }]);
      assert.equal(fs.existsSync(expiredPath), false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('collects generated outbox files and strips the delivery marker', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-outbox-'));
    const outbox = path.join(workDir, '.codex-feishu-nsx-outbox');
    fs.mkdirSync(outbox);
    const generatedPath = path.join(outbox, 'report.pdf');
    fs.writeFileSync(generatedPath, Buffer.from('%PDF-generated'));
    try {
      initBridgeContext({
        store: createStore(workDir),
        llm: {
          streamChat: () => new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: `Report ready. [[cti-attachment:${generatedPath}]]` })}\n`);
              controller.close();
            },
          }),
        },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });

      const result = await processMessage(createBinding(workDir), 'Create a report');
      assert.equal(result.responseText, 'Report ready.');
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].name, 'report.pdf');
      assert.equal(result.attachments[0].type, 'application/pdf');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('blocks generated attachment markers that escape the outbox', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-outbox-block-'));
    const outsidePath = path.join(workDir, 'secret.txt');
    fs.writeFileSync(outsidePath, 'not for delivery');
    try {
      initBridgeContext({
        store: createStore(workDir),
        llm: {
          streamChat: () => new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: `Done [[cti-attachment:${outsidePath}]]` })}\n`);
              controller.close();
            },
          }),
        },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });

      const result = await processMessage(createBinding(workDir), 'Send a file');
      assert.equal(result.attachments.length, 0);
      assert.match(result.responseText, /outside the bridge outbox/i);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

function createBinding(workingDirectory = ''): ChannelBinding {
  return {
    id: 'binding-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    codepilotSessionId: 'session-1',
    sdkSessionId: '',
    workingDirectory,
    model: '',
    mode: 'code',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
