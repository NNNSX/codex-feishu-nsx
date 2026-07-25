import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configToSettings, maskSecret, type Config } from '../config.js';

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
  });

  it('preserves only the final four characters', () => {
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });
});

describe('configToSettings', () => {
  const base: Config = {
    defaultWorkDir: 'D:\\codex',
    defaultMode: 'code',
  };

  it('enables only the Feishu bridge', () => {
    const settings = configToSettings(base);
    assert.equal(settings.get('remote_bridge_enabled'), 'true');
    assert.equal(settings.get('bridge_feishu_enabled'), 'true');
    assert.equal([...settings.keys()].some((key) => /telegram|discord|qq|weixin/i.test(key)), false);
  });

  it('maps Feishu credentials and defaults', () => {
    const settings = configToSettings({
      ...base,
      defaultModel: 'gpt-test',
      attachmentRetentionDays: 7,
      feishuAppId: 'app-id',
      feishuAppSecret: 'app-secret',
      feishuDomain: 'https://open.feishu.cn',
      feishuAllowedUsers: ['ou_1', 'ou_2'],
    });

    assert.equal(settings.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(settings.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(settings.get('bridge_feishu_domain'), 'https://open.feishu.cn');
    assert.equal(settings.get('bridge_feishu_allowed_users'), 'ou_1,ou_2');
    assert.equal(settings.get('bridge_default_work_dir'), 'D:\\codex');
    assert.equal(settings.get('default_model'), 'gpt-test');
    assert.equal(settings.get('bridge_attachment_retention_days'), '7');
  });
});
