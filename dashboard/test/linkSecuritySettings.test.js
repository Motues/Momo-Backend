import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/* ---------- 依赖 mock ---------- */
const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import LinkSecuritySettings from '../src/views/LinkSecuritySettings.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';
import {
	DEFAULT_LINK_DORMANT_DAYS,
	LINK_DORMANT_DAYS_ERROR,
	normalizeLinkSwitch,
	resolveLinkDormantDays,
	validateLinkDormantDays,
} from '../src/utils/linkSecurity.js';

/**
 * 「链接安全」设置页（契约 v1）：休眠链接开关 + 休眠天数 + 历史链接同步开关。
 *
 * 口径由 doc/link_security.md 与 doc/vectors/link-security-v1.json 钉死：
 * 开关 fail-closed、天数 1–3650 默认 30；同步 / 提醒依赖 API 地址（不再依赖邮箱验证）。
 */

let router;
let pushSpy;
let wrapper;
let errorSpy;

/** 按 type 分发的 GET 实现 */
const mountSettings = async ({ link = {}, basic = {}, linkCode = 200, basicCode = 200 } = {}) => {
	requestMock.get.mockImplementation((url, config) => {
		const type = config?.params?.type;
		if (type === 'link') return Promise.resolve({ code: linkCode, data: link });
		if (type === 'basic') return Promise.resolve({ code: basicCode, data: basic });
		return Promise.resolve({ code: 200, data: {} });
	});
	router = await createTestRouter('/settings/link');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(LinkSecuritySettings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const layout = () => wrapper.findComponent({ name: 'AdminLayout' });
const saveButton = () => wrapper.get('[data-test="save-link"]');
const securitySwitch = () => wrapper.get('[data-test="link-security-enabled"]');
const syncSwitch = () => wrapper.get('[data-test="link-sync-enabled"]');
const noticeSwitch = () => wrapper.get('[data-test="link-dormant-notice-enabled"]');
const daysInput = () => wrapper.get('[data-test="link-dormant-days"]');
const warning = () => wrapper.find('[data-test="link-sync-warning"]');
const noticeWarning = () => wrapper.find('[data-test="link-dormant-notice-warning"]');
const missingBanner = () => wrapper.find('[data-test="link-api-base-url-missing"]');
const lastPayload = () => requestMock.put.mock.calls.at(-1)[1];

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
	requestMock.put.mockResolvedValue({ code: 200 });
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
	pushSpy?.mockRestore();
	errorSpy.mockRestore();
	vi.useRealTimers();
});

describe('linkSecurity 纯逻辑', () => {
	it('normalizeLinkSwitch 是 fail-closed：只有 true 才算开启', () => {
		expect(normalizeLinkSwitch('true')).toBe('true');
		expect(normalizeLinkSwitch(' TRUE ')).toBe('true');
		expect(normalizeLinkSwitch('True')).toBe('true');
		expect(normalizeLinkSwitch('false')).toBe('false');
		expect(normalizeLinkSwitch('')).toBe('false');
		expect(normalizeLinkSwitch('   ')).toBe('false');
		expect(normalizeLinkSwitch('yes')).toBe('false');
		expect(normalizeLinkSwitch('1')).toBe('false');
		expect(normalizeLinkSwitch('on')).toBe('false');
		expect(normalizeLinkSwitch('true1')).toBe('false');
		expect(normalizeLinkSwitch(null)).toBe('false');
		expect(normalizeLinkSwitch(undefined)).toBe('false');
	});

	it('resolveLinkDormantDays：脏值回退 30、超上限夹取到 3650', () => {
		expect(DEFAULT_LINK_DORMANT_DAYS).toBe(30);
		expect(resolveLinkDormantDays('')).toBe(30);
		expect(resolveLinkDormantDays('   ')).toBe(30);
		expect(resolveLinkDormantDays('abc')).toBe(30);
		expect(resolveLinkDormantDays('0')).toBe(30);
		expect(resolveLinkDormantDays('-5')).toBe(30);
		expect(resolveLinkDormantDays('1.5')).toBe(30);
		expect(resolveLinkDormantDays(null)).toBe(30);
		expect(resolveLinkDormantDays('1')).toBe(1);
		expect(resolveLinkDormantDays(' 30 ')).toBe(30);
		expect(resolveLinkDormantDays(3650)).toBe(3650);
		expect(resolveLinkDormantDays('99999')).toBe(3650);
	});

	it('validateLinkDormantDays：只接受 1–3650 的十进制整数', () => {
		expect(validateLinkDormantDays('1')).toBe('');
		expect(validateLinkDormantDays('30')).toBe('');
		expect(validateLinkDormantDays(' 30 ')).toBe('');
		expect(validateLinkDormantDays('3650')).toBe('');
		expect(validateLinkDormantDays(1)).toBe('');

		[ '', '   ', '0', '-1', '3651', 'abc', '1.5', '30d', '1e3', null ].forEach((value) => {
			expect(validateLinkDormantDays(value)).toBe('link_dormant_days 必须是 1-3650 之间的整数');
		});
		expect(LINK_DORMANT_DAYS_ERROR).toBe('link_dormant_days 必须是 1-3650 之间的整数');
	});
});

