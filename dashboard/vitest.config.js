import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
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
