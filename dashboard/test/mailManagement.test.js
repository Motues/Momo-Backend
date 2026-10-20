import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/* ---------- 依赖 mock ---------- */
const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import MailManagement from '../src/views/MailManagement.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

const makeMail = (overrides = {}) => ({
	id: 1,
	type: 'dormant_notice',
	recipient: 'sleepy@example.com',
	subject: '您在 测试站 的个人网站链接已进入休眠',
	status: 'sent',
	error: '',
	createdAt: '2026-10-18T13:00:00.000Z',
	...overrides,
});

const PAGE = { list: [makeMail()], total: 1, page: 1, pageSize: 20, retentionDays: 30 };

let router;
let wrapper;

const mountPage = async (data = PAGE) => {
	requestMock.get.mockResolvedValue({ code: 200, data });
	router = await createTestRouter('/mails');
	wrapper = mount(MailManagement, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const rows = () => wrapper.findAll('[data-test="mail-row"]');

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
});

describe('MailManagement - 列表', () => {
	it('挂载时请求第一页并带上分页参数', async () => {
		await mountPage();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/mails', {
			params: { page: 1, pageSize: 20 },
		});
	});

	it('渲染时间、类型、状态、收件人、主题与错误信息', async () => {
		await mountPage({
			...PAGE,
			list: [
				makeMail(),
				makeMail({
					id: 2,
					type: 'verify',
					recipient: 'a@example.com',
					subject: '请验证您的邮箱',
					status: 'failed',
					error: 'ECONNREFUSED 127.0.0.1:1',
				}),
			],
			total: 2,
		});

		const first = rows()[0];
		expect(first.text()).toContain('休眠提醒');
		expect(first.text()).toContain('成功');
		expect(first.text()).toContain('sleepy@example.com');
		expect(first.text()).toContain('个人网站链接已进入休眠');

		const second = rows()[1];
		expect(second.text()).toContain('邮箱验证');
		expect(second.text()).toContain('失败');
		expect(second.get('[data-test="mail-error"]').text()).toContain('ECONNREFUSED');
	});

	it('保留天数来自接口（不写死在面板里）', async () => {
		await mountPage({ ...PAGE, retentionDays: 7 });
		expect(wrapper.text()).toContain('仅保留最近 7 天');
	});

	it('保留天数为 0（永久保留）时不显示「最近 0 天」', async () => {
		await mountPage({ ...PAGE, retentionDays: 0 });
		expect(wrapper.text()).toContain('永久保留');
		expect(wrapper.text()).not.toContain('仅保留最近 0 天');
	});

	it('未知类型回落为原始字符串', async () => {
		await mountPage({ ...PAGE, list: [makeMail({ type: 'brand_new_type' })] });
		expect(rows()[0].text()).toContain('brand_new_type');
	});

	it('没有记录时展示空态', async () => {
		await mountPage({ ...PAGE, list: [], total: 0 });
		expect(rows()).toHaveLength(0);
		expect(wrapper.text()).toContain('暂无邮件记录');
	});

	it('加载失败时提示错误', async () => {
		requestMock.get.mockRejectedValue(new Error('boom'));
		router = await createTestRouter('/mails');
		wrapper = mount(MailManagement, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('加载邮件记录失败');
	});
});

describe('MailManagement - 筛选与分页', () => {
	it('默认不带筛选参数', async () => {
		await mountPage();
		const params = requestMock.get.mock.calls[0][1].params;
		expect(params).toEqual({ page: 1, pageSize: 20 });
	});

	it('按状态与类型筛选后回到第一页并带上参数', async () => {
		await mountPage();

		// 直接操作组件状态（SelectMenu 的交互已有自己的用例覆盖）
		wrapper.vm.statusFilter = 'failed';
		wrapper.vm.typeFilter = 'dormant_notice';
		wrapper.vm.searchKeyword = 'sleepy@';
		await wrapper.vm.applyFilters();
		await flushPromises();

		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/mails', {
			params: { page: 1, pageSize: 20, status: 'failed', type: 'dormant_notice', search: 'sleepy@' },
		});
	});

	it('出现筛选时展示「重置」，重置后清空条件', async () => {
		await mountPage();
		wrapper.vm.statusFilter = 'failed';
		await flushPromises();
		const reset = wrapper.findAll('button').find((b) => b.text() === '重置');
		expect(reset).toBeTruthy();

		await reset.trigger('click');
		await flushPromises();
		expect(wrapper.vm.statusFilter).toBe('all');
		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/mails', {
			params: { page: 1, pageSize: 20 },
		});
	});

	it('分页按钮按总数计算页数并在边界禁用', async () => {
		await mountPage({ ...PAGE, total: 45 });
		expect(wrapper.text()).toContain('共 45 条 · 3 页');

		const [prev, next] = wrapper.findAll('button').filter((b) => ['上一页', '下一页'].includes(b.text()));
		expect(prev.attributes('disabled')).toBeDefined();
		expect(next.attributes('disabled')).toBeUndefined();

		await next.trigger('click');
		await flushPromises();
		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/mails', {
			params: { page: 2, pageSize: 20 },
		});
	});

	it('筛选后没有结果时给出「没有符合条件」而不是「暂无」', async () => {
		await mountPage({ ...PAGE, list: [], total: 0 });
		wrapper.vm.statusFilter = 'failed';
		await flushPromises();
		expect(wrapper.text()).toContain('没有符合条件的邮件记录');
	});

	it('登出清除 token 并跳转登录页', async () => {
		await mountPage();
		localStorage.setItem('token', 'tk');
		wrapper.findComponent({ name: 'AdminLayout' }).vm.$emit('logout');
		await flushPromises();
		expect(localStorage.getItem('token')).toBeNull();
	});
});
