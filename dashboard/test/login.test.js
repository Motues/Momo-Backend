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

import Login from '../src/views/Login.vue';
import { createTestRouter } from './support/harness.js';
import { API_URL_REQUIREMENT } from '../src/utils/apiUrl.js';

const API_INPUT = 'input[placeholder="后端 API 地址"]';
const NAME_INPUT = 'input[placeholder="用户名"]';
const PASSWORD_INPUT = 'input[placeholder="密码"]';
const SUBMIT = 'button[type="submit"]';

let router;
let pushSpy;
let wrapper;

const mountLogin = async () => {
	router = await createTestRouter('/login');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(Login, { global: { plugins: [router] } });
	await flushPromises();
	return wrapper;
};

const submitLogin = async () => {
	await wrapper.find('form').trigger('submit');
	await flushPromises();
};

const fill = async ({ apiUrl, name, password } = {}) => {
	if (apiUrl !== undefined) await wrapper.find(API_INPUT).setValue(apiUrl);
	if (name !== undefined) await wrapper.find(NAME_INPUT).setValue(name);
	if (password !== undefined) await wrapper.find(PASSWORD_INPUT).setValue(password);
};

beforeEach(async () => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
	requestMock.post.mockResolvedValue({ code: 200, token: 'token-1' });
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
	pushSpy?.mockRestore();
});

describe('Login - 初始状态', () => {
	it('localStorage 有 apiUrl 时作为默认值', async () => {
		localStorage.setItem('apiUrl', 'https://saved.example.com');
		await mountLogin();
		expect(wrapper.find(API_INPUT).element.value).toBe('https://saved.example.com');
	});

	it('localStorage 没有 apiUrl 时回落到 window.location.origin', async () => {
		await mountLogin();
		expect(wrapper.find(API_INPUT).element.value).toBe(window.location.origin);
	});

	it('用户名与密码默认为空', async () => {
		await mountLogin();
		expect(wrapper.find(NAME_INPUT).element.value).toBe('');
		expect(wrapper.find(PASSWORD_INPUT).element.value).toBe('');
	});

	it('默认同源 http 地址不产生安全提示', async () => {
		await mountLogin();
		expect(window.location.origin.startsWith('http://')).toBe(true);
		expect(wrapper.text()).not.toContain(API_URL_REQUIREMENT);
	});

	it('初始不显示改密弹窗', async () => {
		await mountLogin();
		expect(wrapper.text()).not.toContain('安全保护');
	});
});

describe('Login - API 地址安全提示', () => {
	it('https 地址不提示', async () => {
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com' });
		expect(wrapper.text()).not.toContain(API_URL_REQUIREMENT);
	});

	it('本机 http 地址不提示', async () => {
		await mountLogin();
		await fill({ apiUrl: 'http://127.0.0.1:3000' });
		expect(wrapper.text()).not.toContain(API_URL_REQUIREMENT);
	});

	it('相对路径不提示', async () => {
		await mountLogin();
		await fill({ apiUrl: '/api' });
		expect(wrapper.text()).not.toContain(API_URL_REQUIREMENT);
	});

	it('空字符串不提示（避免初次进入就报红）', async () => {
		await mountLogin();
		await fill({ apiUrl: '' });
		expect(wrapper.text()).not.toContain(API_URL_REQUIREMENT);
	});

	it.each([
		['跨源明文 http', 'http://evil.com'],
		['缺少 scheme', 'evil.com'],
		['协议相对地址', '//evil.com'],
		['javascript:', 'javascript:alert(1)'],
	])('%s 会显示安全要求提示', async (_label, value) => {
		await mountLogin();
		await fill({ apiUrl: value });
		expect(wrapper.text()).toContain(API_URL_REQUIREMENT);
	});
});

describe('Login - 登录表单校验', () => {
	it('用户名与密码都为空时不发请求并提示', async () => {
		await mountLogin();
		await submitLogin();
		expect(toastMock.warning).toHaveBeenCalledWith('请填写用户名和密码');
		expect(requestMock.post).not.toHaveBeenCalled();
	});

	it('只填用户名时不发请求', async () => {
		await mountLogin();
		await fill({ name: 'admin' });
		await submitLogin();
		expect(toastMock.warning).toHaveBeenCalledWith('请填写用户名和密码');
		expect(requestMock.post).not.toHaveBeenCalled();
	});

	it('只填密码时不发请求', async () => {
		await mountLogin();
		await fill({ password: 'secret' });
		await submitLogin();
		expect(requestMock.post).not.toHaveBeenCalled();
	});
});

