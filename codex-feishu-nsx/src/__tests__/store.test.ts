import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cfn-store-'));
process.env.CFN_HOME = testHome;

const { JsonFileStore } = await import('../store.js');

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('JsonFileStore recovery data', () => {
  it('persists inbound messages and attachment bytes across instances', () => {
    const first = new JsonFileStore(new Map());
    assert.equal(first.enqueueInboundMessage({
      messageId: 'om_test_inbound',
      address: { channelType: 'feishu', chatId: 'oc_test', userId: 'ou_test' },
      text: 'inspect this',
      timestamp: 1,
      attachments: [{
        id: 'file-1',
        name: 'sample.txt',
        type: 'text/plain',
        size: 5,
        data: Buffer.from('hello').toString('base64'),
      }],
    }), true);

    const second = new JsonFileStore(new Map());
    const restored = second.listInboundMessages('feishu');
    assert.equal(restored.length, 1);
    assert.equal(Buffer.from(restored[0].attachments![0].data, 'base64').toString(), 'hello');
    second.removeInboundMessage('om_test_inbound');
    assert.equal(new JsonFileStore(new Map()).listInboundMessages('feishu').length, 0);
  });

  it('persists job state and generated attachments without embedding base64 in jobs.json', () => {
    const store = new JsonFileStore(new Map());
    const timestamp = new Date().toISOString();
    store.upsertBridgeJob({
      id: 'om_test_job',
      channelType: 'feishu',
      chatId: 'oc_test',
      sessionId: 'session-test',
      requestText: 'make a file',
      inputAttachments: [],
      state: 'codex_completed',
      responseText: 'done',
      outputAttachments: [{
        id: 'output-1',
        name: 'result.txt',
        type: 'text/plain',
        size: 6,
        data: Buffer.from('result').toString('base64'),
      }],
      hasError: false,
      errorMessage: '',
      textDelivered: false,
      attachmentsDelivered: false,
      deliveryAttempts: 0,
      recoveryNoticeDelivered: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const restored = new JsonFileStore(new Map()).getBridgeJob('om_test_job');
    assert.equal(restored?.state, 'codex_completed');
    assert.ok(restored?.outputAttachments[0].filePath);
    assert.equal(restored?.outputAttachments[0].data, undefined);
    const rawLedger = fs.readFileSync(path.join(testHome, 'data', 'jobs.json'), 'utf8');
    assert.doesNotMatch(rawLedger, new RegExp(Buffer.from('result').toString('base64')));
    assert.equal(fs.readdirSync(path.join(testHome, 'data')).some((name) => name.endsWith('.tmp')), false);
  });

  it('prunes resolved permission links while retaining unresolved links', () => {
    const store = new JsonFileStore(new Map());
    store.insertPermissionLink({
      permissionRequestId: 'perm-old',
      channelType: 'feishu',
      chatId: 'oc_test',
      messageId: 'om_perm',
      toolName: 'shell',
      suggestions: '[]',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    store.insertPermissionLink({
      permissionRequestId: 'perm-new',
      channelType: 'feishu',
      chatId: 'oc_test',
      messageId: 'om_perm_2',
      toolName: 'shell',
      suggestions: '[]',
      createdAt: new Date().toISOString(),
    });
    assert.equal(store.markPermissionLinkResolved('perm-old'), true);
    assert.equal(store.prunePermissionLinks('2021-01-01T00:00:00.000Z'), 1);
    assert.equal(store.getPermissionLink('perm-old'), null);
    assert.ok(store.getPermissionLink('perm-new'));
  });

  it('does not silently treat a corrupted persistence file as empty state', () => {
    fs.writeFileSync(path.join(testHome, 'data', 'jobs.json'), '{corrupted', 'utf8');
    assert.throws(() => new JsonFileStore(new Map()), /Persistent bridge data is unreadable/);
  });
});
