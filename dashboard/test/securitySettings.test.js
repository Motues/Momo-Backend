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

import SecuritySettings from '../src/views/SecuritySettings.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

const ORIGIN_INPUT = 'input[placeholder="https://example.com"]';
const IP_INPUT = 'input[placeholder="192.168.1.1 或 10.0.0.0/8"]';
const EMAIL_INPUT = 'input[placeholder="spam@example.com"]';
const KEY_INPUT = 'input[placeholder="输入管理员评论密钥"]';

let router;
let pushSpy;
let wrapper;
let errorSpy;

const mountSettings = async (getResponse = { code: 200, data: {} }) => {
	if (typeof getResponse === 'function') requestMock.get.mockImplementation(getResponse);
	else requestMock.get.mockResolvedValue(getResponse);
	router = await createTestRouter('/settings/security');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(SecuritySettings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const layout = () => wrapper.findComponent({ name: 'AdminLayout' });
const saveButton = () => wrapper.findAll('button').find((button) => /保存设置|保存中/.test(button.text()));
const lastPayload = () => requestMock.put.mock.calls.at(-1)[1];

/** 按 h2 标题定位区块（正文里也可能出现同样的关键词，例如「客户端 IP 识别」正文也提到 IP 黑名单） */
const sectionByHeading = (title) =>
	wrapper
		.findAll('section')
		.find((section) => section.find('h2').text().replace(/\s+/g, '').includes(title));

/** 开关文案在整个页面里唯一，用它定位所属区块中的复选框 */
const checkboxByLabel = (labelText) => {
	const section = wrapper.findAll('section').find((s) => s.text().includes(labelText));
	return section.find('input[type="checkbox"]');
};

const addInSection = async (sectionTitle, inputSelector, value) => {
	await wrapper.find(inputSelector).setValue(value);
	await sectionByHeading(sectionTitle).findAll('button').at(-1).trigger('click');
};

const addOrigin = (value) => addInSection('跨域设置', ORIGIN_INPUT, value);
const addIp = (value) => addInSection('IP黑名单', IP_INPUT, value);
const addEmail = (value) => addInSection('邮箱黑名单', EMAIL_INPUT, value);

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

describe('SecuritySettings - 加载与默认值', () => {
	it('挂载时以 type=security 拉取设置', async () => {
		await mountSettings();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'security' } });
	});

	it('默认值：各列表为空、开关关闭、验证强度为中', async () => {
		await mountSettings();
		expect(wrapper.vm.ipBlacklist).toEqual([]);
		expect(wrapper.vm.emailBlacklist).toEqual([]);
		expect(wrapper.vm.originList).toEqual([]);
		expect(wrapper.vm.adminCommentKeyEnabled).toBe(false);
		expect(wrapper.vm.commentVerifyEnabled).toBe(false);
		expect(wrapper.vm.commentVerifyDifficulty).toBe('18');
		expect(wrapper.vm.trustProxy).toBe(false);
	});

	it('加载后解析 JSON 数组形式的黑名单', async () => {
		await mountSettings({
			code: 200,
			data: {
				ip_blacklist: '["1.1.1.1","10.0.0.0/8"]',
				email_blacklist: '["spam@example.com"]',
			},
		});
		expect(wrapper.vm.ipBlacklist).toEqual(['1.1.1.1', '10.0.0.0/8']);
		expect(wrapper.vm.emailBlacklist).toEqual(['spam@example.com']);
		expect(wrapper.text()).toContain('1.1.1.1');
	});

	it('IP 黑名单非法 JSON 时回落为空数组', async () => {
		await mountSettings({ code: 200, data: { ip_blacklist: 'not-json' } });
		expect(wrapper.vm.ipBlacklist).toEqual([]);
	});

	it('邮箱黑名单非法 JSON 时回落为空数组', async () => {
		await mountSettings({ code: 200, data: { email_blacklist: '{oops' } });
		expect(wrapper.vm.emailBlacklist).toEqual([]);
	});

	it('JSON 合法但不是数组时同样回落为空数组', async () => {
		await mountSettings({ code: 200, data: { ip_blacklist: '{"a":1}', email_blacklist: '"str"' } });
		expect(wrapper.vm.ipBlacklist).toEqual([]);
		expect(wrapper.vm.emailBlacklist).toEqual([]);
	});

	it('空字符串黑名单解析为空数组', async () => {
		await mountSettings({ code: 200, data: { ip_blacklist: '', email_blacklist: '' } });
		expect(wrapper.vm.ipBlacklist).toEqual([]);
		expect(wrapper.vm.emailBlacklist).toEqual([]);
	});

	it('allow_origin 按逗号切分并去掉首尾空白', async () => {
		await mountSettings({ code: 200, data: { allow_origin: ' https://a.com , https://b.com ' } });
		expect(wrapper.vm.originList).toEqual(['https://a.com', 'https://b.com']);
	});

	it('allow_origin 中的空项会被过滤', async () => {
		await mountSettings({ code: 200, data: { allow_origin: 'https://a.com,,  ,https://b.com,' } });
		expect(wrapper.vm.originList).toEqual(['https://a.com', 'https://b.com']);
	});

	it('allow_origin 为空时 originList 为空数组', async () => {
		await mountSettings({ code: 200, data: { allow_origin: '' } });
		expect(wrapper.vm.originList).toEqual([]);
	});

	it.each([
		['admin_comment_key_enabled', 'adminCommentKeyEnabled'],
		['comment_verify_enabled', 'commentVerifyEnabled'],
		['trust_proxy', 'trustProxy'],
	])('字符串 "true" 会被解析成布尔值（%s）', async (field, model) => {
		await mountSettings({ code: 200, data: { [field]: 'true' } });
		expect(wrapper.vm[model]).toBe(true);
	});

	it('字符串 "false" 解析为 false', async () => {
		await mountSettings({ code: 200, data: { trust_proxy: 'false' } });
		expect(wrapper.vm.trustProxy).toBe(false);
	});

	it('缺失字段时开关保持 false', async () => {
		await mountSettings({ code: 200, data: { trust_proxy: undefined } });
		expect(wrapper.vm.trustProxy).toBe(false);
	});

	it('加载管理员评论密钥', async () => {
		await mountSettings({ code: 200, data: { admin_comment_key: 'k-123' } });
		expect(wrapper.vm.adminCommentKey).toBe('k-123');
	});

	it('加载验证强度', async () => {
		await mountSettings({ code: 200, data: { comment_verify_difficulty: '20' } });
		expect(wrapper.vm.commentVerifyDifficulty).toBe('20');
	});

	it('加载后 isDirty 为 false', async () => {
		await mountSettings();
		expect(wrapper.vm.isDirty).toBe(false);
	});

	it('加载失败时记录错误并使用默认值', async () => {
		await mountSettings(() => Promise.reject(new Error('boom')));
		expect(errorSpy).toHaveBeenCalled();
		expect(wrapper.vm.ipBlacklist).toEqual([]);
	});
});

