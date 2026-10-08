import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	plugins: [svelte({ compilerOptions: { css: 'injected' } })],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
		// Svelte 5 通过 package exports 的 browser 条件暴露客户端实现
		conditions: ['browser'],
	},
	test: {
		environment: 'happy-dom',
		// 注意：`test/` 目录被 .gitignore 忽略（里面是手动调试页 index.html），
		// 所以 vitest 用例放在不会被忽略的 `tests/` 目录
		include: ['tests/**/*.test.js'],
		// 组件用例需要先编译 Svelte 组件（含 marked / DOMPurify），
		// 负载高时首次 transform 可能超过默认的 5s；给足编译时间，避免误报超时
		testTimeout: 30000,
		hookTimeout: 30000,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.{js,ts,svelte}'],
		},
	},
});
