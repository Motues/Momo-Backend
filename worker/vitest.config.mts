import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// wrangler.jsonc 的 assets.directory 指向 ./public —— 该目录由 CI 注入 dashboard 产物，
// 本地全新克隆时并不存在，而 vitest-pool-workers 在启动 miniflare 时就会校验它。
// 这里先补上空目录，让本地 `pnpm test` 无需任何前置步骤即可运行。
mkdirSync(fileURLToPath(new URL('./public', import.meta.url)), { recursive: true });

// D1 不会自动建表：把 schemas/comment.sql 作为绑定注入测试环境
// （测试代码跑在 workerd 里，用不了 node:fs，因此在这里读文件）。
//
// 这里按 `;` 切成单条语句后注入，而不是整份 SQL：
// pool 里的 D1 `exec()` 无法处理多行 CREATE TABLE，会报 "incomplete input"。
// 用例中这样建表：
//   const stmts = (env as any).TEST_SCHEMA_STATEMENTS as string[];
//   for (const s of stmts) await env.MOMO_DB.prepare(s).run();
const schemaStatements = readFileSync(
	new URL('./schemas/comment.sql', import.meta.url),
	'utf-8'
)
	.split('\n')
	.filter((line) => !line.trim().startsWith('--'))
	.join('\n')
	.split(';')
	.map((s) => s.trim())
	.filter((s) => s.length > 0);

// wrangler.jsonc 的 assets.run_worker_first 是「先交给 Worker、不交给静态资源层」的路由白名单。
// 漏掉 /health 时，线上 GET /health 会被 not_found_handling 的 SPA 回退吞成 index.html
// （200 + HTML），探针失效；而 vitest-pool-workers 根本不经过 assets 层，单元测试发现不了，
// 所以在这里（Node 侧、加载配置时）直接把白名单钉住，避免再漏。
const wranglerSource = readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf-8');
const runWorkerFirstMatch = wranglerSource.match(/"run_worker_first"\s*:\s*\[([^\]]*)\]/);
const runWorkerFirst = runWorkerFirstMatch
	? [...runWorkerFirstMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
	: [];
for (const required of ['/api/*', '/admin/*', '/health']) {
	if (!runWorkerFirst.includes(required)) {
		throw new Error(
			`wrangler.jsonc 的 assets.run_worker_first 缺少 ${required}：` +
				'不在该列表的路由会先被静态资源层处理（SPA 回退成 index.html），Worker 里的同名路由不会执行'
		);
	}
}

export default defineWorkersConfig({
	resolve: {
		alias: {
			// 真实 nodemailer@8 依赖 node:http/https/net，pool 的模块加载器无法解析；
			// 用测试替身替换模块本身，详见 test/stubs/nodemailer.ts
			nodemailer: fileURLToPath(new URL('./test/stubs/nodemailer.ts', import.meta.url)),
		},
	},
	// 生产代码里的 hashwx.ts 静态导入 ../../vendor/hashwx/hashwx.wasm（wrangler 的 CompiledWasm 规则）。
	// vitest-pool-workers 在本地无法加载 .wasm 模块（相对 specifier 会被解析到 vite-node 包目录下，
	// 报 ".../vite-node/vendor/hashwx.wasm?mf_vitest_force=CompiledWasm"），
	// 因此测试用 vi.mock 整体替换 hashwx 模块，见 test/helpers/hashwxMock.ts。
	test: {
		include: ['test/**/*.test.ts'],
		setupFiles: ['./test/helpers/hashwxMock.ts'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					// 测试用绑定：与 wrangler.jsonc 中（默认注释掉的）生产绑定同名，
					// 由 miniflare 在本地提供内存版 D1 与 KV
					d1Databases: ['MOMO_DB'],
					kvNamespaces: ['MOMO_AUTH_KV'],
					bindings: {
						TEST_SCHEMA_STATEMENTS: schemaStatements,
					},
				},
			},
		},
	},
});
