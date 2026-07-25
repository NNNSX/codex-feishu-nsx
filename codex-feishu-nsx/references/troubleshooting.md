# Troubleshooting

## Daemon Does Not Start

- Confirm Node.js 20+, Codex CLI, and `@openai/codex-sdk` are available.
- Confirm `~/.codex-feishu-nsx/config.env` contains both Feishu credentials.
- Rebuild with `npm run build`, then start again.
- Remove a stale PID file only after confirming that process is not running.

## Feishu Receives Nothing

- Confirm the WebSocket log reports ready.
- Confirm `im.message.receive_v1` uses long connection mode.
- Confirm the latest app version is published and approved.
- Confirm the sender Open ID is allowed when `CFN_FEISHU_ALLOWED_USERS` is set.

## Cards Or Buttons Fail

- Add `cardkit:card:write`, `cardkit:card:read`, and `im:message:update`.
- Add the `card.action.trigger` callback in long connection mode.
- Republish and restart the bridge.

## Files Or Images Fail

- Confirm `im:resource` permission is approved.
- Keep each file at or below 30 MB; generated images must be at or below 10 MB.
- Confirm Codex `code` mode is using `workspace-write` and the working directory is correct.

## Approval Is Required

Codex SDK does not expose a resumable native approval event to this bridge. The denied action must be approved and retried from a local Codex session. Keep routine writes inside the configured working directory so they can run under `workspace-write`.

## Network Or Process Interruption

- A message accepted into `data/inbox.json` is restored after restart.
- A completed Codex result in `data/jobs.json` is retried until Feishu accepts its text and files.
- A job left in `received` or `running` is marked `interrupted` after restart. It is not rerun automatically because the original task may have side effects.
- Use `/status` for the latest task, `/status <task_id>` for details, and `/retry last` or `/retry <task_id>` for an explicit rerun.
- Keep `data/job-files` with `jobs.json`; deleting either can make attachment recovery impossible.

## Service Restarts

- Windows: install WinSW or NSSM, then run `daemon.ps1 install-service`.
- macOS: run `sh scripts/daemon.sh install-service` to install a user LaunchAgent.
- Linux: run `sh scripts/daemon.sh install-service` to install a systemd user service. User services normally start after login; an administrator can enable lingering when boot-before-login behavior is required.
