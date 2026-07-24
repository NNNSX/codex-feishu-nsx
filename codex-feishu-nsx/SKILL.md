---
name: codex-feishu-nsx
description: Bridge this local Codex session to Feishu/Lark for phone-based chat, streaming replies, tool progress, and file transfer. Use when setting up, starting, stopping, checking, reconfiguring, upgrading, or diagnosing the codex-feishu-nsx bridge; when the user says 飞书桥接、连接飞书、启动桥接、停止桥接、查看日志、诊断、配置; or when Feishu messages, cards, images, files, permissions, or Codex responses are not working.
---

# Codex Feishu NSX

Manage the Codex-only, Feishu-only bridge installed at `~/.codex/skills/codex-feishu-nsx`.
Store user data in `~/.codex-feishu-nsx`. Never print secrets; show only the last four characters when confirmation is necessary.

## Route The Request

- `setup`, `配置`, `连接飞书`: configure and validate Feishu.
- `start`, `启动`: start the daemon.
- `stop`, `停止`: stop the daemon.
- `status`, `状态`: report process and connection state.
- `logs [N]`, `日志`: show the last N masked log lines; default to 50.
- `reconfigure`, `修改配置`: update selected configuration values atomically.
- `doctor`, `诊断`, `没反应`, `报错`: run diagnostics and inspect logs.

## Resolve Paths

Set `SKILL_DIR` to the directory containing this file. Prefer `~/.codex/skills/codex-feishu-nsx`; if absent, locate `**/codex-feishu-nsx/SKILL.md` and derive the directory.
Use `~/.codex-feishu-nsx/config.env` unless `CFN_HOME` explicitly overrides the data directory.

## Configure

Before collecting credentials, read [setup-guides.md](references/setup-guides.md). Collect only:

1. Feishu App ID.
2. Feishu App Secret.
3. Feishu domain, default `https://open.feishu.cn`.
4. Optional allowed user Open IDs.
5. Codex working directory, model override, and mode (`code`, `plan`, or `ask`).

Write `config.env` with `CFN_*` keys from `config.env.example`. Do not write `CTI_*`, Claude/Anthropic settings, runtime selectors, or non-Feishu channel settings. Create `data`, `data/messages`, `data/job-files`, `logs`, and `runtime` under the data directory.

After writing, validate credentials using [token-validation.md](references/token-validation.md). Explain the two Feishu publish phases from the setup guide when the app is new or permissions changed.

## Operate

Before `start`, require `config.env`. Detect the host OS and use the matching command.

On Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SKILL_DIR\scripts\daemon.ps1" start
```

On macOS or Linux:

```bash
sh "$SKILL_DIR/scripts/daemon.sh" start
```

Use the same platform command with `stop`, `status`, `logs N`, `install-service`, or `uninstall-service`. Windows service installation prefers NSSM; WinSW requires the explicit `CFN_ALLOW_PLAINTEXT_SERVICE_PASSWORD=true` opt-in because its XML contains the Windows service password. macOS uses a user LaunchAgent. Linux uses a systemd user service; it starts at user login unless linger is enabled by the OS administrator.

Run diagnostics on Windows with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SKILL_DIR\scripts\doctor.ps1"
```

Run diagnostics on macOS or Linux with:

```bash
node "$SKILL_DIR/scripts/doctor.mjs"
```

For `reconfigure`, read the current file, show non-secret values plus masked secrets, update only requested fields through a temporary file and atomic rename, validate changed credentials, then restart the daemon.

## Diagnose

Run the platform-appropriate doctor command above, then inspect 100 recent log lines. Read [troubleshooting.md](references/troubleshooting.md) for symptom-specific checks.

Codex `code` mode uses `workspace-write`; `plan` and `ask` use `read-only`. `CFN_CODEX_SANDBOX_MODE` may explicitly override this with `read-only` or `workspace-write`. Do not enable unrestricted filesystem access as a workaround.

Codex SDK approval requests cannot currently pause and resume through Feishu. Workspace writes normally proceed in `code` mode; operations needing privileges beyond the configured sandbox are denied and must be retried locally with approval. Do not claim that a Feishu permission card can resume a native Codex approval.

## Preserve Data

- Keep credentials in `~/.codex-feishu-nsx/config.env` with restricted permissions.
- Keep generated outbound files in `<working-directory>/.codex-feishu-nsx-outbox`.
- Preserve session data during upgrades unless the user explicitly asks to reset it.
- Preserve `data/inbox.json`, `data/jobs.json`, and `data/job-files`; they provide crash recovery and delivery retries.
- Rebuild with `npm run build` after source changes and restart the daemon.

## Recover Tasks

The bridge durably records inbound messages before queueing them and records Codex results before Feishu delivery. It retries pending outbound text and files after network recovery and process restart.

Do not automatically rerun a task that was interrupted while Codex was executing; it may already have produced side effects. Tell the user to send `/retry last` or `/retry <task_id>` after reviewing the task. Use `/status [task_id]` to inspect durable state. Read [troubleshooting.md](references/troubleshooting.md) when recovery is not progressing.
