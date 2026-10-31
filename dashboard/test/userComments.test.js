import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';

const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import UserComments from '../src/views/UserComments.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

const ModalStub = defineComponent({
	name: 'CommentDetailModal',
	props: { visible: { type: Boolean, default: false }, comment: { type: Object, default: () => ({}) } },
	emits: ['close', 'update', 'delete', 'edit', 'view-user'],
	template: '<div />',
});

const makeComment = (overrides = {}) => ({
	id: 1,
	ipAddress: '203.0.113.9',
	pubDate: '2024-05-06T07:08:09.000Z',
	contentText: '这是一条测试评论',
	status: 'pending',
	postSlug: 'hello-world',
	os: 'Windows',
	browser: 'Chrome',
	...overrides,
});

const makeUser = (overrides = {}) => ({
	author: '张三',
	email: 'zhangsan@example.com',
	emailVerified: true,
	blacklisted: false,
	commentCount: 3,
	approvedCount: 1,
	pendingCount: 1,
	deletedCount: 1,
	lastCommentDate: '2024-05-06T07:08:09.000Z',
	url: 'https://zhangsan.example.com',
	urlDormant: true,
	...overrides,
});

const mountPage = async ({ users = [makeUser()], comments = [makeComment()] } = {}) => {
	requestMock.get.mockImplementation((url) => {
		if (url === '/admin/stats/users') {
			return Promise.resolve({ code: 200, data: { users, pagination: { page: 1, limit: 20, totalPage: 1 } } });
		}
		return Promise.resolve({
			code: 200,
			data: { comments, pagination: { page: 1, limit: 10, totalPage: 1 } },
		});
	});
	requestMock.put.mockResolvedValue({ code: 200 });

	const router = await createTestRouter('/user-comments');
	await router.push({
		path: '/user-comments',
		query: { author: '张三', email: 'zhangsan@example.com' },
	});
	const wrapper = mount(UserComments, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub, CommentDetailModal: ModalStub } },
	});
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

describe('UserComments - 用户概要卡片', () => {
	it('展示邮箱验证、评论统计、最后评论与网站链接状态', async () => {
		const wrapper = await mountPage();

		const summary = wrapper.get('[data-test="user-summary"]');
		expect(summary.text()).toContain('邮箱已验证');
		expect(summary.text()).toContain('共 3 条');
		expect(summary.text()).toContain('已通过 1');
		expect(summary.text()).toContain('待审核 1');
		expect(summary.text()).toContain('已删除 1');
		expect(summary.text()).toContain('休眠');
		expect(summary.get('a').attributes('href')).toBe('https://zhangsan.example.com');
	});

	it('按邮箱精确匹配概要：列表里没有该用户时降级，不报错', async () => {
		const wrapper = await mountPage({ users: [] });
		// 概要卡片仍在，只是没有统计徽章
		expect(wrapper.find('[data-test="user-summary"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('zhangsan@example.com');
		expect(wrapper.text()).not.toContain('共 3 条');
	});

	it('已拉黑用户展示拉黑徽章', async () => {
		const wrapper = await mountPage({ users: [makeUser({ blacklisted: true })] });
		expect(wrapper.get('[data-test="user-summary"]').text()).toContain('已拉黑');
	});
});

describe('UserComments - 详情弹窗昵称跳转', () => {
	it('弹窗里点击昵称后跳到对应用户的评论页', async () => {
		const wrapper = await mountPage();
		const modal = wrapper.findComponent(ModalStub);
		modal.vm.$emit('view-user', { author: '李四', email: 'lisi@example.com' });
		await flushPromises();

		const route = wrapper.vm.$router.currentRoute.value;
		expect(route.path).toBe('/user-comments');
		expect(route.query).toEqual({ author: '李四', email: 'lisi@example.com' });
	});
});

describe('UserComments - 批量审核', () => {	it('全选后批量通过：逐条调用单条接口并刷新列表与概要', async () => {
		const wrapper = await mountPage({
			comments: [makeComment({ id: 1 }), makeComment({ id: 2, contentText: '第二条' })],
		});
		const getCallsBefore = requestMock.get.mock.calls.length;

		await wrapper.get('[data-test="user-comments-select-all"]').trigger('change');
		expect(wrapper.get('[data-test="batch-count"]').text()).toBe('2');

		await wrapper.get('[data-test="batch-approve"]').trigger('click');
		await flushPromises();
		await flushPromises();

		expect(requestMock.put.mock.calls.map((call) => call[0])).toEqual([
			'/admin/comments/status?id=1&status=approved',
			'/admin/comments/status?id=2&status=approved',
		]);
		expect(toastMock.success).toHaveBeenCalledWith('已通过 2 条');
		// 刷新列表 + 概要
		expect(requestMock.get.mock.calls.length).toBeGreaterThan(getCallsBefore);
		// 全部成功后勾选清空
		expect(wrapper.find('[data-test="batch-action-bar"]').exists()).toBe(false);
	});

	it('删除/打回待审的确认文案提示会级联到回复', async () => {
		const wrapper = await mountPage();
		await wrapper.get('[data-test="user-comments-select-all"]').trigger('change');
		await wrapper.get('[data-test="batch-delete"]').trigger('click');
		await flushPromises();

		expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('连同这些评论下的所有回复一起生效'));
	});

	it('部分失败时只保留失败项的勾选，并提示失败数量', async () => {
		const wrapper = await mountPage({
			comments: [makeComment({ id: 1 }), makeComment({ id: 2 })],
		});
		// 注意：mount 辅助函数会重置 put 的默认实现，失败注入必须放在挂载之后
		requestMock.put.mockImplementation(async (url) => {
			if (url.includes('id=2')) throw new Error('boom');
			return { code: 200 };
		});

		await wrapper.get('[data-test="user-comments-select-all"]').trigger('change');
		await wrapper.get('[data-test="batch-approve"]').trigger('click');
		await flushPromises();
		await flushPromises();

		expect(toastMock.success).toHaveBeenCalledWith('已通过 1 条，1 条失败');
		expect(wrapper.get('[data-test="batch-count"]').text()).toBe('1');
	});
});
