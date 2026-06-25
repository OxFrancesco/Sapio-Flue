# Sapio Flue Teacher

Cloudflare-targeted Flue agent that gives a PI-powered agent access to Matt Pocock's `teach` skill.

## What is wired

- Flue source layout: `src/`
- Agent: `src/agents/teacher.ts`
- Skill: `.agents/skills/teach/SKILL.md`, installed with `npx skills add https://github.com/mattpocock/skills --skill teach`
- Models: workspace switching between `zai/glm-5.2`, `openai-codex/gpt-5.5`, and OpenAI BYOK
- Convex workspaces:
  - Telegram users are upserted from Telegram `from` identity.
  - Private chats get a personal workspace.
  - Telegram groups/topics get a shared workspace so friends collaborate in the same study context.
  - Invite codes let users join and switch a Telegram conversation to an existing workspace.
- Stripe subscriptions:
  - `/billing` creates a workspace checkout session.
  - Stripe webhooks update Convex workspace plans.
  - Free workspaces are blocked from platform-hosted models until they subscribe or switch to BYOK.
- Runtime primitives: Cloudflare Workers, Durable Objects, and WorkOS Vault when configured
- Hosted teaching pages: generated `lessons/`, `reference/`, and `assets/` files can be published to Cloudflare and served from `/teach/<session-share-id>/...`
- Optional workspace sandbox: Cloudflare Shell durable Workspace via `src/sandboxes/cloudflare-shell.ts` when a `LOADER` Worker Loader binding is configured
- Auth bridge:
  - `src/app.ts` exposes protected admin seed/status routes and mounts Flue.
  - `src/cloudflare.ts` exports `CodexAuthVault`, a Durable Object that reads PI OAuth credentials from WorkOS Vault when `WORKOS_API_KEY` is configured, or from Durable Object storage otherwise.
  - `src/cloudflare.ts` also exports `WorkspaceCredentialVault`, which stores workspace model API keys in WorkOS Vault when configured, or Durable Object storage otherwise.
  - `src/auth/` contains shared credential validation and provider setup.
- Telegram:
  - `src/channels/telegram.ts` exposes `POST /channels/telegram/webhook`.
  - Incoming Telegram messages dispatch to the shared workspace `teacher` agent instance when Convex is configured, or to the chat/topic instance otherwise.
  - The agent gets a scoped `post_telegram_message` tool with a per-turn reply target so shared workspace sessions can still answer in the active Telegram conversation.
  - `/workspace`, `/billing`, `/invite`, `/join`, `/members`, `/model`, `/key`, `/codex`, `/new`, `/session`, `/pages`, and `/help` are handled directly by the bot.

## Convex workspaces

Install/deploy Convex, then set one shared service token in both Convex and the Worker:

```bash
npx convex dev
npx convex deploy

export TELEGRAM_WORKER_TOKEN="$(openssl rand -hex 32)"
npx convex env set TELEGRAM_WORKER_TOKEN "$TELEGRAM_WORKER_TOKEN"
printf "%s" "$TELEGRAM_WORKER_TOKEN" | npx wrangler secret put CONVEX_SERVICE_TOKEN
```

Set `CONVEX_URL` on the Worker to your Convex deployment URL, for example:

```bash
printf "https://<your-deployment>.convex.cloud" | npx wrangler secret put CONVEX_URL
```

For local development, add these to `.dev.vars`:

```bash
CONVEX_URL="https://<your-deployment>.convex.cloud"
CONVEX_SERVICE_TOKEN="same-value-as-TELEGRAM_WORKER_TOKEN"
```

The Convex functions are token-guarded because Telegram ids are not enough to secure public Convex endpoints. `TELEGRAM_WORKER_TOKEN` in Convex must match `CONVEX_SERVICE_TOKEN` in the Worker; otherwise user, workspace, billing, and credential metadata calls fail closed.

Convex stores user/workspace/member/model/billing metadata only. Raw OpenAI API keys go through `WorkspaceCredentialVault`: WorkOS Vault when `WORKOS_API_KEY` is configured, otherwise Durable Object storage.

## Stripe billing

Create recurring Stripe Price IDs for your Pro and Team workspace plans, then configure the Worker:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRO_PRICE_ID
npx wrangler secret put STRIPE_TEAM_PRICE_ID
```

For local development, add these to `.dev.vars`:

```bash
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRO_PRICE_ID="price_..."
STRIPE_TEAM_PRICE_ID="price_..."
```

Register the webhook endpoint in Stripe:

```txt
https://sapio-flue-teacher.<your-subdomain>.workers.dev/billing/stripe/webhook
```

Subscribe to at least these event types:

```txt
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