describe('LinkSecuritySettings - 加载', () => {
	it('同时拉取 type=link 与 type=basic 两组设置', async () => {
		await mountSettings();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'link' } });
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'basic' } });
		expect(requestMock.get).toHaveBeenCalledTimes(2);
	});

	it('默认值：三个开关都关闭、休眠天数 30', async () => {
		await mountSettings();
		expect(securitySwitch().element.checked).toBe(false);
		expect(syncSwitch().element.checked).toBe(false);
		expect(noticeSwitch().element.checked).toBe(false);
		expect(daysInput().element.value).toBe('30');
	});

	it('加载已保存的值', async () => {
		await mountSettings({
			link: {
				link_security_enabled: 'true',
				link_dormant_days: '90',
				link_sync_enabled: 'true',
				link_dormant_notice_enabled: 'true',
			},
			basic: { verify_base_url: 'https://api.example.com' },
		});
		expect(securitySwitch().element.checked).toBe(true);
		expect(syncSwitch().element.checked).toBe(true);
		expect(noticeSwitch().element.checked).toBe(true);
		expect(daysInput().element.value).toBe('90');
		expect(wrapper.text()).toContain('已开启');
	});

	it('开关 fail-closed：脏值一律按关闭处理', async () => {
		await mountSettings({
			link: {
				link_security_enabled: 'yes',
				link_dormant_days: '',
				link_sync_enabled: '1',
				link_dormant_notice_enabled: 'on',
			},
		});
		expect(securitySwitch().element.checked).toBe(false);
		expect(syncSwitch().element.checked).toBe(false);
		expect(noticeSwitch().element.checked).toBe(false);
		expect(daysInput().element.value).toBe('30');
	});

	it('大小写脏值 TRUE 判为开启，天数超上限夹取到 3650', async () => {
		await mountSettings({
			link: { link_security_enabled: ' TRUE ', link_dormant_days: '99999', link_sync_enabled: ' FALSE ' },
		});
		expect(securitySwitch().element.checked).toBe(true);
		expect(syncSwitch().element.checked).toBe(false);
		expect(daysInput().element.value).toBe('3650');
	});

	it('接口失败时记录错误并保留默认值', async () => {
		requestMock.get.mockImplementation(() => Promise.reject(new Error('boom')));
		router = await createTestRouter('/settings/link');
		wrapper = mount(LinkSecuritySettings, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();

		expect(errorSpy).toHaveBeenCalled();
		expect(securitySwitch().element.checked).toBe(false);
		expect(daysInput().element.value).toBe('30');
	});

	it('业务 code 非 200 时保留默认值', async () => {
		await mountSettings({ linkCode: 500, basicCode: 500 });
		expect(securitySwitch().element.checked).toBe(false);
		expect(daysInput().element.value).toBe('30');
	});
});

describe('LinkSecuritySettings - API 地址警告', () => {
	it('API 地址为空时显示顶部提示，并禁用同步 / 提醒开关', async () => {
		await mountSettings({ basic: {} });

		expect(missingBanner().exists()).toBe(true);
		expect(missingBanner().text()).toContain('API 地址');
		expect(missingBanner().find('a').attributes('href')).toBe('/settings/basic');
		expect(syncSwitch().attributes('disabled')).toBeDefined();
		expect(noticeSwitch().attributes('disabled')).toBeDefined();
	});

	it('API 地址已填写时不显示顶部提示，开关可用', async () => {
		await mountSettings({ basic: { verify_base_url: 'https://api.example.com' } });

		expect(missingBanner().exists()).toBe(false);
		expect(syncSwitch().attributes('disabled')).toBeUndefined();
		expect(noticeSwitch().attributes('disabled')).toBeUndefined();
	});

	it('同步开关已开启但 API 地址为空时给出警告与跳转链接', async () => {
		await mountSettings({
			link: { link_security_enabled: 'false', link_dormant_days: '30', link_sync_enabled: 'true' },
			basic: {},
		});

		expect(warning().exists()).toBe(true);
		expect(warning().text()).toContain('API 地址');
		expect(warning().text()).toContain('verify_base_url');
		const link = warning().find('a');
		expect(link.attributes('href')).toBe('/settings/basic');
	});

	it('API 地址已填写时不显示同步警告', async () => {
		await mountSettings({
			link: { link_sync_enabled: 'true' },
			basic: { verify_base_url: 'https://api.example.com' },
		});
		expect(warning().exists()).toBe(false);
	});

	it('同步关闭时不显示警告（即使 API 地址为空）', async () => {
		await mountSettings({ link: { link_sync_enabled: 'false' }, basic: {} });
		expect(warning().exists()).toBe(false);
	});
});

