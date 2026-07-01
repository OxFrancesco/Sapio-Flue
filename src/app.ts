import { observe } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import type { PolarBillingBindingEnv } from './billing/polar';
import {
	normalizeTeachingPagePath,
	parseTeachingPagePathname,
	teachingPageIndexUrl,
	teachingPageStore,
	teachingPageUrl,
	publicBaseUrl,
	type TeachingPageBindingEnv,
	type TeachingPageRecord,
} from './teaching-pages';

interface Env extends TeachingPageBindingEnv, PolarBillingBindingEnv {
	CODEX_AUTH_VAULT?: DurableObjectNamespace;
	CODEX_AUTH_ADMIN_TOKEN?: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_COMMANDS_ADMIN_TOKEN?: string;
	TELEGRAM_ALLOWED_USER_IDS?: string;
}

const app = new Hono<{ Bindings: Env }>();

observe((event) => {
	if (!event.instanceId && !event.dispatchId) return;

	if (event.type === 'turn') {
		console.log('[flue:turn]', {
			instanceId: event.instanceId,
			dispatchId: event.dispatchId,
			turnId: event.turnId,
			error: event.error === undefined ? undefined : String(event.error),
		});
		return;
	}

	if (event.type === 'tool_start') {
		console.log('[flue:tool_start]', {
			instanceId: event.instanceId,
			dispatchId: event.dispatchId,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		});
		return;
	}

	if (event.type === 'tool') {
		console.log('[flue:tool]', {
			instanceId: event.instanceId,
			dispatchId: event.dispatchId,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		});
		return;
	}

	if (event.type === 'agent_end') {
		console.log('[flue:agent_end]', {
			instanceId: event.instanceId,
			dispatchId: event.dispatchId,
		});
	}
});

app.get('/health', (c) => c.json({ ok: true }));
app.get('/teach', (c) =>
	htmlResponse(
		`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Teaching Pages</title></head>
<body style="font:16px/1.45 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#111">
  <h1>Teaching Pages</h1>
  <p>Open a session-specific URL from Telegram, or use /pages in the bot to get the current session index.</p>
</body>
</html>`,
	),
);
app.get('/teach/*', serveTeachingPage);

app.get('/billing/polar/success', (c) =>
	htmlResponse(
		`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billing Connected</title></head>
<body style="font:16px/1.45 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#111">
  <h1>Billing connected</h1>
  <p>Your workspace subscription is being confirmed. Return to Telegram and use /workspace or /model.</p>
</body>
</html>`,
	),
);

app.get('/billing/polar/cancel', (c) =>
	htmlResponse(
		`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billing Cancelled</title></head>
<body style="font:16px/1.45 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#111">
  <h1>Billing cancelled</h1>
  <p>No subscription was created. Return to Telegram to choose BYOK or start checkout again.</p>
</body>
</html>`,
	),
);

app.get('/codex-auth/device', async (c) => {
	const state = c.req.query('state') ?? '';
	const stub = getCodexAuthVault(c.env);
	const response = await stub.fetch(
		new Request(`https://codex-auth-vault/oauth/device/status?state=${encodeURIComponent(state)}`),
	);
	if (!response.ok) {
		return htmlResponse(await errorPage('Codex login not available', await response.text()), {
			status: response.status,
		});
	}

	const start = (await response.json()) as {
		state: string;
		userCode: string;
		verificationUri: string;
		intervalSeconds: number;
		expiresAt: string;
	};

	return htmlResponse(renderCodexDeviceLoginPage(c.env, start));
});

app.post('/codex-auth/device/complete', async (c) => {
	const state = c.req.query('state') ?? '';
	const stub = getCodexAuthVault(c.env);
	const response = await stub.fetch(
		new Request(`https://codex-auth-vault/oauth/device/complete?state=${encodeURIComponent(state)}`, {
			method: 'POST',
		}),
	);
	const body = await response.text();
	return new Response(body, {
		status: response.status,
		headers: { 'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8' },
	});
});

