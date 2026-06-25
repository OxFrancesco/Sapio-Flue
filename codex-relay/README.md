# Codex Relay

This is a small Node relay for Codex subscription inference. It exists because the Cloudflare Worker can complete Codex OAuth login, but Cloudflare egress to `chatgpt.com` is blocked.

The Worker keeps Telegram, OAuth, refresh tokens, and Durable Objects. The relay only receives a per-request Codex bearer token from the Worker, forwards `/codex/responses` to `https://chatgpt.com/backend-api/codex/responses`, and streams the response back.

## Environment

```sh
CODEX_RELAY_TOKEN=long-random-shared-secret
PORT=8788
CODEX_UPSTREAM_BASE_URL=https://chatgpt.com/backend-api
CODEX_RELAY_MAX_BODY_BYTES=26214400
```

`CODEX_RELAY_TOKEN` must match the Worker's `CODEX_RELAY_TOKEN` secret. Do not log request bodies or `Authorization` headers.

## Local

```sh
npm run relay:build
CODEX_RELAY_TOKEN=dev-secret npm run relay:start
curl http://localhost:8788/health
```

## Deploy

Deploy this service on a non-Cloudflare Node runtime such as Fly.io, Render, Railway, or any Docker host.

After deployment, configure the Worker:

```sh
wrangler secret put CODEX_RELAY_TOKEN --config dist/sapio_flue_teacher/wrangler.json
wrangler deploy --config dist/sapio_flue_teacher/wrangler.json \
  --var CODEX_RELAY_BASE_URL:https://your-relay.example.com
```

If using a custom domain, keep it DNS-only. Do not proxy it through Cloudflare, or the request path can hit the same egress block again.
