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

import Users from '../src/views/Users.vue';
import { createTestRouter, AdminLayoutStub, pickSelectOption } from './support/harness.js';

/** 一条用户记录：url / urlDormant / urlTrustedUntil 由后端 /admin/stats/users 提供 */
const makeUser = (overrides = {}) => ({
	author: '张三',
	email: 'zhangsan@example.com',
	emailVerified: true,
	emailVerifiedAt: '2024-01-01T00:00:00.000Z',
	blacklisted: false,
	commentCount: 3,
	approvedCount: 2,
	pendingCount: 1,
	deletedCount: 0,
	lastCommentDate: '2024-05-06T07:08:09.000Z',
	url: '',
	urlDormant: false,
	urlTrustedUntil: '',
	...overrides,
});

let router;
let wrapper;

const mountUsers = async (users) => {
	requestMock.get.mockResolvedValue({
		code: 200,
		data: { users, pagination: { page: 1, limit: 20, totalPage: 1 } },
	});
	router = await createTestRouter('/users');
	wrapper = mount(Users, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const linkCell = () => wrapper.get('[data-test="user-link-status"], [data-test="user-link-unknown"]');
const mobileBadge = () => wrapper.find('[data-test="user-link-badge"]');

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
});

describe('Users - 网站链接列（表头与结构）', () => {
	it('桌面表头在「邮箱验证」之后、「评论数」之前插入「网站链接」', async () => {
		await mountUsers([makeUser()]);
		expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual([
			'作者',
			'邮箱',
			'邮箱验证',
			'网站链接',
			'评论数',
			'已通过',
			'待审核',
			'已删除',
			'最后评论',
			'操作',
		]);
	});

	it('空状态行的 colspan 与表头列数一致（9 → 10）', async () => {
		await mountUsers([]);
		const colspan = wrapper.get('tbody td[colspan]').attributes('colspan');
		expect(colspan).toBe('10');
		expect(wrapper.findAll('thead th')).toHaveLength(Number(colspan));
	});

	it('每行都渲染一个网站链接单元格', async () => {
		await mountUsers([makeUser(), makeUser({ email: 'b@example.com' })]);
		expect(wrapper.findAll('[data-test="user-link-status"]')).toHaveLength(2);
	});
});

