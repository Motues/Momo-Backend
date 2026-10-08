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

export default defineWorkersConfig({
	resolve: {
		alias: {
			// 真实 nodemailer@8 依赖 node:http/https/net，pool 的模块加载器无法解析；
			// 用测试替身替换模块本身，详见 test/stubs/nodemailer.ts
			nodemailer: fileURLToPath(new URL('./test/stubs/nodemailer.ts', import.meta.url)),
		},
	},
	test: {
		include: ['test/**/*.test.ts'],
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
