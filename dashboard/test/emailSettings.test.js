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

import EmailSettings from '../src/views/EmailSettings.vue';
import { createTestRouter, AdminLayoutStub, pickSelectOption } from './support/harness.js';

const DEFAULT_FORM = {
	smtp_host: '',
	smtp_port: '',
	email_user: '',
	email_password: '',
	email_secure: 'true',
	email_enabled: 'true',
	email_verify_enabled: 'false',
	verify_base_url: '',
	reply_template: '',
	notification_template: '',
};

let router;
let pushSpy;
let wrapper;
let errorSpy;

const mountSettings = async (getResponse = { code: 200, data: {} }) => {
	if (typeof getResponse === 'function') requestMock.get.mockImplementation(getResponse);
	else requestMock.get.mockResolvedValue(getResponse);
	router = await createTestRouter('/settings/email');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(EmailSettings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const layout = () => wrapper.findComponent({ name: 'AdminLayout' });
const saveButton = () => wrapper.findAll('button').find((button) => button.text().includes('保存'));
const testEmailButton = () =>
	wrapper.findAll('button').find((button) => /测试邮件|发送中/.test(button.text()));
const lastPayload = () => requestMock.put.mock.calls.at(-1)[1];

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
	requestMock.put.mockResolvedValue({ code: 200 });
	requestMock.post.mockResolvedValue({ code: 200 });
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
	pushSpy?.mockRestore();
	errorSpy.mockRestore();
});

describe('EmailSettings - 加载与默认值', () => {
	it('挂载时以 type=email 拉取设置', async () => {
		await mountSettings();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'email' } });
	});

	it('默认值：邮件通知开启、SSL 开启、邮箱验证关闭', async () => {
		await mountSettings();
		expect(wrapper.vm.form.email_enabled).toBe('true');
		expect(wrapper.vm.form.email_secure).toBe('true');
		expect(wrapper.vm.form.email_verify_enabled).toBe('false');
	});

	it('默认值：SMTP 与模板字段为空', async () => {
		await mountSettings();
		['smtp_host', 'smtp_port', 'email_user', 'email_password', 'verify_base_url', 'reply_template', 'notification_template']
			.forEach((key) => expect(wrapper.vm.form[key]).toBe(''));
	});

	it('加载成功后填充 SMTP 配置', async () => {
		await mountSettings({
			code: 200,
			data: {
				smtp_host: 'smtp.example.com',
				smtp_port: '465',
				email_user: 'bot@example.com',
				email_secure: 'false',
				email_enabled: 'false',
				email_verify_enabled: 'true',
				verify_base_url: 'https://api.example.com',
			},
		});
		expect(wrapper.vm.form.smtp_host).toBe('smtp.example.com');
		expect(wrapper.vm.form.smtp_port).toBe('465');
		expect(wrapper.vm.form.email_user).toBe('bot@example.com');
		expect(wrapper.vm.form.email_secure).toBe('false');
		expect(wrapper.vm.form.email_verify_enabled).toBe('true');
		expect(wrapper.find('input[placeholder="smtp.example.com"]').element.value).toBe('smtp.example.com');
	});

	it('加载后 isDirty 为 false', async () => {
		await mountSettings();
		expect(wrapper.vm.isDirty).toBe(false);
	});

	it('加载失败时记录错误并保留默认值', async () => {
		await mountSettings(() => Promise.reject(new Error('boom')));
		expect(errorSpy).toHaveBeenCalled();
		expect(wrapper.vm.form).toEqual(DEFAULT_FORM);
	});
});

describe('EmailSettings - 开关与选项', () => {
	it('关闭邮件通知开关后展示已关闭', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[0].setValue(false);
		expect(wrapper.vm.form.email_enabled).toBe('false');
		expect(wrapper.text()).toContain('已关闭');
	});

	it('开启邮箱验证后显示验证强度相关提示与 API 地址输入框', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
		expect(wrapper.vm.form.email_verify_enabled).toBe('true');
		expect(wrapper.find('input[placeholder="https://api.example.com"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('已启用');
	});

	it('SSL 下拉框可切换为 "false"', async () => {
		await mountSettings();
		await pickSelectOption(wrapper, '否 (端口 587)');
		expect(wrapper.vm.form.email_secure).toBe('false');
	});
});

