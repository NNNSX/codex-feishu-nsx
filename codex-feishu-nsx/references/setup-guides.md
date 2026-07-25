# Feishu Setup

## Credentials

Open the [Feishu Open Platform](https://open.feishu.cn), select the enterprise self-built app, then obtain the App ID and App Secret from Credentials & Basic Info. Treat the App Secret as sensitive.

## Phase 1: Publish The Bot

1. Enable the bot capability.
2. Add permissions needed for messages, resources, cards, and reactions:
   - `im:message`
   - `im:message:send_as_bot`
   - `im:resource`
   - `cardkit:card:write`
   - `cardkit:card:read`
   - `im:message:update`
   - `im:message.reactions:read`
   - `im:message.reactions:write_only`
3. Publish a version and complete administrator approval.

## Phase 2: Bind Long Connection Events

1. Start `codex-feishu-nsx` so its WebSocket is online.
2. Configure event subscription with long connection mode and add `im.message.receive_v1`.
3. Configure callback subscription with long connection mode and add `card.action.trigger`.
4. Publish another version and complete administrator approval.

Feishu validates the active WebSocket while saving long connection subscriptions, which is why setup uses two publish cycles.

## Access Control

`CFN_FEISHU_ALLOWED_USERS` accepts comma-separated Feishu Open IDs. Leave it unset to allow all users who can reach the bot. For personal use, set it after reading the sender Open ID from a received event or bridge log.