describe('Login - API 地址白名单（防 token 外发）', () => {
	it.each([
		['跨源 http', 'http://evil.com'],
		['协议相对地址', '//evil.com'],
		['缺少 scheme', 'evil.com'],
		['javascript 伪协议', 'javascript:alert(1)'],
	])('地址为 %s 时拒绝登录', async (_label, value) => {
		await mountLogin();
		await fill({ apiUrl: value, name: 'admin', password: 'secret' });
		await submitLogin();
		expect(requestMock.post).not.toHaveBeenCalled();
		expect(toastMock.error).toHaveBeenCalledWith(`API 地址无效：${API_URL_REQUIREMENT}`);
		expect(localStorage.getItem('apiUrl')).toBeNull();
	});

	it('非法地址不会覆盖已有的 apiUrl', async () => {
		localStorage.setItem('apiUrl', 'https://good.example.com');
		await mountLogin();
		await fill({ apiUrl: 'http://evil.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(localStorage.getItem('apiUrl')).toBe('https://good.example.com');
	});

	it('合法地址会被写入 localStorage', async () => {
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(localStorage.getItem('apiUrl')).toBe('https://api.example.com');
	});

	it('结尾斜杠会被归一化后写入', async () => {
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com/', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(localStorage.getItem('apiUrl')).toBe('https://api.example.com');
	});
});

describe('Login - 登录成功路径', () => {
	it('携带用户名密码请求 /admin/login', async () => {
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(requestMock.post).toHaveBeenCalledWith('/admin/login', { name: 'admin', password: 'secret' });
	});

	it('写入 token 与 admin_name', async () => {
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(localStorage.getItem('token')).toBe('token-1');
		expect(localStorage.getItem('admin_name')).toBe('admin');
	});

	it('提示欢迎并跳转首页', async () => {
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(toastMock.success).toHaveBeenCalledWith('欢迎回来');
		expect(pushSpy).toHaveBeenCalledWith('/');
	});

	it('needChangePassword 为 true 时弹出改密弹窗且不跳转', async () => {
		requestMock.post.mockResolvedValue({ code: 200, token: 't', needChangePassword: true });
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(wrapper.text()).toContain('安全保护');
		expect(toastMock.success).toHaveBeenCalledWith('欢迎回来');
		expect(pushSpy).not.toHaveBeenCalled();
		expect(localStorage.getItem('token')).toBe('t');
	});

	it('业务 code 不是 200 时不写入 token、不跳转', async () => {
		requestMock.post.mockResolvedValue({ code: 400, message: '密码错误' });
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'wrong' });
		await submitLogin();
		expect(localStorage.getItem('token')).toBeNull();
		expect(pushSpy).not.toHaveBeenCalled();
	});

	it('请求期间按钮禁用并显示「验证中...」', async () => {
		let resolvePost;
		requestMock.post.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await wrapper.find('form').trigger('submit');
		await flushPromises();
		expect(wrapper.find(SUBMIT).text()).toBe('验证中...');
		expect(wrapper.find(SUBMIT).attributes('disabled')).toBeDefined();
		resolvePost({ code: 200, token: 't' });
		await flushPromises();
		expect(wrapper.find(SUBMIT).text()).toBe('登录');
		expect(wrapper.find(SUBMIT).attributes('disabled')).toBeUndefined();
	});

	it('请求失败时提示并恢复按钮状态', async () => {
		requestMock.post.mockRejectedValue(new Error('boom'));
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(toastMock.error).toHaveBeenCalledWith('登录失败，请检查配置');
		expect(wrapper.find(SUBMIT).text()).toBe('登录');
		expect(localStorage.getItem('token')).toBeNull();
	});

	it('非法地址时按钮不会卡在加载态', async () => {
		await mountLogin();
		await fill({ apiUrl: 'http://evil.com', name: 'admin', password: 'secret' });
		await submitLogin();
		expect(wrapper.find(SUBMIT).text()).toBe('登录');
		expect(wrapper.find(SUBMIT).attributes('disabled')).toBeUndefined();
	});
});

describe('Login - 清除按钮', () => {
	it('清空用户名与密码但保留 API 地址', async () => {
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'admin', password: 'secret' });
		await wrapper.findAll('button').find((b) => b.text() === '清除').trigger('click');
		expect(wrapper.find(NAME_INPUT).element.value).toBe('');
		expect(wrapper.find(PASSWORD_INPUT).element.value).toBe('');
		expect(wrapper.find(API_INPUT).element.value).toBe('https://api.example.com');
	});

	it('清除不会发起请求', async () => {
		await mountLogin();
		await fill({ name: 'admin', password: 'secret' });
		await wrapper.findAll('button').find((b) => b.text() === '清除').trigger('click');
		expect(requestMock.post).not.toHaveBeenCalled();
	});
});

