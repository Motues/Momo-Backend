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

import BasicSettings from '../src/views/BasicSettings.vue';
import { createTestRouter, AdminLayoutStub, pickSelectOption } from './support/harness.js';

const DEFAULT_FORM = {
	site_name: '',
	// 站点 API 地址与邮箱验证开关（原「邮件通知」页，已合并到基本设置）
	verify_base_url: '',
	email_verify_enabled: 'false',
	comment_auto_approve: 'true',
	// 审核自动化规则：默认全部为 0（不启用），与后端默认值一致
	comment_spam_max_links: '0',
	comment_spam_min_length: '0',
	comment_spam_duplicate_window: '0',
	comment_spam_keywords: '[]',
	blogger_badge_enabled: 'false',
	blogger_badge_text: '',
	placeholder_name: '',
	placeholder_email: '',
	placeholder_content: '',
	placeholder_url: '',
};

/** 管理员邮箱相关的键单独维护，保存时随 payload 一起提交 */
const DEFAULT_EMAIL_FIELDS = { admin_emails: '[]', notify_email: '', admin_email: '' };
/**
 * 管理员评论密钥：开关始终提交；「开启 + 输入了内容」提交新密钥；
 * 「关闭」提交空串（清除已保存的密钥）；「开启 + 留空」不提交该键（= 不修改）
 */
const DEFAULT_KEY_FIELDS = { admin_comment_key_enabled: 'false', admin_comment_key: '' };
const DEFAULT_PAYLOAD = { ...DEFAULT_FORM, ...DEFAULT_EMAIL_FIELDS, ...DEFAULT_KEY_FIELDS };

let router;
let pushSpy;
let wrapper;
let errorSpy;

/**
 * 页面会发两次 GET：一次 type=basic（主表单），一次 type=security（管理员评论密钥）。
 * 第二个参数用于单独控制 security 的返回。
 */
const mountSettings = async (
	getResponse = { code: 200, data: {} },
	securityResponse = { code: 200, data: {} }
) => {
	requestMock.get.mockImplementation((_url, config) => {
		const response = config?.params?.type === 'security' ? securityResponse : getResponse;
		return typeof response === 'function' ? response() : Promise.resolve(response);
	});
	router = await createTestRouter('/settings/basic');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(BasicSettings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const saveButton = () => wrapper.findAll('button').find((button) => button.text().includes('保存'));
const layout = () => wrapper.findComponent({ name: 'AdminLayout' });

const switchToggle = async (index, value) => {
	await wrapper.findAll('input[type="checkbox"]')[index].setValue(value);
};

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

describe('BasicSettings - 加载', () => {
	it('挂载时以 type=basic 拉取设置', async () => {
		await mountSettings();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'basic' } });
	});

	it('挂载时额外以 type=security 拉取管理员评论密钥', async () => {
		await mountSettings();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'security' } });
		expect(requestMock.get).toHaveBeenCalledTimes(2);
	});

	it('加载成功后填充电表单模型', async () => {
		await mountSettings({
			code: 200,
			data: {
				site_name: '我的博客',
				admin_emails: '["admin@example.com","boss@example.com"]',
				notify_email: 'boss@example.com',
				comment_auto_approve: 'false',
				blogger_badge_enabled: 'true',
				blogger_badge_text: '博主',
				placeholder_name: '昵称',
			},
		});
		expect(wrapper.vm.form.site_name).toBe('我的博客');
		expect(wrapper.vm.adminEmails).toEqual(['admin@example.com', 'boss@example.com']);
		expect(wrapper.vm.notifyEmail).toBe('boss@example.com');
		expect(wrapper.vm.form.comment_auto_approve).toBe('false');
		expect(wrapper.vm.form.blogger_badge_enabled).toBe('true');
		expect(wrapper.vm.form.placeholder_name).toBe('昵称');
	});

	it('加载的数据会渲染到输入框', async () => {
		await mountSettings({ code: 200, data: { site_name: '我的博客' } });
		const textInputs = wrapper.findAll('input[type="text"]');
		expect(textInputs[0].element.value).toBe('我的博客');
		expect(wrapper.get('[data-test="admin-email-input"]').element.value).toBe('');
	});

	it('默认值：评论自动通过为 "true"', async () => {
		await mountSettings({ code: 200, data: {} });
		expect(wrapper.vm.form.comment_auto_approve).toBe('true');
	});

	it('默认值：博主标签关闭', async () => {
		await mountSettings({ code: 200, data: {} });
		expect(wrapper.vm.form.blogger_badge_enabled).toBe('false');
	});

	it('默认值：占位符与文本字段均为空字符串', async () => {
		await mountSettings({ code: 200, data: {} });
		['site_name', 'verify_base_url', 'blogger_badge_text', 'placeholder_name', 'placeholder_email', 'placeholder_content', 'placeholder_url']
			.forEach((key) => expect(wrapper.vm.form[key]).toBe(''));
	});

	it('默认值：管理员邮箱列表为空、通知邮箱为空', async () => {
		await mountSettings({ code: 200, data: {} });
		expect(wrapper.vm.adminEmails).toEqual([]);
		expect(wrapper.vm.notifyEmail).toBe('');
	});

	it('加载后 isDirty 为 false', async () => {
		await mountSettings();
		expect(wrapper.vm.isDirty).toBe(false);
	});

	it('响应缺少 data 时保留默认值', async () => {
		await mountSettings({ code: 500, message: 'err' });
		expect(wrapper.vm.form).toEqual(DEFAULT_FORM);
	});

	it('请求失败时记录错误并保留默认值', async () => {
		await mountSettings(() => Promise.reject(new Error('boom')));
		expect(errorSpy).toHaveBeenCalled();
		expect(wrapper.vm.form.comment_auto_approve).toBe('true');
		expect(wrapper.vm.isDirty).toBe(false);
	});
});

