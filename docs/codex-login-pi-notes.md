# Codex Login Notes

PI reference copied from `https://github.com/earendil-works/pi/tree/main/packages/coding-agent` into `docs/pi-coding-agent`.

Upstream commit copied: `329dceb5f3806654c59343949768a2973d752036`.

## PI Flow

PI exposes `/login` from the interactive TUI. The TUI does not implement provider-specific OpenAI auth directly. It delegates to `@earendil-works/pi-ai/oauth`, then stores the returned OAuth credentials in PI auth storage.

For OpenAI Codex, PI supports two login methods:

- Browser OAuth: opens `https://auth.openai.com/oauth/authorize` with PKCE and listens locally on `http://localhost:1455/auth/callback`.
- Device code: opens `https://auth.openai.com/codex/device`, shows a user code, polls OpenAI until approval, then exchanges the returned authorization code.

The hosted Telegram bot cannot use PI's exact browser callback because the callback server in PI runs on the user's local machine. A Cloudflare Worker cannot receive `localhost:1455` callbacks from the user's browser.

## Telegram Adaptation

The bot keeps the Worker-safe device-code exchange in `CodexAuthVault`, but exposes it as a browser-first Telegram flow:

1. `/codex` starts a fresh short-lived Codex login state through the durable object.
2. Telegram sends a state-only `/codex-auth/device?state=...` browser link.
3. The browser page shows the OpenAI code, links to the Codex login page, and polls the Worker completion endpoint.
4. Once OpenAI approves the login, the durable object stores the OAuth credentials in WorkOS Vault or durable object storage and refreshes them through `@earendil-works/pi-ai/oauth`.

This keeps the PI credential shape and refresh bridge, while avoiding admin-token links or local callback assumptions in Telegram.
