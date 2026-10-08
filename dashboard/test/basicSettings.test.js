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
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

const DEFAULT_FORM = {
	site_name: '',
	admin_email: '',
	comment_auto_approve: 'true',
	blogger_badge_enabled: 'false',
	blogger_badge_text: '',
	placeholder_name: '',
	placeholder_email: '',
	placeholder_content: '',
	placeholder_url: '',
};

let router;
let pushSpy;
let wrapper;
let errorSpy;

const mountSettings = async (getResponse = { code: 200, data: {} }) => {
	if (typeof getResponse === 'function') requestMock.get.mockImplementation(getResponse);
	else requestMock.get.mockResolvedValue(getResponse);
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

	it('加载成功后填充电表单模型', async () => {
		await mountSettings({
			code: 200,
			data: {
				site_name: '我的博客',
				admin_email: 'admin@example.com',
				comment_auto_approve: 'false',
				blogger_badge_enabled: 'true',
				blogger_badge_text: '博主',
				placeholder_name: '昵称',
			},
		});
		expect(wrapper.vm.form.site_name).toBe('我的博客');
		expect(wrapper.vm.form.admin_email).toBe('admin@example.com');
		expect(wrapper.vm.form.comment_auto_approve).toBe('false');
		expect(wrapper.vm.form.blogger_badge_enabled).toBe('true');
		expect(wrapper.vm.form.placeholder_name).toBe('昵称');
	});

	it('加载的数据会渲染到输入框', async () => {
		await mountSettings({ code: 200, data: { site_name: '我的博客', admin_email: 'a@b.com' } });
		const textInputs = wrapper.findAll('input[type="text"]');
		expect(textInputs[0].element.value).toBe('我的博客');
		expect(wrapper.find('input[type="email"]').element.value).toBe('a@b.com');
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
		['site_name', 'admin_email', 'blogger_badge_text', 'placeholder_name', 'placeholder_email', 'placeholder_content', 'placeholder_url']
			.forEach((key) => expect(wrapper.vm.form[key]).toBe(''));
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
		await switchToggle(1, true);
		expect(wrapper.vm.form.blogger_badge_enabled).toBe('true');
		expect(wrapper.find('input[placeholder="例如：博主"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('已启用');
	});

	it('关闭博主标签后输入框再次隐藏', async () => {
		await mountSettings();
		await switchToggle(1, true);
		await switchToggle(1, false);
		expect(wrapper.find('input[placeholder="例如：博主"]').exists()).toBe(false);
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

	it('保存时提交全部表单字段', async () => {
		await mountSettings();
		await saveButton().trigger('click');
		await flushPromises();
		expect(requestMock.put.mock.calls[0][1]).toEqual(DEFAULT_FORM);
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
		expect(requestMock.get).toHaveBeenCalledTimes(1);
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