describe('BasicSettings - 开关与条件渲染', () => {
	it('关闭「评论自动通过」后展示已关闭', async () => {
		await mountSettings();
		await switchToggle(0, false);
		expect(wrapper.vm.form.comment_auto_approve).toBe('false');
		expect(wrapper.text()).toContain('已关闭');
	});

	it('再次开启「评论自动通过」回到 "true"', async () => {
		await mountSettings();
		await switchToggle(0, false);
		await switchToggle(0, true);
		expect(wrapper.vm.form.comment_auto_approve).toBe('true');
		expect(wrapper.text()).toContain('已开启');
	});

	it('默认不渲染博主标签文字输入框', async () => {
		await mountSettings();
		expect(wrapper.find('input[placeholder="例如：博主"]').exists()).toBe(false);
	});

	it('开启博主标签后出现自定义标签输入框', async () => {
		await mountSettings();
		await switchToggle(2, true);
		expect(wrapper.vm.form.blogger_badge_enabled).toBe('true');
		expect(wrapper.find('input[placeholder="例如：博主"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('已启用');
	});

	it('关闭博主标签后输入框再次隐藏', async () => {
		await mountSettings();
		await switchToggle(2, true);
		await switchToggle(2, false);
		expect(wrapper.find('input[placeholder="例如：博主"]').exists()).toBe(false);
	});
});

describe('BasicSettings - API 地址与邮箱验证', () => {
	const baseUrlInput = () => wrapper.get('[data-test="verify-base-url"]');
	const emailVerifySwitch = () => wrapper.get('[data-test="email-verify-enabled"]');

	it('站点信息里渲染 API 地址输入框，默认空', async () => {
		await mountSettings();
		expect(baseUrlInput().exists()).toBe(true);
		expect(baseUrlInput().element.value).toBe('');
		expect(wrapper.text()).toContain('不填写时这些功能无法开启');
	});

	it('加载时回填 API 地址与邮箱验证开关', async () => {
		await mountSettings({
			code: 200,
			data: { verify_base_url: 'https://api.example.com', email_verify_enabled: 'true' },
		});
		expect(baseUrlInput().element.value).toBe('https://api.example.com');
		expect(wrapper.vm.form.email_verify_enabled).toBe('true');
	});

	it('API 地址为空时邮箱验证开关禁用；填上地址后可用', async () => {
		await mountSettings();
		expect(emailVerifySwitch().attributes('disabled')).toBeDefined();

		await baseUrlInput().setValue('https://api.example.com');
		expect(emailVerifySwitch().attributes('disabled')).toBeUndefined();
	});

	it('已开启的旧配置即使没有地址也允许关闭', async () => {
		await mountSettings({
			code: 200,
			data: { email_verify_enabled: 'true' },
		});
		expect(emailVerifySwitch().attributes('disabled')).toBeUndefined();
	});

	it('非法的 API 地址拒绝保存', async () => {
		await mountSettings();
		await baseUrlInput().setValue('api.example.com');
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('API 地址必须是 http(s) 开头的完整地址');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('只有斜杠的 API 地址不会被当成空串放过', async () => {
		await mountSettings();
		await baseUrlInput().setValue('///');
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('API 地址必须是 http(s) 开头的完整地址');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('邮箱验证开启但 API 地址为空时拒绝保存', async () => {
		await mountSettings();
		wrapper.vm.form.email_verify_enabled = 'true';
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('邮箱验证开启时必须填写 API 地址');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('保存时提交归一化后的 API 地址与邮箱验证开关', async () => {
		await mountSettings();
		await baseUrlInput().setValue('https://api.example.com///');
		await emailVerifySwitch().setValue(true);
		await saveButton().trigger('click');
		await flushPromises();
		const payload = requestMock.put.mock.calls.at(-1)[1];
		expect(payload.verify_base_url).toBe('https://api.example.com');
		expect(payload.email_verify_enabled).toBe('true');
		expect(wrapper.vm.form.verify_base_url).toBe('https://api.example.com');
	});
});

describe('BasicSettings - 保存', () => {
	it('保存请求为 PUT /admin/settings', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(requestMock.put.mock.calls[0][0]).toBe('/admin/settings');
	});

	it('保存时提交全部表单字段（含管理员邮箱三项）', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(requestMock.put.mock.calls[0][1]).toEqual(DEFAULT_PAYLOAD);
	});

	it('保存时提交用户修改后的值', async () => {
		await mountSettings();
		await wrapper.find('input[type="text"]').setValue('新站点名');
		await switchToggle(0, false);
		await saveButton().trigger('click');
		await flushPromises();
		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.site_name).toBe('新站点名');
		expect(payload.comment_auto_approve).toBe('false');
	});

	it('保存成功后提示并展示保存成功标记', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).toHaveBeenCalledWith('设置已保存');
		expect(wrapper.text()).toContain('保存成功');
	});

	it('保存成功后 isDirty 复位', async () => {
		await mountSettings();
		await wrapper.find('input[type="text"]').setValue('改动');
		expect(wrapper.vm.isDirty).toBe(true);
		await saveButton().trigger('click');
		await flushPromises();
		expect(wrapper.vm.isDirty).toBe(false);
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
		expect(saveButton().attributes('disabled')).toBeUndefined();
	});

	it('保存失败时不显示成功标记', async () => {
		await mountSettings();
		requestMock.put.mockRejectedValue(new Error('boom'));
		await saveButton().trigger('click');
		await flushPromises();
		expect(wrapper.text()).not.toContain('保存成功');
		expect(errorSpy).toHaveBeenCalled();
	});

	it('保存失败后 isDirty 保持为 true', async () => {
		await mountSettings();
		await wrapper.find('input[type="text"]').setValue('改动');
		requestMock.put.mockRejectedValue(new Error('boom'));
		await saveButton().trigger('click');
		await flushPromises();
		expect(wrapper.vm.isDirty).toBe(true);
	});

	it('业务 code 非 200 时不提示成功', async () => {
		await mountSettings();
		requestMock.put.mockResolvedValue({ code: 400, message: 'bad' });
		await saveButton().trigger('click');
		await flushPromises();
		expect(toastMock.success).not.toHaveBeenCalled();
		expect(wrapper.text()).not.toContain('保存成功');
	});
});

describe('BasicSettings - 审核自动化规则', () => {
	const numberInputs = () => wrapper.findAll('input[type="number"]');

	it('开启自动通过时展示规则区，关闭后隐藏', async () => {
		await mountSettings();
		expect(wrapper.text()).toContain('审核自动化规则');
		await switchToggle(0, false);
		expect(wrapper.text()).not.toContain('审核自动化规则');
	});

	it('未配置时四项阈值均为 0（不启用任何规则）', async () => {
		await mountSettings({ code: 200, data: {} });
		expect(wrapper.vm.form.comment_spam_max_links).toBe('0');
		expect(wrapper.vm.form.comment_spam_min_length).toBe('0');
		expect(wrapper.vm.form.comment_spam_duplicate_window).toBe('0');
		expect(wrapper.vm.spamKeywords).toEqual([]);
	});

	it('规则区展示建议值占位符', async () => {
		await mountSettings();
		const placeholders = numberInputs().map((input) => input.attributes('placeholder'));
		expect(placeholders).toEqual(['建议 3', '建议 5', '建议 10']);
	});

	it('加载已保存的阈值与关键词', async () => {
		await mountSettings({
			code: 200,
			data: {
				comment_spam_max_links: '5',
				comment_spam_min_length: '0',
				comment_spam_duplicate_window: '60',
				comment_spam_keywords: '["加微信","casino"]',
			},
		});
		expect(wrapper.vm.form.comment_spam_max_links).toBe('5');
		expect(wrapper.vm.form.comment_spam_min_length).toBe('0');
		expect(wrapper.vm.form.comment_spam_duplicate_window).toBe('60');
		expect(wrapper.vm.spamKeywords).toEqual(['加微信', 'casino']);
		expect(wrapper.text()).toContain('加微信');
	});

	it('关键词配置损坏时按空列表处理', async () => {
		await mountSettings({ code: 200, data: { comment_spam_keywords: '{oops' } });
		expect(wrapper.vm.spamKeywords).toEqual([]);
	});

	it('添加与删除关键词', async () => {
		await mountSettings();
		await wrapper.find('input[placeholder="例如：加微信"]').setValue('博彩');
		await wrapper.findAll('button').find((button) => button.text() === '添加').trigger('click');
		expect(wrapper.vm.spamKeywords).toEqual(['博彩']);

		// 点击标签上的 × 删除
		await wrapper.find('span.bg-blue-50 button').trigger('click');
		expect(wrapper.vm.spamKeywords).toEqual([]);
	});

	it('相同关键词不会重复添加，空白关键词被忽略', async () => {
		await mountSettings();
		await wrapper.find('input[placeholder="例如：加微信"]').setValue('spam');
		await wrapper.findAll('button').find((button) => button.text() === '添加').trigger('click');
		await wrapper.find('input[placeholder="例如：加微信"]').setValue('spam');
		await wrapper.findAll('button').find((button) => button.text() === '添加').trigger('click');
		expect(wrapper.vm.spamKeywords).toEqual(['spam']);

		await wrapper.find('input[placeholder="例如：加微信"]').setValue('   ');
		expect(wrapper.findAll('button').find((button) => button.text() === '添加').attributes('disabled')).toBeDefined();
	});

	it('保存时提交关键词 JSON 与归一化后的阈值', async () => {
		await mountSettings();
		await wrapper.find('input[placeholder="例如：加微信"]').setValue('加微信');
		await wrapper.findAll('button').find((button) => button.text() === '添加').trigger('click');
		await numberInputs()[0].setValue('10');
		await numberInputs()[1].setValue('0');
		await numberInputs()[2].setValue('0');
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.comment_spam_keywords).toBe('["加微信"]');
		expect(payload.comment_spam_max_links).toBe('10');
		expect(payload.comment_spam_min_length).toBe('0');
		expect(payload.comment_spam_duplicate_window).toBe('0');
	});

	it('阈值超出上限时按上限夹取', async () => {
		await mountSettings();
		await numberInputs()[0].setValue('999');
		await numberInputs()[1].setValue('99999');
		await numberInputs()[2].setValue('999999');
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.comment_spam_max_links).toBe('50');
		expect(payload.comment_spam_min_length).toBe('2000');
		expect(payload.comment_spam_duplicate_window).toBe('10080');
		// 归一化结果写回表单，页面显示与实际落库一致
		expect(wrapper.vm.form.comment_spam_max_links).toBe('50');
		expect(wrapper.vm.form.comment_spam_min_length).toBe('2000');
		expect(wrapper.vm.form.comment_spam_duplicate_window).toBe('10080');
	});

	it('阈值非法（负数/空）时退回默认值 0', async () => {
		await mountSettings();
		await numberInputs()[0].setValue('');
		await numberInputs()[1].setValue('-3');
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.comment_spam_max_links).toBe('0');
		expect(payload.comment_spam_min_length).toBe('0');
	});

	it('修改规则会标记为未保存', async () => {
		await mountSettings();
		expect(wrapper.vm.isDirty).toBe(false);
		await wrapper.find('input[placeholder="例如：加微信"]').setValue('spam');
		await wrapper.findAll('button').find((button) => button.text() === '添加').trigger('click');
		expect(wrapper.vm.isDirty).toBe(true);
	});
});

