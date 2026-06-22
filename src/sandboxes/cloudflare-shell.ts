// flue-blueprint: sandbox/cloudflare-shell@1
import {
	DynamicWorkerExecutor,
	type DynamicWorkerExecutorOptions,
	type ResolvedProvider,
	resolveProvider,
} from '@cloudflare/codemode';
import {
	type FsStat as CfFsStat,
	STATE_TYPES,
	Workspace,
	WorkspaceFileSystem,
} from '@cloudflare/shell';
import { stateTools } from '@cloudflare/shell/workers';
import type {
	FileStat,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
	ShellResult,
} from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';

export interface GetShellSandboxOptions {
	workspace: Workspace;
	loader: WorkerLoader;
	executor?: Pick<DynamicWorkerExecutorOptions, 'timeout' | 'globalOutbound' | 'modules'>;
}

export function getShellSandbox(options: GetShellSandboxOptions): SandboxFactory {
	if (!options?.workspace) {
		throw new Error(
			'[flue] getShellSandbox requires a workspace. Pass `getDefaultWorkspace()` for the common case, ' +
				'or construct your own with `new Workspace({ sql: ctx.storage.sql, ... })`.',
		);
	}
	if (!options.loader) {
		throw new Error(
			'[flue] getShellSandbox requires a WorkerLoader binding. Add this to your wrangler.jsonc:\n' +
				'  { "worker_loaders": [{ "binding": "LOADER" }] }\n' +
				'Then pass `loader: env.LOADER` to getShellSandbox(). Worker Loader is currently in beta — ' +
				'see https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/.',
		);
	}

	const { workspace, loader, executor: executorOptions } = options;
	const fs = new WorkspaceFileSystem(workspace);
	const executor = new DynamicWorkerExecutor({
		loader,
		...executorOptions,
	});
	const stateProvider = resolveProvider(stateTools(workspace));
	const toolFactory: SessionToolFactory = () => [createCodeTool(executor, stateProvider)];

	return {
		async createSessionEnv() {
			return createWorkspaceSessionEnv(workspace, fs, '/');
		},
		tools: toolFactory,
	};
}

function normalizePath(p: string): string {
	const parts = p.split('/');
	const result: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') result.pop();
		else result.push(part);
	}
	return `/${result.join('/')}`;
}

function createWorkspaceSessionEnv(
	workspace: Workspace,
	fs: WorkspaceFileSystem,
	cwd: string,
): SessionEnv {
	const normalizedCwd = normalizePath(cwd);
	const resolvePath = (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (normalizedCwd === '/') return normalizePath(`/${p}`);
		return normalizePath(`${normalizedCwd}/${p}`);
	};
	const exec = (): Promise<ShellResult> => {
		throw new Error(EXEC_NOT_SUPPORTED_MESSAGE);
	};

	return {
		exec,
		async readFile(path: string): Promise<string> {
			return fs.readFile(resolvePath(path));
		},
		async readFileBuffer(path: string): Promise<Uint8Array> {
			return fs.readFileBytes(resolvePath(path));
		},
		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			const resolved = resolvePath(path);
			const write = async (): Promise<void> => {
				if (typeof content === 'string') await workspace.writeFile(resolved, content);
				else await workspace.writeFileBytes(resolved, content);
			};
			try {
				await write();
			} catch {
				const parent = resolved.slice(0, resolved.lastIndexOf('/')) || '/';
				try {
					await fs.mkdir(parent, { recursive: true });
				} catch {}
				await write();
			}
		},
		async stat(path: string): Promise<FileStat> {
			return adaptStat(await fs.stat(resolvePath(path)));
		},
		async readdir(path: string): Promise<string[]> {
			return fs.readdir(resolvePath(path));
		},
		async exists(path: string): Promise<boolean> {
			return fs.exists(resolvePath(path));
		},
		async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
			await fs.mkdir(resolvePath(path), opts);
		},
		async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
			await fs.rm(resolvePath(path), opts);
		},
		cwd: normalizedCwd,
		resolvePath,
	};
}

const EXEC_NOT_SUPPORTED_MESSAGE =
	"[flue] The Cloudflare Shell sandbox does not support exec(). The agent's `code` tool runs JavaScript " +
	'in an isolated Worker against the workspace. From application code, use `session.fs` or `harness.fs` ' +
	'for file operations. Use `@cloudflare/sandbox` instead when the agent needs bash, grep, git, or a real Linux environment.';

function adaptStat(s: CfFsStat): FileStat {
	return {
		isFile: s.type === 'file',
		isDirectory: s.type === 'directory',
		isSymbolicLink: s.type === 'symlink',
		size: s.size,
		mtime: s.mtime,
	};
}

const CodeParams = {
	type: 'object',
	properties: {
		code: {
			type: 'string',
			description:
				'A single async arrow function with the signature `async () => { ... return result; }`. ' +
				'Inside the body, call `state.*` to operate on the workspace. The function executes in an isolated Worker. ' +
				'Return a JSON-serializable value to send it back as the tool result.',
		},
	},
	required: ['code'],
};

function createCodeTool(executor: DynamicWorkerExecutor, stateProvider: ResolvedProvider) {
	return {
		name: 'code',
		label: 'Run Code',
		description: buildCodeToolDescription(),
		parameters: CodeParams,
		async execute(_toolCallId: string, params: unknown) {
			const code = (params as { code: string }).code;
			const { result, error, logs } = await executor.execute(code, [stateProvider]);
			if (error) {
				const logsTail = logs?.length ? `\n\nlogs:\n${logs.join('\n')}` : '';
				throw new Error(`code tool failed: ${error}${logsTail}`);
			}
			const resultText = formatResult(result);
			const logsText = logs?.length ? `\n\n--- logs ---\n${logs.join('\n')}` : '';
			return {
				content: [{ type: 'text' as const, text: resultText + logsText }],
				details: logs?.length ? { logs } : {},
			};
		},
	};
}

function formatResult(result: unknown): string {
	if (result === undefined) return '(no result)';
	if (typeof result === 'string') return result;
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

function buildCodeToolDescription(): string {
	return [
		'Run JavaScript inside an isolated Worker against a durable workspace filesystem.',
		'The snippet must be a single async arrow function:',
		'',
		'  async () => {',
		'    const text = await state.readFile("/notes.md");',
		'    await state.writeFile("/notes.md", text.toUpperCase());',
		'    return { bytes: text.length };',
		'  }',
		'',
		'Rules:',
		'- Write JavaScript, not TypeScript; do not use type annotations.',
		'- Do not use import statements. Everything you need is on state.',
		'- Always return the value you want back.',
		'- For multi-file refactors, prefer state.planEdits() and state.applyEditPlan().',
		'- Network access is disabled.',
		'',
		'The state API:',
		'',
		'```typescript',
		STATE_TYPES,
		'```',
	].join('\n');
}

export function getDefaultWorkspace(): Workspace {
	const { storage } = getCloudflareContext();
	return new Workspace({ sql: storage.sql as SqlStorage });
}