describe('Users - 网站链接三种状态', () => {
	it('url 为空时显示灰色的「无链接」', async () => {
		await mountUsers([makeUser({ url: '', urlDormant: false })]);
		const cell = linkCell();
		expect(cell.text()).toContain('无链接');
		expect(cell.classes()).toContain('text-gray-400');
		expect(cell.attributes('title')).toBeUndefined();
	});

	it('urlDormant 为 true 时显示琥珀色的「休眠」徽章，title 为完整链接', async () => {
		const url = 'https://zhangsan.example.com';
		await mountUsers([makeUser({ url, urlDormant: true })]);
		const cell = linkCell();
		expect(cell.text()).toContain('休眠');
		expect(cell.attributes('title')).toContain(url);
		expect(cell.classes()).toEqual(
			expect.arrayContaining(['bg-amber-50', 'text-amber-600', 'border-amber-200', 'rounded-full'])
		);
	});

	it('休眠徽章可点击打开目标网页：新窗口 + rel="noopener noreferrer"', async () => {
		const url = 'https://zhangsan.example.com';
		await mountUsers([makeUser({ url, urlDormant: true })]);
		const cell = linkCell();
		expect(cell.element.tagName).toBe('A');
		expect(cell.attributes('href')).toBe(url);
		expect(cell.attributes('target')).toBe('_blank');
		expect(cell.attributes('rel')).toBe('noopener noreferrer');
	});

	it('人工确认未过期时显示蓝色「已确认」徽章，hover 显示到期时间', async () => {
		const url = 'https://zhangsan.example.com';
		const until = '2024-06-05T07:08:09.000Z';
		// 后端在确认有效时会同时把 urlDormant 置为 false
		await mountUsers([makeUser({ url, urlDormant: false, urlTrustedUntil: until, urlTrustedSource: 'admin' })]);
		const cell = linkCell();
		expect(cell.text()).toContain('已确认');
		expect(cell.element.tagName).toBe('SPAN');
		expect(cell.attributes('title')).toContain('已人工确认安全');
		expect(cell.attributes('title')).toContain('到期');
		expect(cell.classes()).toEqual(
			expect.arrayContaining(['bg-blue-50', 'text-blue-600', 'border-blue-200'])
		);
	});

	it('本人自助确认时文案区分来源（urlTrustedSource=self）', async () => {
		await mountUsers([
			makeUser({
				url: 'https://zhangsan.example.com',
				urlTrustedUntil: '2024-06-05T07:08:09.000Z',
				urlTrustedSource: 'self',
			}),
		]);
		expect(linkCell().attributes('title')).toContain('本人已确认仍在使用');
	});

	it('已确认优先于休眠展示（后端可能同时下发两个字段）', async () => {
		await mountUsers([
			makeUser({
				url: 'https://zhangsan.example.com',
				urlDormant: true,
				urlTrustedUntil: '2024-06-05T07:08:09.000Z',
			}),
		]);
		expect(linkCell().text()).toContain('已确认');
		expect(linkCell().text()).not.toContain('休眠');
	});

	it('链接正常时显示绿色的「正常」，title 为完整链接', async () => {
		const url = 'https://zhangsan.example.com';
		await mountUsers([makeUser({ url, urlDormant: false })]);
		const cell = linkCell();
		expect(cell.text()).toContain('正常');
		expect(cell.attributes('title')).toBe(url);
		expect(cell.classes()).toEqual(
			expect.arrayContaining(['bg-emerald-50', 'text-emerald-600', 'border-emerald-200'])
		);
	});

	it('正常与无链接的单元格不会被渲染成 <a>', async () => {
		await mountUsers([makeUser({ url: 'https://zhangsan.example.com', urlDormant: false })]);
		expect(linkCell().element.tagName).toBe('SPAN');
		expect(wrapper.find('[data-test="user-link-status"] a').exists()).toBe(false);
		expect(wrapper.find('tbody').findAll('a')).toHaveLength(0);
	});

	it('老接口没有 url 字段时显示灰色的「—」并提示后端过旧（不是「无链接」）', async () => {
		const user = makeUser();
		delete user.url;
		delete user.urlDormant;
		await mountUsers([user]);

		const cell = wrapper.get('[data-test="user-link-unknown"]');
		expect(cell.text()).toBe('—');
		expect(cell.classes()).toContain('text-gray-400');
		expect(cell.attributes('title')).toBe('后端版本过旧，未下发该字段（请升级/重启后端）');
		// 字段缺失 ≠ 没有链接：不能复用「无链接」那一个单元格
		expect(wrapper.find('[data-test="user-link-status"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('无链接');
	});

	it('url 为 null 时同样按「后端未下发」处理', async () => {
		await mountUsers([makeUser({ url: null, urlDormant: false })]);
		expect(wrapper.get('[data-test="user-link-unknown"]').text()).toBe('—');
	});
});

describe('Users - 移动端卡片徽章', () => {
	it('无链接时展示徽章', async () => {
		await mountUsers([makeUser({ url: '' })]);
		expect(mobileBadge().exists()).toBe(true);
		expect(mobileBadge().text()).toContain('无链接');
	});

	it('休眠时展示琥珀色徽章并带完整链接 title', async () => {
		const url = 'https://zhangsan.example.com';
		await mountUsers([makeUser({ url, urlDormant: true })]);
		expect(mobileBadge().exists()).toBe(true);
		expect(mobileBadge().text()).toContain('休眠');
		expect(mobileBadge().attributes('title')).toBe(url);
		expect(mobileBadge().classes()).toEqual(expect.arrayContaining(['bg-amber-50', 'text-amber-600']));
	});

	it('链接正常时不额外展示徽章（保持整洁）', async () => {
		await mountUsers([makeUser({ url: 'https://zhangsan.example.com', urlDormant: false })]);
		expect(mobileBadge().exists()).toBe(false);
	});

	it('后端未下发 url 字段时展示灰色的「未知」徽章', async () => {
		const user = makeUser();
		delete user.url;
		delete user.urlDormant;
		await mountUsers([user]);

		expect(mobileBadge().exists()).toBe(true);
		expect(mobileBadge().text()).toContain('未知');
		expect(mobileBadge().attributes('title')).toBe('后端版本过旧，未下发该字段（请升级/重启后端）');
		expect(mobileBadge().classes()).toEqual(expect.arrayContaining(['bg-gray-100', 'text-gray-500']));
	});

	it('休眠徽章在移动端同样可点击打开目标网页', async () => {
		const url = 'https://zhangsan.example.com';
		await mountUsers([makeUser({ url, urlDormant: true })]);
		expect(mobileBadge().element.tagName).toBe('A');
		expect(mobileBadge().attributes('href')).toBe(url);
		expect(mobileBadge().attributes('rel')).toBe('noopener noreferrer');
	});

	it('已确认时移动端展示蓝色徽章', async () => {
		await mountUsers([
			makeUser({ url: 'https://zhangsan.example.com', urlTrustedUntil: '2024-06-05T07:08:09.000Z' }),
		]);
		expect(mobileBadge().text()).toContain('已确认');
		expect(mobileBadge().classes()).toEqual(expect.arrayContaining(['bg-blue-50', 'text-blue-600']));
	});
});

describe('Users - 人工确认休眠链接（确认安全 / 撤销）', () => {
	// 移动端卡片与桌面表格各渲染一套按钮，断言统一取桌面表格里的那一套
	const trustButton = () => wrapper.find('tbody [data-test="user-trust-button"]');
	const revokeButton = () => wrapper.find('tbody [data-test="user-trust-revoke-button"]');
	const URL_ = 'https://zhangsan.example.com';

	it('只有休眠链接才显示「确认安全」按钮', async () => {
		await mountUsers([makeUser({ url: URL_, urlDormant: true })]);
		expect(trustButton().exists()).toBe(true);
		expect(trustButton().text()).toBe('确认安全');
		expect(revokeButton().exists()).toBe(false);
	});

	it('正常 / 无链接 / 后端未下发时不显示任何人工确认按钮', async () => {
		const missing = makeUser({ email: 'x@example.com' });
		delete missing.url;
		delete missing.urlDormant;
		await mountUsers([
			makeUser({ url: URL_, urlDormant: false }),
			makeUser({ email: 'none@example.com', url: '' }),
			missing,
		]);
		expect(trustButton().exists()).toBe(false);
		expect(revokeButton().exists()).toBe(false);
	});

	it('点击「确认安全」调用确认接口并刷新列表', async () => {
		await mountUsers([makeUser({ url: URL_, urlDormant: true })]);
		requestMock.post.mockResolvedValue({ code: 200, data: { expiresAt: '2024-06-05T07:08:09.000Z' } });

		await trustButton().trigger('click');
		await flushPromises();

		expect(requestMock.post).toHaveBeenCalledWith('/admin/links/trust', {
			email: 'zhangsan@example.com',
			url: URL_,
		});
		// 刷新：挂载时 1 次 + 确认后 1 次
		expect(requestMock.get).toHaveBeenCalledTimes(2);
		expect(toastMock.success).toHaveBeenCalled();
	});

	it('确认失败时提示错误且不刷新', async () => {
		await mountUsers([makeUser({ url: URL_, urlDormant: true })]);
		requestMock.post.mockRejectedValue(new Error('boom'));

		await trustButton().trigger('click');
		await flushPromises();

		expect(toastMock.error).toHaveBeenCalledWith('确认失败，请重试');
		expect(requestMock.get).toHaveBeenCalledTimes(1);
	});

	it('已确认时按钮变为「撤销确认」，确认后调用删除接口并刷新', async () => {
		const until = '2024-06-05T07:08:09.000Z';
		await mountUsers([makeUser({ url: URL_, urlDormant: false, urlTrustedUntil: until })]);
		expect(revokeButton().exists()).toBe(true);
		expect(trustButton().exists()).toBe(false);
		// 按钮 hover 提示里带到期时间与来源（管理员人工确认）
		expect(revokeButton().attributes('title')).toContain('已人工确认安全');
		expect(revokeButton().attributes('title')).toContain('2024/6/5');

		const confirmSpy = vi.fn(() => true);
		vi.stubGlobal('confirm', confirmSpy);
		requestMock.delete.mockResolvedValue({ code: 200 });

		await revokeButton().trigger('click');
		await flushPromises();

		expect(confirmSpy).toHaveBeenCalled();
		expect(requestMock.delete).toHaveBeenCalledWith('/admin/links/trust', {
			params: { email: 'zhangsan@example.com', url: URL_ },
		});
		expect(requestMock.get).toHaveBeenCalledTimes(2);
		expect(toastMock.success).toHaveBeenCalledWith('已撤销人工确认');
		vi.unstubAllGlobals();
	});

	it('撤销时点了取消则什么都不做', async () => {
		await mountUsers([
			makeUser({ url: URL_, urlTrustedUntil: '2024-06-05T07:08:09.000Z' }),
		]);
		vi.stubGlobal('confirm', vi.fn(() => false));

		await revokeButton().trigger('click');
		await flushPromises();

		expect(requestMock.delete).not.toHaveBeenCalled();
		expect(requestMock.get).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});

	it('操作列顺序：确认安全 / 撤销确认 在「查看评论」左侧', async () => {
		await mountUsers([makeUser({ url: URL_, urlDormant: true })]);
		expect(wrapper.get('tbody tr').findAll('button').map((b) => b.text())).toEqual([
			'确认安全',
			'查看评论',
			'拉黑',
		]);
	});

	it('已确认时「撤销确认」同样排在「查看评论」左侧', async () => {
		await mountUsers([makeUser({ url: URL_, urlTrustedUntil: '2024-06-05T07:08:09.000Z' })]);
		expect(wrapper.get('tbody tr').findAll('button').map((b) => b.text())).toEqual([
			'撤销确认',
			'查看评论',
			'拉黑',
		]);
	});
});

describe('Users - 网站链接状态筛选', () => {
	it('默认不传 linkStatus', async () => {
		await mountUsers([makeUser()]);
		expect(requestMock.get).toHaveBeenCalledWith('/admin/stats/users', {
			params: { page: 1, limit: 20 },
		});
	});

	it('选择「休眠」后带上 linkStatus=dormant 并回到第一页', async () => {
		await mountUsers([makeUser()]);
		expect(requestMock.get).toHaveBeenCalledTimes(1);

		await pickSelectOption(wrapper, '休眠', '[data-test="user-link-filter"] [role="combobox"]');
		await flushPromises();

		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/stats/users', {
			params: { page: 1, limit: 20, linkStatus: 'dormant' },
		});
	});

	it('与邮箱验证筛选、搜索可叠加', async () => {
		await mountUsers([makeUser()]);
		await pickSelectOption(wrapper, '已确认', '[data-test="user-link-filter"] [role="combobox"]');
		await flushPromises();
		await pickSelectOption(wrapper, '邮箱已验证');
		await flushPromises();
		wrapper.vm.searchKeyword = 'zhangsan';
		await wrapper.vm.handleSearch();
		await flushPromises();

		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/stats/users', {
			params: { page: 1, limit: 20, verified: 'true', linkStatus: 'trusted', search: 'zhangsan' },
		});
	});

	it('筛选无结果时的空态文案与「暂无数据」区分', async () => {
		const users = [];
		await mountUsers(users);
		// 未筛选 → 暂无用户数据
		expect(wrapper.text()).toContain('暂无用户数据');

		await pickSelectOption(wrapper, '休眠', '[data-test="user-link-filter"] [role="combobox"]');
		await flushPromises();
		expect(wrapper.text()).toContain('未找到匹配的用户');
	});
});