describe('BasicSettings - 管理员邮箱列表', () => {
	const emailInput = () => wrapper.get('[data-test="admin-email-input"]');
	const addButton = () => wrapper.get('[data-test="admin-email-add"]');
	const emailError = () => wrapper.find('[data-test="admin-email-error"]');
	const chips = () => wrapper.findAll('[data-test="admin-email-remove"]');
	const notifyTrigger = () => wrapper.get('[data-test="notify-email"] button');

	const addEmail = async (value) => {
		await emailInput().setValue(value);
		await addButton().trigger('click');
	};

	it('加载 admin_emails 并以标签渲染，通知邮箱默认取列表第一个', async () => {
		await mountSettings({
			code: 200,
			data: { admin_emails: '["a@example.com","b@example.com"]' },
		});
		expect(wrapper.vm.adminEmails).toEqual(['a@example.com', 'b@example.com']);
		expect(wrapper.vm.notifyEmail).toBe('a@example.com');
		expect(chips()).toHaveLength(2);
		expect(wrapper.text()).toContain('a@example.com');
	});

	it('admin_emails 为空时回落旧键 admin_email', async () => {
		await mountSettings({ code: 200, data: { admin_emails: '[]', admin_email: '  Admin@Example.com  ' } });
		expect(wrapper.vm.adminEmails).toEqual(['admin@example.com']);
		expect(wrapper.vm.notifyEmail).toBe('admin@example.com');
	});

	it('admin_emails 是脏值时回落旧键；旧键也非法时视为没有管理员', async () => {
		await mountSettings({ code: 200, data: { admin_emails: '{oops', admin_email: 'admin@example.com' } });
		expect(wrapper.vm.adminEmails).toEqual(['admin@example.com']);

		wrapper.unmount();
		await mountSettings({ code: 200, data: { admin_emails: '{"a":1}', admin_email: 'not-an-email' } });
		expect(wrapper.vm.adminEmails).toEqual([]);
		expect(wrapper.vm.notifyEmail).toBe('');
	});

	it('读取路径丢弃非法项与重复项，并截断到前 10 个', async () => {
		const many = Array.from({ length: 12 }, (_, index) => `u${index}@example.com`);
		await mountSettings({
			code: 200,
			data: { admin_emails: JSON.stringify(['A@Example.com', 'a@example.com', 'bad', 7, ...many]) },
		});
		expect(wrapper.vm.adminEmails).toHaveLength(10);
		expect(wrapper.vm.adminEmails[0]).toBe('a@example.com');
	});

	it('按回车添加与点「添加」等价，输入会被 trim + 转小写', async () => {
		await mountSettings();
		await emailInput().setValue('  Admin@Example.com  ');
		await emailInput().trigger('keydown.enter');
		expect(wrapper.vm.adminEmails).toEqual(['admin@example.com']);
		expect(emailInput().element.value).toBe('');
		expect(wrapper.vm.isDirty).toBe(true);
	});

	it('重复邮箱（不区分大小写）被拒绝并内联提示', async () => {
		await mountSettings({ code: 200, data: { admin_emails: '["a@example.com"]' } });
		await addEmail('A@EXAMPLE.COM');

		expect(wrapper.vm.adminEmails).toEqual(['a@example.com']);
		expect(emailError().text()).toBe('该邮箱已在列表中');
	});

	it('非法邮箱被拒绝并内联提示', async () => {
		await mountSettings();
		await addEmail('not-an-email');

		expect(wrapper.vm.adminEmails).toEqual([]);
		expect(emailError().text()).toBe('请输入合法的邮箱地址');
	});

	it('最多 10 个管理员邮箱', async () => {
		const ten = Array.from({ length: 10 }, (_, index) => `u${index}@example.com`);
		await mountSettings({ code: 200, data: { admin_emails: JSON.stringify(ten) } });
		await addEmail('extra@example.com');

		expect(wrapper.vm.adminEmails).toHaveLength(10);
		expect(emailError().text()).toBe('最多 10 个管理员邮箱');
	});

	it('输入变化会清掉上一次的错误提示', async () => {
		await mountSettings();
		await addEmail('bad');
		expect(emailError().exists()).toBe(true);
		await emailInput().setValue('a@example.com');
		expect(emailError().exists()).toBe(false);
	});

	it('删除某个邮箱后通知邮箱回落到列表第一个', async () => {
		await mountSettings({ code: 200, data: { admin_emails: '["a@example.com","b@example.com"]' } });
		await wrapper.vm.$nextTick();
		await pickSelectOption(wrapper, 'b@example.com');
		expect(wrapper.vm.notifyEmail).toBe('b@example.com');

		await chips()[1].trigger('click');
		expect(wrapper.vm.adminEmails).toEqual(['a@example.com']);
		expect(wrapper.vm.notifyEmail).toBe('a@example.com');
	});

	it('列表为空时通知邮箱选择器禁用并给出提示', async () => {
		await mountSettings({ code: 200, data: {} });
		expect(notifyTrigger().attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-test="notify-hint"]').text()).toContain('列表为空');

		await addEmail('a@example.com');
		expect(notifyTrigger().attributes('disabled')).toBeUndefined();
		expect(wrapper.vm.notifyEmail).toBe('a@example.com');
	});

	it('保存时提交 admin_emails / notify_email / 旧键 admin_email', async () => {
		await mountSettings({ code: 200, data: { admin_emails: '["a@example.com","b@example.com"]' } });
		await pickSelectOption(wrapper, 'b@example.com');
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.admin_emails).toBe('["a@example.com","b@example.com"]');
		expect(payload.notify_email).toBe('b@example.com');
		expect(payload.admin_email).toBe('b@example.com');
	});

	it('未选择通知邮箱时提交列表第一个（旧键同值）', async () => {
		await mountSettings({ code: 200, data: { admin_emails: '["a@example.com","b@example.com"]' } });
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.notify_email).toBe('a@example.com');
		expect(payload.admin_email).toBe('a@example.com');
	});

	it('列表为空时提交空字符串（清空通知邮箱，不报错）', async () => {
		await mountSettings({ code: 200, data: {} });
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.admin_emails).toBe('[]');
		expect(payload.notify_email).toBe('');
		expect(payload.admin_email).toBe('');
	});

	it('新增邮箱会标记为未保存，保存成功后复位', async () => {
		await mountSettings();
		expect(wrapper.vm.isDirty).toBe(false);
		await addEmail('a@example.com');
		expect(wrapper.vm.isDirty).toBe(true);

		await saveButton().trigger('click');
		await flushPromises();
		expect(wrapper.vm.isDirty).toBe(false);
	});

	it('切换通知邮箱会标记为未保存', async () => {
		await mountSettings({ code: 200, data: { admin_emails: '["a@example.com","b@example.com"]' } });
		await pickSelectOption(wrapper, 'b@example.com');
		expect(wrapper.vm.isDirty).toBe(true);
	});
});