app.post('/admin/telegram/register-commands', async (c) => {
	const auth = telegramAdminAuth(c);
	if (auth) {
		return auth;
	}
	if (!c.env.TELEGRAM_BOT_TOKEN) {
		return c.json({ error: 'TELEGRAM_BOT_TOKEN is not configured.' }, 503);
	}

	const response = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			scope: { type: 'default' },
			commands: telegramBotCommands(),
		}),
	});
	const result = (await response.json().catch(() => ({ ok: false }))) as unknown;
	if (!response.ok) {
		return jsonResponse({ error: 'Telegram command registration failed.', result }, { status: response.status });
	}

	return c.json({ ok: true, result });
});

app.get('/admin/telegram/commands', async (c) => {
	const auth = telegramAdminAuth(c);
	if (auth) {
		return auth;
	}
	if (!c.env.TELEGRAM_BOT_TOKEN) {
		return c.json({ error: 'TELEGRAM_BOT_TOKEN is not configured.' }, 503);
	}

	const response = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getMyCommands`);
	const result = (await response.json().catch(() => ({ ok: false }))) as unknown;
	if (!response.ok) {
		return jsonResponse({ error: 'Telegram command lookup failed.', result }, { status: response.status });
	}

	return c.json({ ok: true, result });
});

app.use('/admin/codex-auth/*', async (c, next) => {
	if (c.req.path.endsWith('/device/complete')) {
		await next();
		return;
	}

	const expected = c.env.CODEX_AUTH_ADMIN_TOKEN;
	if (!expected) {
		return c.json({ error: 'CODEX_AUTH_ADMIN_TOKEN is not configured.' }, 503);
	}
	if (adminToken(c) !== expected) {
		return c.json({ error: 'Unauthorized.' }, 401);
	}

	await next();
});

app.get('/admin/codex-auth/status', (c) => {
	const stub = getCodexAuthVault(c.env);
	return stub.fetch(new Request('https://codex-auth-vault/status'));
});

app.post('/admin/codex-auth/seed', async (c) => {
	const stub = getCodexAuthVault(c.env);
	const headers = new Headers({
		authorization: `Bearer ${adminToken(c)}`,
		'content-type': c.req.header('content-type') ?? 'application/json',
	});

	return stub.fetch(
		new Request('https://codex-auth-vault/seed', {
			method: 'POST',
			headers,
			body: await c.req.text(),
		}),
	);
});

app.get('/admin/codex-auth/login', async (c) => {
	const stub = getCodexAuthVault(c.env);
	const token = adminToken(c);
	const response = await stub.fetch(
		new Request('https://codex-auth-vault/oauth/device/start', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		}),
	);
	if (!response.ok) {
		return htmlResponse(await errorPage('Codex login could not start', await response.text()), {
			status: response.status,
		});
	}

	const start = (await response.json()) as {
		state: string;
		userCode: string;
		verificationUri: string;
		expiresAt: string;
	};
	const loginUrl = new URL(c.req.url);
	loginUrl.pathname = '/codex-auth/device';
	loginUrl.search = new URLSearchParams({ state: start.state }).toString();
	return c.redirect(loginUrl.toString());
});

app.get('/admin/codex-auth/device/complete', async (c) => {
	const state = c.req.query('state') ?? '';
	const stub = getCodexAuthVault(c.env);
	const response = await stub.fetch(
		new Request(`https://codex-auth-vault/oauth/device/complete?state=${encodeURIComponent(state)}`, {
			method: 'POST',
		}),
	);
	if (!response.ok) {
		return htmlResponse(await errorPage('Codex login could not complete', await response.text()), {
			status: response.status,
		});
	}

	const result = (await response.json()) as { status: 'pending' | 'complete'; expiresAt?: string };
	if (result.status === 'pending') {
		const retryUrl = new URL(c.req.url);
		return htmlResponse(
			`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Login Pending</title></head>
<body style="font:16px/1.45 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#111">
  <h1>Still waiting</h1>
  <p>Finish the OpenAI Codex device login, then retry.</p>
  <p><a href="${escapeHtml(retryUrl.toString())}">Retry completion</a></p>
</body>
</html>`,
		);
	}

	return htmlResponse(
		`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Login Complete</title></head>
<body style="font:16px/1.45 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#111">
  <h1>Codex login complete</h1>
  <p>The OAuth credentials were stored in WorkOS Vault. Current token expiry: ${escapeHtml(result.expiresAt ?? 'unknown')}.</p>
</body>
</html>`,
	);
});