describe('Users - 行点击进入用户详情', () => {
	it('点击桌面端整行跳转到 /user-comments，并带上昵称与邮箱', async () => {
		await mountUsers([makeUser()]);
		await wrapper.get('[data-test="user-row"]').trigger('click');
		await flushPromises();

		expect(router.currentRoute.value.path).toBe('/user-comments');
		expect(router.currentRoute.value.query).toMatchObject({
			author: '张三',
			email: 'zhangsan@example.com',
		});
	});

	it('点击行内操作按钮不会触发整行跳转（拉黑/确认安全仍留在列表页）', async () => {
		await mountUsers([makeUser({ url: 'https://zhangsan.example.com', urlDormant: true })]);
		await wrapper.get('[data-test="user-trust-button"]').trigger('click');
		await flushPromises();

		expect(router.currentRoute.value.path).toBe('/users');
	});

	it('点击休眠链接（外链）不会触发整行跳转', async () => {
		await mountUsers([makeUser({ url: 'https://zhangsan.example.com', urlDormant: true })]);
		await wrapper.get('[data-test="user-link-status"]').trigger('click');
		await flushPromises();

		expect(router.currentRoute.value.path).toBe('/users');
	});

	it('移动端卡片点击同样进入详情页', async () => {
		await mountUsers([makeUser()]);
		await wrapper.get('[data-test="user-card"]').trigger('click');
		await flushPromises();

		expect(router.currentRoute.value.path).toBe('/user-comments');
	});
});