describe('SecuritySettings - 反向代理开关提示', () => {
	it.each([
		['env', 'TRUST_PROXY 强制指定'],
		['config', 'config.yaml'],
		['worker', 'cf-connecting-ip'],
	])('override=%s 时展示对应的强制说明', async (override, expected) => {
		await mountSettings({ code: 200, data: { trust_proxy_override: override } });
		expect(wrapper.text()).toContain(expected);
	});

	it('没有 override 时不展示提示', async () => {
		await mountSettings({ code: 200, data: { trust_proxy_override: '' } });
		expect(wrapper.text()).not.toContain('页面上的修改不会生效');
		expect(wrapper.text()).not.toContain('cf-connecting-ip');
	});

	it('未知 override 值不展示提示', async () => {
		await mountSettings({ code: 200, data: { trust_proxy_override: 'unknown' } });
		expect(wrapper.vm.trustProxyOverrideHint).toBe('');
	});

	it('打开信任代理开关会更新文案', async () => {
		await mountSettings();
		await checkboxByLabel('信任反向代理下发的 IP 头').setValue(true);
		expect(wrapper.vm.trustProxy).toBe(true);
		expect(wrapper.text()).toContain('已开启');
	});
});

describe('SecuritySettings - 列表维护', () => {
	it('添加跨域来源后进入列表', async () => {
		await mountSettings();
		await addOrigin('https://a.com');
		expect(wrapper.vm.originList).toEqual(['https://a.com']);
		expect(wrapper.vm.newOrigin).toBe('');
	});

	it('添加来源时会去掉首尾空白', async () => {
		await mountSettings();
		await addOrigin('  https://a.com  ');
		expect(wrapper.vm.originList).toEqual(['https://a.com']);
	});

	it('添加重复来源不会重复入列', async () => {
		await mountSettings();
		await addOrigin('https://a.com');
		await addOrigin('https://a.com');
		expect(wrapper.vm.originList).toEqual(['https://a.com']);
	});

	it('空白来源不会被添加', async () => {
		await mountSettings();
		await addOrigin('   ');
		expect(wrapper.vm.originList).toEqual([]);
	});

	it('空输入时「添加」按钮禁用', async () => {
		await mountSettings();
		expect(sectionByHeading('跨域设置').findAll('button').at(-1).attributes('disabled')).toBeDefined();
	});

	it('输入内容后「添加」按钮可用', async () => {
		await mountSettings();
		await wrapper.find(ORIGIN_INPUT).setValue('https://a.com');
		expect(sectionByHeading('跨域设置').findAll('button').at(-1).attributes('disabled')).toBeUndefined();
	});

	it('回车可以添加来源', async () => {
		await mountSettings();
		await wrapper.find(ORIGIN_INPUT).setValue('https://enter.com');
		await wrapper.find(ORIGIN_INPUT).trigger('keydown.enter');
		expect(wrapper.vm.originList).toEqual(['https://enter.com']);
	});

	it('删除来源只删除对应项', async () => {
		await mountSettings({ code: 200, data: { allow_origin: 'https://a.com,https://b.com' } });
		await sectionByHeading('跨域设置').findAll('span button')[0].trigger('click');
		expect(wrapper.vm.originList).toEqual(['https://b.com']);
	});

	it('添加 IP 黑名单条目', async () => {
		await mountSettings();
		await addIp('192.168.1.1');
		expect(wrapper.vm.ipBlacklist).toEqual(['192.168.1.1']);
		expect(wrapper.text()).toContain('192.168.1.1');
	});

	it('IP 条目去重并 trim', async () => {
		await mountSettings();
		await addIp(' 10.0.0.0/8 ');
		await addIp('10.0.0.0/8');
		expect(wrapper.vm.ipBlacklist).toEqual(['10.0.0.0/8']);
	});

	it('IP 空白输入不会入列', async () => {
		await mountSettings();
		await addIp('   ');
		expect(wrapper.vm.ipBlacklist).toEqual([]);
	});

	it('回车可以添加 IP 条目', async () => {
		await mountSettings();
		await wrapper.find(IP_INPUT).setValue('8.8.8.8');
		await wrapper.find(IP_INPUT).trigger('keydown.enter');
		expect(wrapper.vm.ipBlacklist).toEqual(['8.8.8.8']);
	});

	it('删除 IP 条目', async () => {
		await mountSettings({ code: 200, data: { ip_blacklist: '["1.1.1.1","2.2.2.2"]' } });
		await sectionByHeading('IP黑名单').findAll('button .fa-trash-can')[0].trigger('click');
		expect(wrapper.vm.ipBlacklist).toEqual(['2.2.2.2']);
	});

	it('添加邮箱黑名单条目并去重', async () => {
		await mountSettings();
		await addEmail('spam@example.com');
		await addEmail('spam@example.com');
		expect(wrapper.vm.emailBlacklist).toEqual(['spam@example.com']);
	});

	it('删除邮箱条目', async () => {
		await mountSettings({ code: 200, data: { email_blacklist: '["a@x.com","b@x.com"]' } });
		await sectionByHeading('邮箱黑名单').findAll('button .fa-trash-can')[1].trigger('click');
		expect(wrapper.vm.emailBlacklist).toEqual(['a@x.com']);
	});

	it('两个黑名单为空时展示空状态文案', async () => {
		await mountSettings();
		expect(wrapper.text()).toContain('暂无 IP 黑名单条目');
		expect(wrapper.text()).toContain('暂无邮箱黑名单条目');
	});

	it('添加条目后 isDirty 变为 true', async () => {
		await mountSettings();
		await addOrigin('https://a.com');
		expect(wrapper.vm.isDirty).toBe(true);
	});
});

