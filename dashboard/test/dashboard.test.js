import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import Dashboard from '../src/views/Dashboard.vue';
import { createTestRouter, AdminLayoutStub, makeComment } from './support/harness.js';

const mountDashboard = async (comments = [makeComment({ id: 1 }), makeComment({ id: 2 })]) => {
	requestMock.get.mockResolvedValue({
		code: 200,
		data: { comments, pagination: { page: 1, limit: 10, totalPage: 1 } },
	});
	requestMock.put.mockResolvedValue({ code: 200 });

	const router = await createTestRouter('/comments');
	const wrapper = mount(Dashboard, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	await flushPromises();
	return wrapper;
};

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
	vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Dashboard - 批量审核', () => {
	it('全选批量通过：逐条调用单条接口、提示结果并刷新列表', async () => {
		const wrapper = await mountDashboard();
		const getCallsBefore = requestMock.get.mock.calls.length;

		await wrapper.get('[data-test="comments-select-all"]').trigger('change');
		await wrapper.get('[data-test="batch-approve"]').trigger('click');
		await flushPromises();
		await flushPromises();

		expect(requestMock.put.mock.calls.map((call) => call[0])).toEqual([
			'/admin/comments/status?id=1&status=approved',
			'/admin/comments/status?id=2&status=approved',
		]);
		expect(toastMock.success).toHaveBeenCalledWith('已通过 2 条');
		expect(requestMock.get.mock.calls.length).toBeGreaterThan(getCallsBefore);
		expect(wrapper.find('[data-test="batch-action-bar"]').exists()).toBe(false);
	});

	it('取消确认时不发请求、保留勾选', async () => {
		window.confirm.mockReturnValue(false);
		const wrapper = await mountDashboard();

		await wrapper.get('[data-test="comments-select-all"]').trigger('change');
		await wrapper.get('[data-test="batch-approve"]').trigger('click');
		await flushPromises();

		expect(requestMock.put).not.toHaveBeenCalled();
		expect(wrapper.get('[data-test="batch-count"]').text()).toBe('2');
	});

	it('批量删除的确认文案提示级联语义', async () => {
		const wrapper = await mountDashboard();
		await wrapper.get('[data-test="comments-select-all"]').trigger('change');
		await wrapper.get('[data-test="batch-delete"]').trigger('click');
		await flushPromises();

		expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('连同这些评论下的所有回复一起生效'));
	});

	it('部分失败时保留失败项勾选，方便重试', async () => {
		const wrapper = await mountDashboard();
		// 注意：mount 辅助函数会重置 put 的默认实现，失败注入必须放在挂载之后
		requestMock.put.mockImplementation(async (url) => {
			if (url.includes('id=2')) throw new Error('boom');
			return { code: 200 };
		});

		await wrapper.get('[data-test="comments-select-all"]').trigger('change');
		await wrapper.get('[data-test="batch-approve"]').trigger('click');
		await flushPromises();
		await flushPromises();
		await flushPromises();

		expect(toastMock.success).toHaveBeenCalledWith('已通过 1 条，1 条失败');
		expect(wrapper.get('[data-test="batch-count"]').text()).toBe('1');
	});
});

describe('Dashboard - 昵称跳转用户评论页', () => {
	it('点击评论昵称跳到 /user-comments 并携带 author + email', async () => {
		const wrapper = await mountDashboard([
			makeComment({ id: 1, author: '李四', email: 'lisi@example.com' }),
		]);

		await wrapper.get('tbody [data-test="comment-author-link"]').trigger('click');
		await flushPromises();

		const route = wrapper.vm.$router.currentRoute.value;
		expect(route.path).toBe('/user-comments');
		expect(route.query).toEqual({ author: '李四', email: 'lisi@example.com' });
		// 点击昵称不应顺带打开详情弹窗
		expect(wrapper.findComponent({ name: 'CommentDetailModal' }).props('visible')).toBe(false);
	});
});

describe('Dashboard - 按文章筛选', () => {	it('点击来源文章：请求带 postSlug、地址栏带 slug，并显示可清除的筛选 chip', async () => {
		const wrapper = await mountDashboard();

		await wrapper.get('tbody [data-test="comment-post-slug"]').trigger('click');
		await flushPromises();
		await flushPromises();

		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/comments/list', {
			params: { page: 1, postSlug: 'hello-world' },
		});
		expect(wrapper.vm.$router.currentRoute.value.query.slug).toBe('hello-world');
		expect(wrapper.text()).toContain('hello-world');
	});

	it('清除文章筛选后回到全部文章，地址栏去掉 slug', async () => {
		const wrapper = await mountDashboard();

		await wrapper.get('tbody [data-test="comment-post-slug"]').trigger('click');
		await flushPromises();
		await flushPromises();

		await wrapper.get('button[title="清除文章筛选"]').trigger('click');
		await flushPromises();
		await flushPromises();

		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/comments/list', { params: { page: 1 } });
		expect(wrapper.vm.$router.currentRoute.value.query.slug).toBeUndefined();
	});
});
