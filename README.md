# Sapio Flue Teacher

Cloudflare-targeted Flue agent that gives a PI-powered agent access to Matt Pocock's `teach` skill.

## What is wired

- Flue source layout: `src/`
- Agent: `src/agents/teacher.ts`
- Skill: `.agents/skills/teach/SKILL.md`, installed with `npx skills add https://github.com/mattpocock/skills --skill teach`
- Models: per-chat switching between `zai/glm-5.2` and `openai-codex/gpt-5.5`
- Runtime primitives: Cloudflare Workers, Durable Objects, and WorkOS Vault when configured
- Hosted teaching pages: generated `lessons/`, `reference/`, and `assets/` files can be published to Cloudflare and served from `/teach/<session-share-id>/...`
- Optional workspace sandbox: Cloudflare Shell durable Workspace via `src/sandboxes/cloudflare-shell.ts` when a `LOADER` Worker Loader binding is configured
- Auth bridge:
  - `src/app.ts` exposes protected admin seed/status routes and mounts Flue.
  - `src/cloudflare.ts` exports `CodexAuthVault`, a Durable Object that reads PI OAuth credentials from WorkOS Vault when `WORKOS_API_KEY` is configured, or from Durable Object storage otherwise.
  - `src/auth/` contains shared credential validation and provider setup.
- Telegram:
  - `src/channels/telegram.ts` exposes `POST /channels/telegram/webhook`.
  - Incoming Telegram messages dispatch to the `teacher` agent instance for that chat/topic.
  - The agent gets a scoped `post_telegram_message` tool so it can reply in the same conversation.
  - `/model`, `/new`, `/session`, `/pages`, and `/help` are handled directly by the bot.

## Codex auth setup

Set Cloudflare secrets for deployed Workers:

```bash
npx wrangler secret put WORKOS_API_KEY
npx wrangler secret put CODEX_AUTH_ADMIN_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET_TOKEN
npx wrangler secret put ZAI_API_KEY
```

`WORKOS_API_KEY` is recommended but optional. Without it, the Codex OAuth credentials are stored in the `CodexAuthVault` Durable Object storage.

For local development, put the same names in `.dev.vars`:

```bash
WORKOS_API_KEY="sk_..."
CODEX_AUTH_ADMIN_TOKEN="local-admin-token"
TELEGRAM_BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET_TOKEN="letters_numbers_underscores_or_hyphens"
ZAI_API_KEY="zai-api-key"
```

Open the deployed Codex web login route instead of creating `auth.json` locally:

```txt
https://sapio-flue-teacher.<your-subdomain>.workers.dev/admin/codex-auth/login?admin_token=<CODEX_AUTH_ADMIN_TOKEN>
```

The page starts PI/OpenAI Codex device login, sends you to OpenAI to approve the
ChatGPT Plus/Pro account, then stores the OAuth credentials for the Worker.

Check that the Vault object is configured without exposing tokens:

```bash
curl "https://sapio-flue-teacher.<your-subdomain>.workers.dev/admin/codex-auth/status?admin_token=<CODEX_AUTH_ADMIN_TOKEN>"
```

For local development without Codex auth, use the direct ZAI provider:

```bash
MODEL_SPECIFIER="zai/glm-5.2" npm run dev
```

To try the direct ZAI provider instead of Codex, set:

```bash
MODEL_SPECIFIER="zai/glm-5.2" npm run dev
```

The teacher agent requests `thinkingLevel: "xhigh"` for `zai/glm-5.2`, which maps to ZAI's max reasoning tier in Flue's catalog.

## Commands

```bash
npm run typecheck
npm run build
npm run dev
npm run deploy:dry-run
npm run deploy
```

`npm run dev` starts Flue on `http://127.0.0.1:3583`.

Interact with the agent locally:

```bash
npx flue connect teacher local
```

Or call the direct HTTP agent route:

```bash
curl http://127.0.0.1:3583/agents/teacher/demo \
  -H "Content-Type: application/json" \
  -d '{"message":"I want to learn how to design better TypeScript APIs."}'
```

The Codex model uses the ChatGPT Plus/Pro subscription behind the PI OAuth login when selected. The app never stores the access token in KV. WorkOS Vault is used when configured; otherwise the `CodexAuthVault` Durable Object stores and refreshes the OAuth credentials.

## Telegram setup

Create a bot with BotFather and use its token for `TELEGRAM_BOT_TOKEN`. Generate a separate `TELEGRAM_WEBHOOK_SECRET_TOKEN` containing only letters, numbers, underscores, or hyphens.

After deploying, register the webhook with Telegram:

```bash
export WORKER_URL="https://sapio-flue-teacher.<your-subdomain>.workers.dev"
export TELEGRAM_BOT_TOKEN="123456:telegram-bot-token"
export TELEGRAM_WEBHOOK_SECRET_TOKEN="letters_numbers_underscores_or_hyphens"

curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WORKER_URL}/channels/telegram/webhook\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET_TOKEN}\",
    \"allowed_updates\": [
      \"message\",
      \"edited_message\",
      \"channel_post\",
      \"edited_channel_post\",
      \"business_message\",
      \"edited_business_message\",
      \"callback_query\"
    ]
  }"
```

Message the bot in Telegram after `setWebhook` returns `ok: true`. Telegram cannot deliver webhooks to `127.0.0.1`; use a deployed Worker URL or a public tunnel for local testing.

Bot commands:

```txt
/model        Show the current model and available choices.
/model zai    Switch this Telegram conversation to ZAI GLM-5.2 Max.
/model codex  Switch this Telegram conversation to Codex GPT-5.5.
/new          Start a clean session with the current model.
/new zai      Start a clean session on ZAI GLM-5.2 Max.
/session      Show the current session id and model.
/pages        Show the Cloudflare-hosted lesson index for this session.
/help         Show command help.
```

The bot stores the selected model and current session id per Telegram chat/topic in the `TelegramBotState` Durable Object. A new session is implemented as a new Flue agent instance id, so old session history remains durable but stops being used.

For one-to-one chats, non-command prompts use Telegram message drafts: the bot immediately shows a native "Thinking..." draft, then previews the generated reply through draft updates before sending the final persistent message. Group, topic, direct-message, and business contexts fall back to Telegram's typing action when drafts are not supported.

Register the Telegram menu commands after deploying:

```bash
curl -X POST "${WORKER_URL}/admin/telegram/register-commands" \
  -H "Authorization: Bearer ${CODEX_AUTH_ADMIN_TOKEN}"
```

Verify the registered menu:

```bash
curl "${WORKER_URL}/admin/telegram/commands" \
  -H "Authorization: Bearer ${CODEX_AUTH_ADMIN_TOKEN}"
```

When the teach skill creates or updates HTML, the agent can call `publish_teaching_page`. Published pages are stored in the `LessonPageStore` Durable Object and served by the Worker:

```txt
https://sapio-flue-teacher.<your-subdomain>.workers.dev/teach/<session-share-id>
https://sapio-flue-teacher.<your-subdomain>.workers.dev/teach/<session-share-id>/lessons/intro.html
```

Use `/pages` in Telegram to get the index URL for the current chat/session. Starting a new session with `/new` creates a new page index.

Deploy with the generated Wrangler config:

```bash
npm run build
npx wrangler deploy --config dist/sapio_flue_teacher/wrangler.json
```