describe('LinkSecuritySettings - 休眠提醒邮件的 API 地址警告', () => {
	it('提醒开关打开但 API 地址为空时给出警告与跳转链接', async () => {
		await mountSettings({
			link: { link_dormant_notice_enabled: 'true' },
			basic: {},
		});

		expect(noticeWarning().exists()).toBe(true);
		expect(noticeWarning().text()).toContain('API 地址');
		expect(noticeWarning().text()).toContain('verify_base_url');
		expect(noticeWarning().text()).toContain('通知邮件也不会发出');
		const link = noticeWarning().find('a');
		expect(link.attributes('href')).toBe('/settings/basic');
	});

	it('API 地址已填写时不显示提醒警告', async () => {
		await mountSettings({
			link: { link_dormant_notice_enabled: 'true' },
			basic: { verify_base_url: 'https://api.example.com' },
		});
		expect(noticeWarning().exists()).toBe(false);
	});

	it('提醒开关关闭时不显示警告（即使 API 地址为空）', async () => {
		await mountSettings({
			link: { link_dormant_notice_enabled: 'false' },
			basic: {},
		});
		expect(noticeWarning().exists()).toBe(false);
	});

	it('同步与提醒互不影响：只开提醒时只有提醒的警告', async () => {
		await mountSettings({
			link: { link_sync_enabled: 'false', link_dormant_notice_enabled: 'true' },
			basic: {},
		});
		expect(warning().exists()).toBe(false);
		expect(noticeWarning().exists()).toBe(true);
	});
});

describe('LinkSecuritySettings - 保存', () => {
	it('只提交四个 link_* 键（字符串布尔值）', async () => {
		await mountSettings({
			link: {
				link_security_enabled: 'true',
				link_dormant_days: '90',
				link_sync_enabled: 'false',
				link_dormant_notice_enabled: 'true',
			},
		});
		await saveButton().trigger('click');
		await flushPromises();

		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(requestMock.put.mock.calls[0][0]).toBe('/admin/settings');
		expect(lastPayload()).toEqual({
			link_security_enabled: 'true',
			link_dormant_days: '90',
			link_sync_enabled: 'false',
			link_dormant_notice_enabled: 'true',
		});
	});

	it('未配置时的默认提交值', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload()).toEqual({
			link_security_enabled: 'false',
			link_dormant_days: '30',
			link_sync_enabled: 'false',
			link_dormant_notice_enabled: 'false',
		});
	});

	it('切换开关与天数后提交用户选择', async () => {
		await mountSettings({ basic: { verify_base_url: 'https://api.example.com' } });
		await securitySwitch().setValue(true);
		await syncSwitch().setValue(true);
		await noticeSwitch().setValue(true);
		await daysInput().setValue('7');
		await saveButton().trigger('click');
		await flushPromises();

		expect(lastPayload()).toEqual({
			link_security_enabled: 'true',
			link_dormant_days: '7',
			link_sync_enabled: 'true',
			link_dormant_notice_enabled: 'true',
		});
	});

	it('天数为 0 / 越界 / 小数 / 空时阻止保存并给出文档错误文案', async () => {
		for (const bad of ['0', '3651', '1.5', '', 'abc']) {
			await mountSettings();
			await daysInput().setValue(bad);
			await saveButton().trigger('click');
			await flushPromises();

			expect(requestMock.put).not.toHaveBeenCalled();
			expect(toastMock.error).toHaveBeenCalledWith('link_dormant_days 必须是 1-3650 之间的整数');
			wrapper.unmount();
			wrapper = undefined;
		}
	});

	it('边界值 1 与 3650 可以保存', async () => {
		for (const value of ['1', '3650']) {
			await mountSettings();
			await daysInput().setValue(value);
			await saveButton().trigger('click');
			await flushPromises();
			expect(lastPayload().link_dormant_days).toBe(value);
			wrapper.unmount();
			wrapper = undefined;
		}
	});

	it('保存成功后提示并展示保存成功标记', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).toHaveBeenCalledWith('设置已保存');
		expect(wrapper.text()).toContain('保存成功');
	});

	it('保存成功标记 3 秒后自动隐藏', async () => {
		await mountSettings();
		vi.useFakeTimers();
		await saveButton().trigger('click');
		await vi.advanceTimersByTimeAsync(10);
		expect(wrapper.text()).toContain('保存成功');
		await vi.advanceTimersByTimeAsync(3000);
		expect(wrapper.text()).not.toContain('保存成功');
		vi.useRealTimers();
	});

	it('保存进行中按钮禁用并显示「保存中...」', async () => {
		let resolvePut;
		await mountSettings();
		requestMock.put.mockReturnValue(new Promise((resolve) => { resolvePut = resolve; }));
		await saveButton().trigger('click');
		await flushPromises();
		expect(saveButton().text()).toContain('保存中...');
		expect(saveButton().attributes('disabled')).toBeDefined();
		resolvePut({ code: 200 });
		await flushPromises();
		expect(saveButton().text()).toContain('保存设置');
	});

	it('业务 code 非 200 时不提示成功', async () => {
		await mountSettings();
		requestMock.put.mockResolvedValue({ code: 400, message: 'bad' });
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).not.toHaveBeenCalled();
		expect(wrapper.text()).not.toContain('保存成功');
	});

	it('保存失败时记录错误且不显示成功标记', async () => {
		await mountSettings();
		requestMock.put.mockRejectedValue(new Error('boom'));
		await saveButton().trigger('click');
		await flushPromises();
		expect(errorSpy).toHaveBeenCalled();
		expect(wrapper.text()).not.toContain('保存成功');
	});
});