describe('BasicSettings - 管理员评论密钥', () => {
	const keySwitch = () => wrapper.get('[data-test="admin-comment-key-enabled"]');
	const keyInput = () => wrapper.find('[data-test="admin-comment-key"]');

	it('默认开关关闭，且不渲染密钥输入框', async () => {
		await mountSettings();
		expect(wrapper.vm.adminCommentKeyEnabled).toBe(false);
		expect(wrapper.vm.adminCommentKey).toBe('');
		expect(keyInput().exists()).toBe(false);
		expect(wrapper.text()).toContain('管理员评论密钥');
		expect(wrapper.text()).toContain('已禁用');
	});

	it('加载 security 组时回填开关与密钥（敏感键始终返回空串）', async () => {
		await mountSettings({ code: 200, data: {} }, {
			code: 200,
			data: { admin_comment_key: '', admin_comment_key_enabled: 'true' },
		});
		expect(wrapper.vm.adminCommentKeyEnabled).toBe(true);
		expect(wrapper.vm.adminCommentKey).toBe('');
		expect(keyInput().exists()).toBe(true);
		expect(keyInput().element.value).toBe('');
	});

	it('启用开关后出现密钥输入框', async () => {
		await mountSettings();
		await keySwitch().setValue(true);
		expect(wrapper.vm.adminCommentKeyEnabled).toBe(true);
		expect(keyInput().exists()).toBe(true);
		expect(wrapper.text()).toContain('已启用');
	});

	it('输入密钥后标记为未保存，保存成功后复位', async () => {
		await mountSettings({ code: 200, data: {} }, { code: 200, data: { admin_comment_key_enabled: 'true' } });
		expect(wrapper.vm.isDirty).toBe(false);
		await keyInput().setValue('my-key');
		expect(wrapper.vm.isDirty).toBe(true);

		await saveButton().trigger('click');
		await flushPromises();
		expect(wrapper.vm.isDirty).toBe(false);
	});

	it('开关关闭时提交空串（清除已保存的密钥）与 false', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.admin_comment_key).toBe('');
		expect(payload.admin_comment_key_enabled).toBe('false');
	});

	it('开关开启但密钥留空：不提交 admin_comment_key（留空 = 不修改）', async () => {
		await mountSettings({ code: 200, data: {} }, { code: 200, data: { admin_comment_key_enabled: 'true' } });
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(Object.keys(payload)).not.toContain('admin_comment_key');
		expect(payload.admin_comment_key_enabled).toBe('true');
	});

	it('输入密钥后提交 admin_comment_key，开关为 true', async () => {
		await mountSettings();
		await keySwitch().setValue(true);
		await keyInput().setValue('my-key');
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.admin_comment_key).toBe('my-key');
		expect(payload.admin_comment_key_enabled).toBe('true');
	});

	it('关闭开关时提交空串清除密钥（与历史行为一致）', async () => {
		await mountSettings({ code: 200, data: {} }, { code: 200, data: { admin_comment_key_enabled: 'true' } });
		await keySwitch().setValue(false);
		await saveButton().trigger('click');
		await flushPromises();

		const payload = requestMock.put.mock.calls[0][1];
		expect(payload.admin_comment_key_enabled).toBe('false');
		expect(payload.admin_comment_key).toBe('');
	});

	it('切换开关会更新文案', async () => {
		await mountSettings();
		expect(wrapper.text()).toContain('已禁用');
		await keySwitch().setValue(true);
		expect(wrapper.text()).toContain('已启用');
	});
});

describe('BasicSettings - 布局交互', () => {
	it('baseUrl 取自 localStorage 的 apiUrl', async () => {
		localStorage.setItem('apiUrl', 'https://api.example.com');
		await mountSettings();
		expect(layout().props('baseUrl')).toBe('https://api.example.com');
	});

	it('localStorage 没有 apiUrl 时回落到当前源', async () => {
		await mountSettings();
		expect(layout().props('baseUrl')).toBe(window.location.origin);
	});

	it('refresh 事件会重新拉取设置', async () => {
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