From Telegram, workspace owners/admins can use `/billing`, `/billing pro`, or `/billing team`. Checkout metadata carries the Convex workspace and user ids; the webhook verifies the Stripe signature before updating Convex. Platform-hosted ZAI/Codex models require a paid workspace plan. OpenAI BYOK remains available through `/key openai <api-key> [model]`.

## Codex auth setup

Set Cloudflare secrets for deployed Workers:

```bash
npx wrangler secret put WORKOS_API_KEY
npx wrangler secret put CODEX_AUTH_ADMIN_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET_TOKEN
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
npx wrangler secret put ZAI_API_KEY
npx wrangler secret put CONVEX_URL
npx wrangler secret put CONVEX_SERVICE_TOKEN
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRO_PRICE_ID
npx wrangler secret put STRIPE_TEAM_PRICE_ID
```

`WORKOS_API_KEY` is recommended but optional. Without it, the Codex OAuth credentials are stored in the `CodexAuthVault` Durable Object storage.

For local development, put the same names in `.dev.vars`:

```bash
WORKOS_API_KEY="sk_..."
CODEX_AUTH_ADMIN_TOKEN="local-admin-token"
TELEGRAM_BOT_TOKEN="123456:telegram-bot-token"
TELEGRAM_WEBHOOK_SECRET_TOKEN="letters_numbers_underscores_or_hyphens"
TELEGRAM_ALLOWED_USER_IDS="123456789"
ZAI_API_KEY="zai-api-key"
CONVEX_URL="https://<your-deployment>.convex.cloud"
CONVEX_SERVICE_TOKEN="same-value-as-TELEGRAM_WORKER_TOKEN"
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRO_PRICE_ID="price_..."
STRIPE_TEAM_PRICE_ID="price_..."
```

From Telegram, send `/codex` and tap **Open Codex login**. The bot creates a short-lived browser login link, shows the OpenAI code, and stores the credentials automatically after approval.

The protected admin login route is still available as a fallback:

```txt
https://sapio-flue-teacher.<your-subdomain>.workers.dev/admin/codex-auth/login?admin_token=<CODEX_AUTH_ADMIN_TOKEN>
```

Both paths use the PI/OpenAI Codex OAuth credential shape and store the OAuth credentials for the Worker.

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
/model zai    Switch this workspace to ZAI GLM-5.2 Max.
/model codex  Switch this workspace to Codex GPT-5.5.
/model openai Switch this workspace to OpenAI BYOK after /key setup.
/workspace    Show the active study workspace.
/billing      Subscribe for platform-hosted models.
/members      Show workspace members.
/invite       Create an invite code for the active workspace.
/join <code>  Join a workspace and make it active in this Telegram conversation.
/key openai <api-key> [model]
              Store a workspace OpenAI key and switch the workspace to OpenAI BYOK.
/new          Start a clean session with the current model.
/new zai      Start a clean session on ZAI GLM-5.2 Max.
/session      Show the current session id and model.
/pages        Show the Cloudflare-hosted lesson index for this session.
/pages <url|share-id|session-id>
              Show the Cloudflare-hosted lesson index for a referenced session.
/whoami       Show your Telegram user id.
/help         Show command help.
```

With Convex configured, every Telegram user is signed in from Telegram profile data on each message. Private chats get a personal workspace by default. Telegram groups, topics, and joined invite codes use a shared study workspace, so members share the same durable teacher session, model selection, hosted lesson page index, and billing/BYOK settings. `/new` starts a clean shared workspace session; old session history and hosted pages remain durable but stop being used for new prompts.

The bot stores Telegram chat-to-workspace routing plus the current workspace session id in the `TelegramBotState` Durable Object. Without Convex, the same state falls back to one session per Telegram chat/topic.

To make the bot answer only to you, leave `TELEGRAM_ALLOWED_USER_IDS` unset at first, message `/whoami` to the bot, then set the returned numeric user id as a Worker secret:

```bash
printf "123456789" | npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS --name sapio-flue-teacher
```

Multiple users can be allowlisted with a comma-separated value. When the secret is set, messages and callbacks from all other Telegram users are ignored before command handling, draft streaming, or agent dispatch.

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

Use `/pages` in Telegram to get the index URL for the current workspace session. Starting a new session with `/new` creates a new page index for that workspace.

The teacher agent can automatically list pages it published in the current session. To let it use pages from another session, reference a hosted `/teach/<share-id>` URL, a 32-character share id, or a same-workspace session id in your message. The agent has a dedicated `inspect_teaching_page_reference` tool for those explicit references, and it is instructed not to search unrelated sessions without one.

Deploy with the generated Wrangler config:

```bash
npm run build
npx wrangler deploy --config dist/sapio_flue_teacher/wrangler.json
```