describe('LinkSecuritySettings - 页面说明与布局', () => {
	it('解释休眠链接行为（访客只看到无法访问、无继续访问入口，再次评论自动解除）', async () => {
		await mountSettings();
		const text = wrapper.text();
		expect(text).toContain('休眠');
		expect(text).toContain('自动跳转');
		expect(text).toContain('无法访问');
		expect(text).toContain('自动解除');
	});

	it('提示可在用户列表人工确认放行（有效期同休眠天数）', async () => {
		await mountSettings();
		const text = wrapper.text();
		expect(text).toContain('用户列表');
		expect(text).toContain('确认安全');
		expect(text).toContain('到期后自动恢复休眠');
	});

	it('解释历史链接同步需要本人邮件确认', async () => {
		await mountSettings();
		const text = wrapper.text();
		expect(text).toContain('确认邮件');
		expect(text).toContain('历史评论');
		expect(text).toContain('曾经通过邮箱验证');
	});

	it('解释休眠提醒邮件（进入休眠时通知本人，同一休眠周期只提醒一次）', async () => {
		await mountSettings();
		const text = wrapper.text();
		expect(text).toContain('休眠提醒邮件');
		expect(text).toContain('刚进入休眠');
		expect(text).toContain('我仍在使用');
		expect(text).toContain('同一个休眠周期只提醒一次');
	});

	it('baseUrl 取自 localStorage 的 apiUrl', async () => {
		localStorage.setItem('apiUrl', 'https://api.example.com');
		await mountSettings();
		expect(layout().props('baseUrl')).toBe('https://api.example.com');
	});

	it('refresh 事件重新拉取两组设置', async () => {
		await mountSettings();
		expect(requestMock.get).toHaveBeenCalledTimes(2);
		layout().vm.$emit('refresh');
		await flushPromises();
		expect(requestMock.get).toHaveBeenCalledTimes(4);
	});

	it('logout 事件清除 token 并跳转登录页', async () => {
		await mountSettings();
		localStorage.setItem('token', 'tk');
		layout().vm.$emit('logout');
		await flushPromises();
		expect(localStorage.getItem('token')).toBeNull();
		expect(pushSpy).toHaveBeenCalledWith('/login');
	});
});

describe('LinkSecuritySettings - 路由与入口', () => {
	it('设置页里有链接安全入口卡片', async () => {
		const Settings = (await import('../src/views/Settings.vue')).default;
		const settingsRouter = await createTestRouter('/settings');
		const settingsWrapper = mount(Settings, {
			global: { plugins: [settingsRouter], stubs: { AdminLayout: AdminLayoutStub } },
		});
		const link = settingsWrapper.findAll('a').find((a) => a.attributes('href') === '/settings/link');
		expect(link).toBeTruthy();
		expect(link.text()).toContain('链接安全');
		expect(link.text()).toContain('休眠链接');
		expect(link.text()).toContain('历史');
	});

	it('后端路由表里注册了 /settings/link', async () => {
		const { default: appRouter } = await import('../src/router/index.js');
		const route = appRouter.getRoutes().find((item) => item.path === '/settings/link');
		expect(route).toBeTruthy();
		expect(route.name).toBe('LinkSecuritySettings');
		expect(route.meta.requiresAuth).toBe(true);
	});
});