app.route('/', flue());

export default app;

function getCodexAuthVault(env: Env): DurableObjectStub {
	if (!env.CODEX_AUTH_VAULT) {
		throw new Error('CODEX_AUTH_VAULT Durable Object binding is not configured.');
	}
	return env.CODEX_AUTH_VAULT.getByName('default');
}

function telegramAdminAuth(c: {
	env: Env;
	req: { header(name: string): string | undefined; query(name: string): string | undefined };
}): Response | undefined {
	const accepted = [c.env.TELEGRAM_COMMANDS_ADMIN_TOKEN, c.env.CODEX_AUTH_ADMIN_TOKEN].filter(
		(value): value is string => Boolean(value),
	);
	if (accepted.length === 0) {
		return new Response(JSON.stringify({ error: 'Telegram command admin token is not configured.' }), {
			status: 503,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	if (!accepted.includes(adminToken(c))) {
		return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
			status: 401,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}
	return undefined;
}

function telegramBotCommands(): Array<{ command: string; description: string }> {
	return [
		{ command: 'start', description: 'Start the teacher bot' },
		{ command: 'help', description: 'Show bot commands' },
		{ command: 'workspace', description: 'Show the active study workspace' },
		{ command: 'billing', description: 'Subscribe for platform models' },
		{ command: 'invite', description: 'Create a workspace invite code' },
		{ command: 'join', description: 'Join a study workspace invite' },
		{ command: 'members', description: 'Show workspace members' },
		{ command: 'model', description: 'Show or switch the workspace model' },
		{ command: 'key', description: 'Attach a workspace model API key' },
		{ command: 'codex', description: 'Connect Codex with browser login' },
		{ command: 'new', description: 'Start a clean session' },
		{ command: 'session', description: 'Show the current session' },
		{ command: 'pages', description: 'Show hosted or referenced lesson pages' },
		{ command: 'whoami', description: 'Show your Telegram user id' },
	];
}

async function serveTeachingPage(c: { req: { url: string }; env: Env }): Promise<Response> {
	const parsed = parseTeachingPagePathname(new URL(c.req.url).pathname);
	if (!parsed) {
		return htmlResponse(await errorPage('Teaching page not found', 'The teaching page URL is invalid.'), {
			status: 404,
		});
	}

	const stub = teachingPageStore(c.env, parsed.shareId);
	if (!parsed.path) {
		const response = await stub.fetch(new Request('https://lesson-page-store/index'));
		if (!response.ok) {
			return htmlResponse(await errorPage('Teaching page index error', await response.text()), {
				status: response.status,
			});
		}
		const index = (await response.json()) as {
			pages: Array<Omit<TeachingPageRecord, 'body'>>;
		};
		return htmlResponse(renderTeachingPageIndex(c.env, parsed.shareId, index.pages));
	}

	let path: string;
	try {
		path = normalizeTeachingPagePath(parsed.path);
	} catch (error) {
		return htmlResponse(
			await errorPage('Teaching page not found', error instanceof Error ? error.message : String(error)),
			{ status: 404 },
		);
	}

	const response = await stub.fetch(
		new Request(`https://lesson-page-store/page?path=${encodeURIComponent(path)}`),
	);
	if (!response.ok) {
		return htmlResponse(await errorPage('Teaching page not found', await response.text()), {
			status: response.status,
		});
	}

	const page = (await response.json()) as TeachingPageRecord;
	const headers = new Headers({
		'content-type': page.contentType,
		'cache-control': 'public, max-age=60',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		'x-robots-tag': 'noindex',
	});
	return new Response(page.body, { headers });
}

function renderTeachingPageIndex(
	env: Env,
	shareId: string,
	pages: Array<Omit<TeachingPageRecord, 'body'>>,
): string {
	const items = pages
		.map((page) => {
			const label = page.title || page.path;
			return `<li><a href="${escapeHtml(teachingPageUrl(env, shareId, page.path))}">${escapeHtml(label)}</a><br><small>${escapeHtml(page.path)} · ${escapeHtml(page.updatedAt)}</small></li>`;
		})
		.join('\n');

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Teaching Pages</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; color: #111; }
    a { color: #0b57d0; }
    ul { padding-left: 22px; }
    li { margin: 14px 0; }
    small { color: #555; }
    code { background: #f4f4f4; border-radius: 4px; padding: 2px 5px; }
  </style>
</head>
<body>
  <h1>Teaching Pages</h1>
  <p>Session index: <code>${escapeHtml(teachingPageIndexUrl(env, shareId))}</code></p>
  ${
		pages.length
			? `<ul>${items}</ul>`
			: '<p>No teaching pages have been published for this session yet.</p>'
	}
	</body>
	</html>`;
}

function renderCodexDeviceLoginPage(
	env: Env,
	start: {
		state: string;
		userCode: string;
		verificationUri: string;
		intervalSeconds: number;
		expiresAt: string;
	},
): string {
	const completeUrl = new URL('/codex-auth/device/complete', publicBaseUrl(env));
	completeUrl.searchParams.set('state', start.state);
	const intervalMs = Math.max(2, start.intervalSeconds || 5) * 1000;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Codex Login</title>
  <style>
    :root { color-scheme: light; }
    body { font: 16px/1.45 system-ui, sans-serif; max-width: 680px; margin: 48px auto; padding: 0 20px; color: #111; background: #fff; }
    h1 { font-size: 28px; line-height: 1.15; margin: 0 0 16px; }
    p { margin: 12px 0; }
    code { font-size: 30px; font-weight: 700; letter-spacing: .08em; background: #f2f2f2; padding: 12px 16px; display: inline-block; border-radius: 8px; }
    .button { display: inline-block; margin: 18px 12px 0 0; padding: 10px 14px; background: #111; color: #fff; border-radius: 6px; text-decoration: none; }
    .muted { color: #555; }
    .status { margin-top: 22px; padding: 12px 14px; border: 1px solid #ddd; border-radius: 8px; background: #fafafa; }
    .error { color: #9f1239; }
    .success { color: #166534; }
  </style>
</head>
<body>
  <h1>Login to Codex</h1>
  <p>Open the Codex login page, enter this code if asked, and approve the ChatGPT account.</p>
  <p><code>${escapeHtml(start.userCode)}</code></p>
  <p><a class="button" href="${escapeHtml(start.verificationUri)}" target="_blank" rel="noreferrer">Open Codex Login</a></p>
  <p class="muted">This code expires at ${escapeHtml(start.expiresAt)}.</p>
  <div class="status" id="status">Waiting for approval...</div>
  <script>
    const statusEl = document.getElementById('status');
    const completeUrl = ${JSON.stringify(completeUrl.toString())};
    const intervalMs = ${JSON.stringify(intervalMs)};

    async function poll() {
      try {
        const response = await fetch(completeUrl, { method: 'POST' });
        const result = await response.json().catch(() => ({}));
        if (response.ok && result.status === 'complete') {
          statusEl.className = 'status success';
          statusEl.textContent = 'Codex login complete. You can close this tab and return to Telegram.';
          return;
        }
        if (response.ok && result.status === 'pending') {
          statusEl.className = 'status';
          statusEl.textContent = 'Still waiting for approval...';
          window.setTimeout(poll, intervalMs);
          return;
        }
        statusEl.className = 'status error';
        statusEl.textContent = result.error || 'Codex login failed. Start a new login from Telegram.';
      } catch (error) {
        statusEl.className = 'status error';
        statusEl.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    window.setTimeout(poll, intervalMs);
  </script>
</body>
</html>`;
}

function adminToken(c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } }): string {
	const authorization = c.req.header('authorization');
	if (authorization?.startsWith('Bearer ')) {
		return authorization.slice('Bearer '.length);
	}
	return c.req.query('admin_token') ?? '';
}

function htmlResponse(html: string, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'text/html; charset=utf-8');
	return new Response(html, { ...init, headers });
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(JSON.stringify(value), { ...init, headers });
}

async function errorPage(title: string, detail: string): Promise<string> {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font:16px/1.45 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#111">
  <h1>${escapeHtml(title)}</h1>
  <pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px">${escapeHtml(detail)}</pre>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