describe('EmailSettings - 保存载荷', () => {
	it('保存请求为 PUT /admin/settings', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(requestMock.put.mock.calls[0][0]).toBe('/admin/settings');
	});

	it('密码为空时不会提交 email_password 字段', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		const payload = lastPayload();
		expect(Object.keys(payload)).not.toContain('email_password');
		expect(Object.keys(payload).sort()).toEqual(
			Object.keys(DEFAULT_FORM).filter((key) => key !== 'email_password').sort(),
		);
	});

	it('填写密码后会提交 email_password', async () => {
		await mountSettings();
		await wrapper.find('input[type="password"]').setValue('s3cret');
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().email_password).toBe('s3cret');
	});

	it('verify_base_url 结尾斜杠会被去掉', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
		await wrapper.find('input[placeholder="https://api.example.com"]').setValue('https://api.example.com///');
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().verify_base_url).toBe('https://api.example.com');
	});

	it('verify_base_url 为空时保持为空字符串', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().verify_base_url).toBe('');
	});

	it('verify_base_url 只由斜杠组成时会绕过校验并提交空字符串（已记录的缺陷）', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
		await wrapper.find('input[placeholder="https://api.example.com"]').setValue('///');
		await saveButton().trigger('click');
		await flushPromises();
		// 非空校验发生在去掉结尾斜杠之前，因此 "///" 能通过校验却被裁剪成空值提交
		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(lastPayload().verify_base_url).toBe('');
	});

	it('开关以字符串 "true"/"false" 提交', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[0].setValue(false);
		await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
		await wrapper.find('input[placeholder="https://api.example.com"]').setValue('https://api.example.com');
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().email_enabled).toBe('false');
		expect(lastPayload().email_verify_enabled).toBe('true');
	});

	it('开启邮箱验证但未填 API 地址时拒绝保存并提示', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('启用邮箱验证时必须填写 API 地址');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('开启邮箱验证并填写地址后可以保存', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
		await wrapper.find('input[placeholder="https://api.example.com"]').setValue('https://api.example.com');
		await saveButton().trigger('click');
		await flushPromises();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
	});

	it('校验失败后按钮不会卡在加载态', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(saveButton().text()).toContain('保存设置');
		expect(saveButton().attributes('disabled')).toBeUndefined();
	});

	it('保存成功后提示并展示保存成功标记', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).toHaveBeenCalledWith('设置已保存');
		expect(wrapper.text()).toContain('保存成功');
	});

	it('保存进行中按钮禁用并显示「保存中...」', async () => {
		let resolvePut;
		await mountSettings();
		requestMock.put.mockReturnValue(new Promise((resolve) => { resolvePut = resolve; }));
		await saveButton().trigger('click');
		await flushPromises();
		expect(saveButton().text()).toContain('保存中...');
		resolvePut({ code: 200 });
		await flushPromises();
		expect(saveButton().text()).toContain('保存设置');
	});

	it('保存失败时记录错误且不显示成功标记', async () => {
		await mountSettings();
		requestMock.put.mockRejectedValue(new Error('boom'));
		await saveButton().trigger('click');
		await flushPromises();
		expect(errorSpy).toHaveBeenCalled();
		expect(wrapper.text()).not.toContain('保存成功');
	});

	it('保存成功后 isDirty 复位', async () => {
		await mountSettings();
		await wrapper.find('input[placeholder="smtp.example.com"]').setValue('smtp.changed.com');
		expect(wrapper.vm.isDirty).toBe(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(wrapper.vm.isDirty).toBe(false);
	});
});

describe('EmailSettings - 测试邮件', () => {
	it('点击后 POST /admin/settings/test-email', async () => {
		await mountSettings();
		await testEmailButton().trigger('click');
		await flushPromises();
		expect(requestMock.post).toHaveBeenCalledWith('/admin/settings/test-email');
	});

	it('发送成功提示查收', async () => {
		await mountSettings();
		await testEmailButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).toHaveBeenCalledWith('测试邮件已发送，请查收');
	});

	it('发送失败时展示错误信息', async () => {
		await mountSettings();
		requestMock.post.mockRejectedValue(new Error('SMTP 连接超时'));
		await testEmailButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('SMTP 连接超时');
	});

	it('发送失败且无消息时使用默认文案', async () => {
		await mountSettings();
		requestMock.post.mockRejectedValue({});
		await testEmailButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('测试邮件发送失败');
	});

	it('发送中按钮禁用并显示「发送中...」', async () => {
		let resolvePost;
		await mountSettings();
		requestMock.post.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
		await testEmailButton().trigger('click');
		await flushPromises();
		expect(testEmailButton().text()).toContain('发送中...');
		expect(testEmailButton().attributes('disabled')).toBeDefined();
		resolvePost({ code: 200 });
		await flushPromises();
		expect(testEmailButton().text()).toContain('发送测试邮件');
	});

	it('业务 code 非 200 时不提示成功', async () => {
		await mountSettings();
		requestMock.post.mockResolvedValue({ code: 500, message: 'fail' });
		await testEmailButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).not.toHaveBeenCalled();
	});
});

describe('EmailSettings - 布局交互', () => {
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
