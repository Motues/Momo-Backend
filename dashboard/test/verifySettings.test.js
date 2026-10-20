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

import VerifySettings from '../src/views/VerifySettings.vue';
import { createTestRouter, AdminLayoutStub, pickSelectOption } from './support/harness.js';

let router;
let pushSpy;
let wrapper;
let errorSpy;

const mountSettings = async (getResponse = { code: 200, data: {} }) => {
	if (typeof getResponse === 'function') requestMock.get.mockImplementation(getResponse);
	else requestMock.get.mockResolvedValue(getResponse);
	router = await createTestRouter('/settings/verify');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(VerifySettings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const layout = () => wrapper.findComponent({ name: 'AdminLayout' });
const saveButton = () => wrapper.findAll('button').find((button) => /保存设置|保存中/.test(button.text()));
const lastPayload = () => requestMock.put.mock.calls.at(-1)[1];

/**
 * 人机验证页按功能拆成四张卡片（每张一个 section）：
 *   core（无感验证）/ instr（环境质询）/ domain（来源域名绑定）/ records（认证记录）。
 *
 * 卡片里的复选框按 DOM 顺序：
 *   [0] 启用无感验证  [1] 启用环境质询（第二层）  [2] 命中自动化特征时拒绝  [3] 来源域名绑定  [4] 记录签发事件
 * 后四个只在前面开启后才存在，所以每次都要重新查询。
 */
const sections = () => wrapper.findAll('section[data-test^="verify-section"]');
const section = (name) => wrapper.find(`[data-test="verify-section-${name}"]`);
const verifyToggles = () =>
	sections().flatMap((item) => item.findAll('input[type="checkbox"]'));

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
});

describe('VerifySettings - 页面结构与加载', () => {
	it('H1 显示「人机验证」', async () => {
		await mountSettings();
		expect(wrapper.find('h1').text()).toBe('人机验证');
	});

	it('渲染迁入的人机验证区块（含第二层、域名绑定与认证记录）', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true' } });
		const text = wrapper.text();
		expect(text).toContain('启用无感验证');
		expect(text).toContain('验证强度');
		expect(text).toContain('启用环境质询（第二层）');
		expect(text).toContain('启用来源域名绑定');
		expect(text).toContain('认证记录保留天数');
	});

	it('按功能拆成四张独立卡片（各自一个 section，不再挤在同一个框里）', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true' } });
		expect(sections().length).toBe(4);

		// 每张卡片只装自己那组设置，标题与控件一一对应
		expect(section('core').text()).toContain('无感验证');
		expect(section('core').text()).toContain('验证强度');
		expect(section('core').findAll('input[type="checkbox"]').length).toBe(1);

		expect(section('instr').text()).toContain('环境质询（第二层）');
		expect(section('instr').text()).toContain('启用环境质询');
		expect(section('instr').text()).not.toContain('启用来源域名绑定');
		expect(section('instr').findAll('input[type="checkbox"]').length).toBe(1);

		expect(section('domain').text()).toContain('启用来源域名绑定');
		expect(section('domain').text()).not.toContain('认证记录保留天数');
		expect(section('domain').findAll('input[type="checkbox"]').length).toBe(1);

		expect(section('records').text()).toContain('记录签发事件');
		expect(section('records').text()).toContain('认证记录保留天数');
		expect(section('records').findAll('input[type="checkbox"]').length).toBe(1);
	});

	it('认证记录卡片带「查看认证记录」入口', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true' } });
		const link = section('records').findAll('a').find((a) => a.attributes('href') === '/verify-records');
		expect(link).toBeTruthy();
		expect(link.text()).toContain('查看认证记录');
	});

	it('挂载时以 type=security 拉取设置（后端分组不变）', async () => {
		await mountSettings();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'security' } });
	});

	it('默认值：关闭、强度为中、记录签发事件、保留 30 天', async () => {
		await mountSettings();
		expect(wrapper.vm.commentVerifyEnabled).toBe(false);
		expect(wrapper.vm.commentVerifyDifficulty).toBe('1000000');
		expect(wrapper.vm.commentVerifyInstrEnabled).toBe(false);
		expect(wrapper.vm.commentVerifyBlockAutomated).toBe(false);
		expect(wrapper.vm.commentVerifyDomainEnabled).toBe(false);
		expect(wrapper.vm.commentVerifyLogChallenge).toBe(true);
		expect(wrapper.vm.commentVerifyRetentionDays).toBe(30);
	});

	it('加载后 isDirty 为 false', async () => {
		await mountSettings();
		expect(wrapper.vm.isDirty).toBe(false);
	});

	it('加载失败时记录错误并使用默认值', async () => {
		await mountSettings(() => Promise.reject(new Error('boom')));
		expect(errorSpy).toHaveBeenCalled();
		expect(wrapper.vm.commentVerifyEnabled).toBe(false);
	});

	it('加载时回填各开关与保留策略', async () => {
		await mountSettings({
			code: 200,
			data: {
				comment_verify_enabled: 'true',
				comment_verify_difficulty: '4000000',
				comment_verify_instr_enabled: 'true',
				comment_verify_block_automated: 'true',
				comment_verify_domain_enabled: 'true',
				comment_verify_log_challenge: 'false',
				comment_verify_retention_days: '7',
			},
		});
		expect(wrapper.vm.commentVerifyEnabled).toBe(true);
		expect(wrapper.vm.commentVerifyDifficulty).toBe('4000000');
		expect(wrapper.vm.commentVerifyInstrEnabled).toBe(true);
		expect(wrapper.vm.commentVerifyBlockAutomated).toBe(true);
		expect(wrapper.vm.commentVerifyDomainEnabled).toBe(true);
		expect(wrapper.vm.commentVerifyLogChallenge).toBe(false);
		expect(wrapper.vm.commentVerifyRetentionDays).toBe(7);
	});

	it('强度为空/缺失时归一化为中档（1000000）', async () => {
		await mountSettings({ code: 200, data: { comment_verify_difficulty: '' } });
		expect(wrapper.vm.commentVerifyDifficulty).toBe('1000000');
	});

	it('默认记录签发事件（只有显式 false 才关闭）', async () => {
		await mountSettings({ code: 200, data: { comment_verify_log_challenge: 'true' } });
		expect(wrapper.vm.commentVerifyLogChallenge).toBe(true);

		wrapper.unmount();
		await mountSettings({ code: 200, data: {} });
		expect(wrapper.vm.commentVerifyLogChallenge).toBe(true);
	});
});

