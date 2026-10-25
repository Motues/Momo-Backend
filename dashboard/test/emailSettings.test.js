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
import MailPreviewModal from '../src/components/MailPreviewModal.vue';
import { createTestRouter, AdminLayoutStub, pickSelectOption } from './support/harness.js';

const DEFAULT_FORM = {
	smtp_host: '',
	smtp_port: '',
	email_user: '',
	email_password: '',
	email_secure: 'true',
	email_enabled: 'true',
	// 外发邮件日志保留天数：0 = 永久保留
	mail_log_retention_days: '30',
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

	it('默认值：邮件通知开启、SSL 开启', async () => {
		await mountSettings();
		expect(wrapper.vm.form.email_enabled).toBe('true');
		expect(wrapper.vm.form.email_secure).toBe('true');
	});

	it('默认值：邮件保存天数 30 天', async () => {
		await mountSettings();
		expect(wrapper.vm.form.mail_log_retention_days).toBe('30');
		expect(wrapper.get('[data-test="mail-log-retention-days"]').element.value).toBe('30');
	});

	it('加载时回填自定义的邮件保存天数（0 = 永久保留）', async () => {
		await mountSettings({ code: 200, data: { mail_log_retention_days: '0' } });
		expect(wrapper.vm.form.mail_log_retention_days).toBe('0');
		expect(wrapper.get('[data-test="mail-log-retention-days"]').element.value).toBe('0');
	});

	it('默认值：SMTP 与模板字段为空', async () => {
		await mountSettings();
		['smtp_host', 'smtp_port', 'email_user', 'email_password', 'reply_template', 'notification_template']
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
			},
		});
		expect(wrapper.vm.form.smtp_host).toBe('smtp.example.com');
		expect(wrapper.vm.form.smtp_port).toBe('465');
		expect(wrapper.vm.form.email_user).toBe('bot@example.com');
		expect(wrapper.vm.form.email_secure).toBe('false');
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

	it('邮件通知开关仍可正常切换', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
		expect(wrapper.vm.form.email_enabled).toBe('true');
	});

	it('邮件通知页不再包含邮箱验证开关与 API 地址输入框', async () => {
		await mountSettings();
		expect(wrapper.vm.form.email_verify_enabled).toBeUndefined();
		expect(wrapper.vm.form.verify_base_url).toBeUndefined();
		expect(wrapper.find('input[placeholder="https://api.example.com"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('基本设置 → 评论审核');
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

	it('开关以字符串 "true"/"false" 提交', async () => {
		await mountSettings();
		await wrapper.findAll('input[type="checkbox"]')[0].setValue(false);
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().email_enabled).toBe('false');
	});

	it('邮件保存天数：默认提交 30，0 表示永久保留', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().mail_log_retention_days).toBe('30');

		await wrapper.get('[data-test="mail-log-retention-days"]').setValue('0');
		await saveButton().trigger('click');
		await flushPromises();
		expect(lastPayload().mail_log_retention_days).toBe('0');
	});

	it('邮件保存天数：脏值/负数/超限都归一化后再提交', async () => {
		const cases = [
			['7', '7'],
			['030', '30'],
			['-5', '0'],
			['99999', '3650'],
			['abc', '30'],
			['', '30'],
		];
		for (const [input, expected] of cases) {
			await mountSettings();
			await wrapper.get('[data-test="mail-log-retention-days"]').setValue(input);
			await saveButton().trigger('click');
			await flushPromises();
			expect(lastPayload().mail_log_retention_days, input).toBe(expected);
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
	it('按钮固定宽度、不换行（右侧说明文字很长，不能被压成两行）', async () => {
		await mountSettings();
		const button = wrapper.get('[data-test="test-email-button"]');
		expect(button.classes()).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
		expect(button.classes()).toContain('min-w-[152px]');
	});

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

describe('EmailSettings - 模板占位符说明', () => {
	it('展示渲染后的 HTML 占位符（commentContentHtml / replyContentHtml / parentCommentHtml）', async () => {
		await mountSettings();
		const text = wrapper.text();
		expect(text).toContain('{{commentContentHtml}}');
		expect(text).toContain('{{replyContentHtml}}');
		expect(text).toContain('{{parentCommentHtml}}');
	});

	it('说明旧的纯文本占位符仍然可用，但会被 HTML 转义', async () => {
		await mountSettings();
		const text = wrapper.text();
		expect(text).toContain('{{commentContent}}');
		expect(text).toContain('{{replyContent}}');
		expect(text).toContain('{{parentComment}}');
		expect(text).toContain('HTML 转义后的纯文本');
	});

	it('测试邮件提示写明发给通知邮箱（notify_email）', async () => {
		await mountSettings();
		const text = wrapper.text();
		expect(text).toContain('通知邮箱');
		expect(text).toContain('notify_email');
	});

	it('「邮件记录」卡片说明保存天数（0 = 永久保留）并链接到邮件管理页', async () => {
		await mountSettings();
		const section = wrapper.findAll('section').find((item) => item.text().includes('邮件保存天数'));
		expect(section).toBeTruthy();
		expect(section.text()).toContain('邮件记录');
		expect(section.text()).toContain('永久保留');
		expect(section.text()).toContain('3650');

		const link = section.findAll('a').find((a) => a.attributes('href') === '/mails');
		expect(link).toBeTruthy();
		expect(link.text()).toContain('邮件管理');
	});
});

describe('EmailSettings - 模板预览', () => {
	const previewModal = () => wrapper.findComponent(MailPreviewModal);
	const openPreview = async (kind = 'reply') => {
		await wrapper.get(`[data-test="preview-${kind === 'reply' ? 'reply' : 'notification'}-template"]`).trigger('click');
		await flushPromises();
	};
	const basicCalls = () =>
		requestMock.get.mock.calls.filter(([, config]) => config?.params?.type === 'basic');

	/** 按 type 返回不同设置：邮件组返回空模板，基本组返回站点名 */
	const settingsByType = (siteName = '我的博客') => (url, config) => {
		if (config?.params?.type === 'basic') {
			return Promise.resolve({ code: 200, data: { site_name: siteName } });
		}
		return Promise.resolve({ code: 200, data: { reply_template: '', notification_template: '' } });
	};

	it('默认不渲染预览弹窗', async () => {
		await mountSettings();
		expect(previewModal().exists()).toBe(false);
	});

	it('点「预览」用当前尚未保存的模板打开回复预览', async () => {
		await mountSettings();
		await wrapper.findAll('textarea')[0].setValue('<p>{{replyAuthor}}</p>');
		await openPreview('reply');

		const modal = previewModal();
		expect(modal.exists()).toBe(true);
		expect(modal.props('kind')).toBe('reply');
		expect(modal.props('title')).toBe('回复通知预览');
		expect(modal.props('template')).toBe('<p>{{replyAuthor}}</p>');
		// 预览不发请求保存
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('新评论通知模板用 notification 类型与自己的内容', async () => {
		await mountSettings();
		await wrapper.findAll('textarea')[1].setValue('<p>{{commentAuthor}}</p>');
		await openPreview('notification');

		const modal = previewModal();
		expect(modal.props('kind')).toBe('notification');
		expect(modal.props('title')).toBe('新评论通知预览');
		expect(modal.props('template')).toBe('<p>{{commentAuthor}}</p>');
	});

	it('模板留空时弹窗预览默认模板并给出提示', async () => {
		await mountSettings();
		await openPreview('reply');
		expect(previewModal().text()).toContain('内置默认模板');
		expect(previewModal().get('[data-test="mail-preview-hint"]').text()).toContain('不会发送邮件');
	});

	it('打开预览时惰性拉取站点名称，只用于邮件主题', async () => {
		await mountSettings(settingsByType('我的博客'));
		expect(basicCalls()).toHaveLength(0);

		await openPreview('reply');
		expect(basicCalls()).toHaveLength(1);
		expect(basicCalls()[0][0]).toBe('/admin/settings');
		expect(basicCalls()[0][1]).toEqual({ params: { type: 'basic' } });
		expect(previewModal().props('siteName')).toBe('我的博客');
		expect(previewModal().text()).toContain('主题：您在 我的博客 上的评论有了新回复');
	});

	it('站点名称只拉一次：关掉再打开不会重复请求', async () => {
		await mountSettings(settingsByType('我的博客'));
		await openPreview('reply');
		await wrapper.get('[data-test="mail-preview-close"]').trigger('click');
		await flushPromises();
		expect(previewModal().exists()).toBe(false);

		await openPreview('notification');
		expect(basicCalls()).toHaveLength(1);
	});

	it('站点名称拉取失败不影响预览，主题回落 Momo Blog', async () => {
		let calls = 0;
		await mountSettings(() => {
			calls += 1;
			return calls === 1 ? Promise.resolve({ code: 200, data: {} }) : Promise.reject(new Error('boom'));
		});
		await openPreview('reply');
		expect(previewModal().exists()).toBe(true);
		expect(previewModal().props('siteName')).toBe('');
		expect(previewModal().text()).toContain('主题：您在 Momo Blog 上的评论有了新回复');
		expect(errorSpy).toHaveBeenCalled();
	});

	it('关闭预览后弹窗消失，表单内容保持不变', async () => {
		await mountSettings();
		await wrapper.findAll('textarea')[0].setValue('我的模板');
		await openPreview('reply');
		await wrapper.get('[data-test="mail-preview-close"]').trigger('click');
		await flushPromises();

		expect(previewModal().exists()).toBe(false);
		expect(wrapper.vm.form.reply_template).toBe('我的模板');
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
