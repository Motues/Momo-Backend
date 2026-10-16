import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// 与 vite.config.js 保持一致：测试环境同样注入 __APP_VERSION__，
// 否则用例里读到的是兜底值而不是真实版本号。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	plugins: [vue()],
	test: {
		environment: 'happy-dom',
		include: ['test/**/*.test.js'],
		// 路由表用动态 import 加载每个页面组件，页面数量多时首次 transform 在负载高
		// 的情况下可能超过默认的 5s，表现为「Test timed out」而非断言失败。
		// 这里给足编译时间。
		testTimeout: 30000,
		hookTimeout: 30000,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.{js,vue}'],
		},
	},
});