describe('VerifySettings - 条件渲染与交互', () => {
	it('默认不展示验证强度下拉框，启用后展示', async () => {
		await mountSettings();
		expect(wrapper.find('[role="combobox"]').exists()).toBe(false);

		await verifyToggles()[0].setValue(true);
		expect(wrapper.find('[role="combobox"]').exists()).toBe(true);
		expect(wrapper.vm.commentVerifyEnabled).toBe(true);
	});

	it('验证强度可选高并写入模型', async () => {
		await mountSettings();
		await verifyToggles()[0].setValue(true);
		await pickSelectOption(wrapper, '高（约 400 万次计算');
		expect(wrapper.vm.commentVerifyDifficulty).toBe('4000000');
	});

	it('未启用无感验证时只展示第一张卡片（只有「启用无感验证」一个复选框）', async () => {
		await mountSettings();
		expect(sections().length).toBe(1);
		expect(verifyToggles().length).toBe(1);
		expect(section('instr').exists()).toBe(false);
		expect(section('domain').exists()).toBe(false);
		expect(section('records').exists()).toBe(false);
	});

	it('开启第二层后可用「命中自动化特征时拒绝」', async () => {
		await mountSettings();
		await verifyToggles()[0].setValue(true);
		await verifyToggles()[1].setValue(true);
		expect(wrapper.vm.commentVerifyInstrEnabled).toBe(true);
		// 开启无感验证后：启用无感验证 / 第二层 / 命中即拒绝 / 来源域名绑定 / 记录签发事件
		expect(verifyToggles().length).toBe(5);

		await verifyToggles()[2].setValue(true);
		expect(wrapper.vm.commentVerifyBlockAutomated).toBe(true);
	});

	it('关闭第二层后「命中自动化特征时拒绝」隐藏', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true', comment_verify_instr_enabled: 'true' } });
		expect(wrapper.text()).toContain('命中自动化特征时拒绝');
		await verifyToggles()[1].setValue(false);
		expect(wrapper.text()).not.toContain('命中自动化特征时拒绝');
	});

	it('记录签发事件开关文案随状态变化', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true' } });
		expect(wrapper.text()).toContain('已记录');
		// 未开启第二层时：[0] 无感验证 [1] 环境质询 [2] 来源域名绑定 [3] 记录签发事件
		await verifyToggles()[3].setValue(false);
		expect(wrapper.vm.commentVerifyLogChallenge).toBe(false);
		expect(wrapper.text()).toContain('仅结果');
	});
});