describe('SecuritySettings - 管理员密钥与人机验证', () => {
	it('默认不展示密钥输入框', async () => {
		await mountSettings();
		expect(wrapper.find(KEY_INPUT).exists()).toBe(false);
	});

	it('启用密钥后展示输入框', async () => {
		await mountSettings();
		await checkboxByLabel('启用评论密钥').setValue(true);
		expect(wrapper.vm.adminCommentKeyEnabled).toBe(true);
		expect(wrapper.find(KEY_INPUT).exists()).toBe(true);
	});

	it('默认不展示验证强度下拉框', async () => {
		await mountSettings();
		expect(wrapper.find('select').exists()).toBe(false);
	});

	it('启用无感验证后展示强度下拉框', async () => {
		await mountSettings();
		await checkboxByLabel('启用无感验证').setValue(true);
		expect(wrapper.find('select').exists()).toBe(true);
		expect(wrapper.vm.commentVerifyEnabled).toBe(true);
	});

	it('验证强度可选高并写入模型', async () => {
		await mountSettings();
		await checkboxByLabel('启用无感验证').setValue(true);
		await wrapper.find('select').setValue('20');
		expect(wrapper.vm.commentVerifyDifficulty).toBe('20');
	});
});

describe('SecuritySettings - 保存载荷', () => {
	it('保存请求为 PUT /admin/settings', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(requestMock.put.mock.calls[0][0]).toBe('/admin/settings');
	});

	it('提交的键集合固定为 8 项（含用于清除密钥的空 admin_comment_key）', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(Object.keys(lastPayload()).sort()).toEqual([
			'admin_comment_key',
			'admin_comment_key_enabled',
			'allow_origin',
			'comment_verify_difficulty',
			'comment_verify_enabled',
			'email_blacklist',
			'ip_blacklist',
			'trust_proxy',
		]);
	});

	it('allow_origin 用逗号拼接', async () => {
		await mountSettings({ code: 200, data: { allow_origin: 'https://a.com,https://b.com' } });
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().allow_origin).toBe('https://a.com,https://b.com');
	});

	it('黑名单序列化为 JSON 字符串', async () => {
		await mountSettings({ code: 200, data: { ip_blacklist: '["1.1.1.1"]', email_blacklist: '["a@x.com"]' } });
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().ip_blacklist).toBe('["1.1.1.1"]');
		expect(lastPayload().email_blacklist).toBe('["a@x.com"]');
	});

	it('开关以字符串形式提交', async () => {
		await mountSettings();
		await checkboxByLabel('信任反向代理下发的 IP 头').setValue(true);
		await checkboxByLabel('启用无感验证').setValue(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().trust_proxy).toBe('true');
		expect(lastPayload().comment_verify_enabled).toBe('true');
		expect(lastPayload().admin_comment_key_enabled).toBe('false');
	});

	it('启用密钥并填写内容时提交密钥', async () => {
		await mountSettings();
		await checkboxByLabel('启用评论密钥').setValue(true);
		await wrapper.find(KEY_INPUT).setValue('my-key');
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().admin_comment_key).toBe('my-key');
	});

	it('启用密钥但未填写内容时不提交密钥字段', async () => {
		await mountSettings();
		await checkboxByLabel('启用评论密钥').setValue(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(Object.keys(lastPayload())).not.toContain('admin_comment_key');
	});

	it('关闭密钥开关时提交空密钥以清除', async () => {
		await mountSettings({ code: 200, data: { admin_comment_key: 'old', admin_comment_key_enabled: 'true' } });
		await checkboxByLabel('启用评论密钥').setValue(false);
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().admin_comment_key).toBe('');
	});

	it('保存成功后提示并复位 isDirty', async () => {
		await mountSettings();
		await addOrigin('https://a.com');
		expect(wrapper.vm.isDirty).toBe(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).toHaveBeenCalledWith('安全设置已保存');
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
		requestMock.put.mockRejectedValue(new Error('IP 地址格式非法'));
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('IP 地址格式非法');
		expect(wrapper.text()).not.toContain('保存成功');
	});

	it('保存失败且无消息时使用默认文案', async () => {
		await mountSettings();
		requestMock.put.mockRejectedValue({});
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('安全设置保存失败');
	});

	it('业务 code 非 200 时不提示成功', async () => {
		await mountSettings();
		requestMock.put.mockResolvedValue({ code: 500, message: 'fail' });
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).not.toHaveBeenCalled();
	});
});

describe('SecuritySettings - 布局交互', () => {
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