describe('Login - 首次登录改密弹窗', () => {
	const openPasswordModal = async () => {
		requestMock.post.mockResolvedValue({ code: 200, token: 't', needChangePassword: true });
		await mountLogin();
		await fill({ apiUrl: 'https://api.example.com', name: 'old-admin', password: 'old-pass' });
		await submitLogin();
	};

	const fillPasswordForm = async ({ newName = 'new-admin', newPassword = 'newpass', confirm = 'newpass' } = {}) => {
		await wrapper.find('input[placeholder="新用户名"]').setValue(newName);
		await wrapper.find('input[placeholder="新密码"]').setValue(newPassword);
		await wrapper.find('input[placeholder="确认新密码"]').setValue(confirm);
	};

	it('展示改密表单的输入框', async () => {
		await openPasswordModal();
		expect(wrapper.find('input[placeholder="新用户名"]').exists()).toBe(true);
		expect(wrapper.find('input[placeholder="新密码"]').exists()).toBe(true);
		expect(wrapper.find('input[placeholder="确认新密码"]').exists()).toBe(true);
	});

	it('两次密码不一致时提示且不发请求', async () => {
		await openPasswordModal();
		requestMock.put.mockClear();
		await fillPasswordForm({ newPassword: 'newpass', confirm: 'other' });
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(toastMock.warning).toHaveBeenCalledWith('两次输入的密码不一致');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('密码少于 4 位时提示且不发请求', async () => {
		await openPasswordModal();
		requestMock.put.mockClear();
		await fillPasswordForm({ newPassword: 'abc', confirm: 'abc' });
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(toastMock.warning).toHaveBeenCalledWith('密码长度不能少于4位');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('缺少确认密码时提示不一致', async () => {
		await openPasswordModal();
		requestMock.put.mockClear();
		await wrapper.find('input[placeholder="新用户名"]').setValue('new-admin');
		await wrapper.find('input[placeholder="新密码"]').setValue('newpass');
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(toastMock.warning).toHaveBeenCalledWith('两次输入的密码不一致');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('实时校验：密码过短展示错误样式与提示', async () => {
		await openPasswordModal();
		await wrapper.find('input[placeholder="新密码"]').setValue('ab');
		expect(wrapper.text()).toContain('密码长度不能少于 4 位');
	});

	it('实时校验：两次不一致展示提示', async () => {
		await openPasswordModal();
		await wrapper.find('input[placeholder="新密码"]').setValue('abcd');
		await wrapper.find('input[placeholder="确认新密码"]').setValue('abce');
		expect(wrapper.text()).toContain('两次输入的密码不一致');
	});

	it('实时校验：合法输入不再展示错误提示', async () => {
		await openPasswordModal();
		await fillPasswordForm();
		expect(wrapper.text()).not.toContain('密码长度不能少于 4 位');
		expect(wrapper.text()).not.toContain('两次输入的密码不一致');
	});

	it('提交旧凭据与新凭据到 /admin/password', async () => {
		await openPasswordModal();
		requestMock.put.mockResolvedValue({ code: 200 });
		await fillPasswordForm();
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(requestMock.put).toHaveBeenCalledWith('/admin/password', {
			old_name: 'old-admin',
			old_password: 'old-pass',
			new_name: 'new-admin',
			new_password: 'newpass',
		});
	});

	it('改密成功后清除 token 并关闭弹窗', async () => {
		await openPasswordModal();
		requestMock.put.mockResolvedValue({ code: 200 });
		await fillPasswordForm();
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(toastMock.success).toHaveBeenCalledWith('管理员凭据已更新，请重新登录');
		expect(localStorage.getItem('token')).toBeNull();
		expect(wrapper.text()).not.toContain('安全保护');
	});

	it('改密成功后清空登录表单的凭据', async () => {
		await openPasswordModal();
		requestMock.put.mockResolvedValue({ code: 200 });
		await fillPasswordForm();
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(wrapper.find(NAME_INPUT).element.value).toBe('');
		expect(wrapper.find(PASSWORD_INPUT).element.value).toBe('');
	});

	it('改密请求失败时提示', async () => {
		await openPasswordModal();
		requestMock.put.mockRejectedValue(new Error('boom'));
		await fillPasswordForm();
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('密码更新失败');
	});

	it('改密请求失败后按钮恢复可用', async () => {
		await openPasswordModal();
		requestMock.put.mockRejectedValue(new Error('boom'));
		await fillPasswordForm();
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		const submitBtn = wrapper.findAll('form')[1].find('button[type="submit"]');
		expect(submitBtn.text()).toBe('确认更新');
		expect(submitBtn.attributes('disabled')).toBeUndefined();
	});

	it('改密成功后 token 被清除，故不会写入新 token', async () => {
		await openPasswordModal();
		requestMock.put.mockResolvedValue({ code: 200 });
		await fillPasswordForm();
		await wrapper.findAll('form')[1].trigger('submit');
		await flushPromises();
		expect(localStorage.getItem('token')).toBeNull();
	});
});
