import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * 应用装配级测试：用真实的 src/router 与 src/App.vue 组装，
 * 验证 router-view → 鉴权守卫 → 登录页 这条真实链路的可用性。
 */
const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import App from '../src/App.vue';
import router from '../src/router/index.js';

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
});

describe('应用装配', () => {
	it('App.vue 挂载后通过 router-view 渲染出登录页', async () => {
		const wrapper = mount(App, { global: { plugins: [router] } });
		await router.isReady();
		await flushPromises();
		expect(router.currentRoute.value.path).toBe('/login');
		expect(wrapper.text()).toContain('欢迎登录管理系统');
		expect(wrapper.find('input[placeholder="用户名"]').exists()).toBe(true);
		expect(wrapper.find('input[placeholder="密码"]').exists()).toBe(true);
		expect(wrapper.find('input[placeholder="后端 API 地址"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('未登录时访问受保护路由，最终仍停留在登录页', async () => {
		await router.push('/comments');
		const wrapper = mount(App, { global: { plugins: [router] } });
		await flushPromises();
		expect(router.currentRoute.value.path).toBe('/login');
		expect(wrapper.text()).toContain('欢迎登录管理系统');
		wrapper.unmount();
	});

	it('路由实例带有历史记录模式（非 abstract）', () => {
		expect(router.options.history.location).toBeTruthy();
		expect(router.getRoutes().length).toBeGreaterThan(0);
	});
});