describe('VerifySettings - 来源域名绑定（fail-closed）', () => {
	it('白名单为空时给出 fail-closed 告警，并指向访问控制页', async () => {
		await mountSettings({
			code: 200,
			data: { comment_verify_enabled: 'true', comment_verify_domain_enabled: 'true' },
		});
		expect(wrapper.vm.domainWhitelistUsable).toBe(false);
		expect(wrapper.text()).toContain('拒绝所有');
		expect(wrapper.text()).toContain('访问控制');
	});

	it('只有 * 也算不可用', async () => {
		await mountSettings({
			code: 200,
			data: { comment_verify_enabled: 'true', comment_verify_domain_enabled: 'true', allow_origin: '*' },
		});
		expect(wrapper.vm.domainWhitelistUsable).toBe(false);
		expect(wrapper.text()).toContain('拒绝所有');
	});

	it('白名单可用时展示生效中的域名，不再告警', async () => {
		await mountSettings({
			code: 200,
			data: {
				comment_verify_enabled: 'true',
				comment_verify_domain_enabled: 'true',
				allow_origin: 'https://blog.example.com',
			},
		});
		expect(wrapper.vm.domainWhitelistUsable).toBe(true);
		expect(wrapper.text()).not.toContain('拒绝所有');
		expect(wrapper.text()).toContain('生效中的白名单');
	});

	it('关闭域名绑定时不展示告警（即使白名单为空）', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true' } });
		expect(wrapper.text()).not.toContain('拒绝所有');
	});
});

describe('VerifySettings - 保存载荷', () => {
	it('保存请求为 PUT /admin/settings', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(requestMock.put.mock.calls[0][0]).toBe('/admin/settings');
	});

	it('只提交七个 comment_verify_* 键', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(Object.keys(lastPayload()).sort()).toEqual([
			'comment_verify_block_automated',
			'comment_verify_difficulty',
			'comment_verify_domain_enabled',
			'comment_verify_enabled',
			'comment_verify_instr_enabled',
			'comment_verify_log_challenge',
			'comment_verify_retention_days',
		]);
	});

	it('不提交 admin_comment_key*、allow_origin、黑名单或 trust_proxy', async () => {
		await mountSettings({
			code: 200,
			data: {
				admin_comment_key_enabled: 'true',
				allow_origin: 'https://a.com',
				ip_blacklist: '["1.1.1.1"]',
				email_blacklist: '["a@x.com"]',
				trust_proxy: 'true',
			},
		});
		await saveButton().trigger('click');
		await flushPromises();
		const keys = Object.keys(lastPayload());
		expect(keys).not.toContain('admin_comment_key');
		expect(keys).not.toContain('admin_comment_key_enabled');
		expect(keys).not.toContain('allow_origin');
		expect(keys).not.toContain('ip_blacklist');
		expect(keys).not.toContain('email_blacklist');
		expect(keys).not.toContain('trust_proxy');
	});

	it('开关以字符串形式提交', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true' } });
		await verifyToggles()[1].setValue(true);
		await verifyToggles()[2].setValue(true);
		await verifyToggles()[3].setValue(true);
		await verifyToggles()[4].setValue(false);
		await saveButton().trigger('click');
		await flushPromises();
		const payload = lastPayload();
		expect(payload.comment_verify_enabled).toBe('true');
		expect(payload.comment_verify_instr_enabled).toBe('true');
		expect(payload.comment_verify_block_automated).toBe('true');
		expect(payload.comment_verify_domain_enabled).toBe('true');
		expect(payload.comment_verify_log_challenge).toBe('false');
	});

	it('保留天数：默认 30、0 为永久保留、非法与超限都归一化', async () => {
		await mountSettings({ code: 200, data: { comment_verify_enabled: 'true' } });

		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().comment_verify_retention_days).toBe('30');
		expect(lastPayload().comment_verify_log_challenge).toBe('true');

		wrapper.vm.commentVerifyRetentionDays = 0;
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().comment_verify_retention_days).toBe('0');

		wrapper.vm.commentVerifyRetentionDays = 'abc';
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().comment_verify_retention_days).toBe('30');

		wrapper.vm.commentVerifyRetentionDays = 99999;
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().comment_verify_retention_days).toBe('3650');
	});

	it('保存成功后提示并复位 isDirty', async () => {
		await mountSettings();
		await verifyToggles()[0].setValue(true);
		expect(wrapper.vm.isDirty).toBe(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).toHaveBeenCalledWith('人机验证设置已保存');
		expect(wrapper.vm.isDirty).toBe(false);
		expect(wrapper.text()).toContain('保存成功');
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

	it('保存失败时展示后端返回的错误原因', async () => {
		await mountSettings();
		requestMock.put.mockRejectedValue(new Error('难度值非法'));
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('难度值非法');
		expect(wrapper.text()).not.toContain('保存成功');
	});

	it('保存失败且无消息时使用默认文案', async () => {
		await mountSettings();
		requestMock.put.mockRejectedValue({});
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('人机验证设置保存失败');
	});

	it('业务 code 非 200 时不提示成功', async () => {
		await mountSettings();
		requestMock.put.mockResolvedValue({ code: 500, message: 'fail' });
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).not.toHaveBeenCalled();
	});
});

describe('VerifySettings - 布局交互', () => {
	it('refresh 事件重新拉取设置', async () => {
		await mountSettings();
		layout().vm.$emit('refresh');
		await flushPromises();
		expect(requestMock.get).toHaveBeenCalledTimes(2);
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
