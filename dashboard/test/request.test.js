import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ---------- 依赖 mock：axios 传输层与 toast ---------- */
const axiosMock = vi.hoisted(() => {
	const requestHandlers = [];
	const responseHandlers = [];
	const instance = {
		interceptors: {
			request: {
				use: (fulfilled, rejected) => {
					requestHandlers.push({ fulfilled, rejected });
					return requestHandlers.length;
				},
			},
			response: {
				use: (fulfilled, rejected) => {
					responseHandlers.push({ fulfilled, rejected });
					return responseHandlers.length;
				},
			},
		},
	};
	return { requestHandlers, responseHandlers, instance };
});

const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('axios', () => ({ default: { create: vi.fn(() => axiosMock.instance) } }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

/* ---------- 被测模块 ---------- */
import axios from 'axios';
import service from '../src/utils/request.js';
import toast from '../src/utils/toast.js';
import router from '../src/router/index.js';

/**
 * request.js 在模块加载时就调用了 axios.create，
 * 这里在导入后立刻把入参快照下来，避免被后续的 mock 清理影响。
 */
const createCallArgs = axios.create.mock.calls.map((call) => call[0]);

const runRequest = (config = {}) => axiosMock.requestHandlers[0].fulfilled({ headers: {}, ...config });
const runResponse = (data) => axiosMock.responseHandlers[0].fulfilled({ data });
const runResponseError = (error) => axiosMock.responseHandlers[0].rejected(error);

let pushSpy;
let warnSpy;

beforeEach(() => {
	localStorage.clear();
	Object.values(toastMock).forEach((fn) => fn.mockClear());
	pushSpy = vi.spyOn(router, 'push').mockResolvedValue();
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	pushSpy.mockRestore();
	warnSpy.mockRestore();
});

describe('axios 实例与拦截器注册', () => {
	it('实例就是 axios.create 的返回值', () => {
		expect(service).toBe(axiosMock.instance);
	});

	it('以 10 秒超时创建实例', () => {
		expect(createCallArgs).toEqual([{ timeout: 10000 }]);
	});

	it('注册了一个请求拦截器与一个响应拦截器', () => {
		expect(axiosMock.requestHandlers).toHaveLength(1);
		expect(axiosMock.responseHandlers).toHaveLength(1);
	});

	it('两个拦截器都提供了错误处理分支', () => {
		expect(typeof axiosMock.requestHandlers[0].rejected).toBe('function');
		expect(typeof axiosMock.responseHandlers[0].rejected).toBe('function');
	});
});

describe('请求拦截器 - apiUrl 白名单', () => {
	it('localStorage 没有 apiUrl 时不修改 baseURL', () => {
		const config = runRequest({ baseURL: undefined });
		expect(config.baseURL).toBeUndefined();
	});

	it('合法的 apiUrl 写入 baseURL', () => {
		localStorage.setItem('apiUrl', 'https://api.example.com');
		expect(runRequest().baseURL).toBe('https://api.example.com');
	});

	it('原样使用 localStorage 中的值（不额外归一化结尾斜杠）', () => {
		localStorage.setItem('apiUrl', 'https://api.example.com/');
		expect(runRequest().baseURL).toBe('https://api.example.com/');
	});

	it('本机 http 地址被视为合法', () => {
		localStorage.setItem('apiUrl', 'http://127.0.0.1:3000');
		expect(runRequest().baseURL).toBe('http://127.0.0.1:3000');
	});

	it('不合法的 apiUrl 不会写入 baseURL', () => {
		localStorage.setItem('apiUrl', 'http://evil.com');
		const config = runRequest({ baseURL: '/fallback' });
		expect(config.baseURL).toBe('/fallback');
	});

	it('不合法的 apiUrl 会被从 localStorage 中清除', () => {
		localStorage.setItem('apiUrl', 'http://evil.com');
		runRequest();
		expect(localStorage.getItem('apiUrl')).toBeNull();
	});

	it('不合法的 apiUrl 会打印告警', () => {
		localStorage.setItem('apiUrl', 'javascript:alert(1)');
		runRequest();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(String(warnSpy.mock.calls[0][0])).toContain('unsafe apiUrl');
	});

	it('合法 apiUrl 不会触发告警', () => {
		localStorage.setItem('apiUrl', 'https://api.example.com');
		runRequest();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe('请求拦截器 - token 注入', () => {
	it('存在 token 时附加 Bearer 头', () => {
		localStorage.setItem('token', 'abc123');
		expect(runRequest().headers.Authorization).toBe('Bearer abc123');
	});

	it('不存在 token 时不附加 Authorization 头', () => {
		expect(runRequest().headers.Authorization).toBeUndefined();
	});

	it('token 与 apiUrl 同时生效', () => {
		localStorage.setItem('apiUrl', 'https://api.example.com');
		localStorage.setItem('token', 'tk');
		const config = runRequest();
		expect(config.baseURL).toBe('https://api.example.com');
		expect(config.headers.Authorization).toBe('Bearer tk');
	});

	it('apiUrl 非法被丢弃时仍会附加 token', () => {
		localStorage.setItem('apiUrl', 'http://evil.com');
		localStorage.setItem('token', 'tk');
		const config = runRequest();
		expect(config.headers.Authorization).toBe('Bearer tk');
	});

	it('不修改传入的其他配置项', () => {
		localStorage.setItem('token', 'tk');
		const config = runRequest({ url: '/admin/login', method: 'post' });
		expect(config.url).toBe('/admin/login');
		expect(config.method).toBe('post');
	});

	it('请求拦截器的错误分支原样拒绝', async () => {
		const boom = new Error('request setup failed');
		await expect(axiosMock.requestHandlers[0].rejected(boom)).rejects.toBe(boom);
	});
});

describe('响应拦截器 - 业务成功分支', () => {
	it('code=200 时返回整个响应体', () => {
		const body = { code: 200, message: 'ok', data: [1, 2] };
		expect(runResponse(body)).toBe(body);
	});

	it('没有 code 字段时直接返回响应体', () => {
		const body = [1, 2, 3];
		expect(runResponse(body)).toBe(body);
	});

	it('code=0 属于假值，仍按成功返回', () => {
		const body = { code: 0, data: 'x' };
		expect(runResponse(body)).toBe(body);
	});

	it('code 为字符串 "200" 时会被当成错误拒绝（已记录的边界：使用严格不等于比较）', async () => {
		await expect(runResponse({ code: '200', message: 'ok' })).rejects.toThrow('ok');
		expect(toastMock.error).toHaveBeenCalledWith('ok');
	});

	it('成功分支不会弹 toast', () => {
		runResponse({ code: 200, data: null });
		expect(toastMock.error).not.toHaveBeenCalled();
	});
});

describe('响应拦截器 - 业务错误码', () => {
	it('code=400 拒绝但不弹提示（由页面自行处理）', async () => {
		await expect(runResponse({ code: 400, message: '参数错误' })).rejects.toThrow('参数错误');
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	it('code=500 弹出服务端消息并拒绝', async () => {
		await expect(runResponse({ code: 500, message: '服务器炸了' })).rejects.toThrow('服务器炸了');
		expect(toastMock.error).toHaveBeenCalledWith('服务器炸了');
	});

	it('code=500 且无消息时回落为 Error', async () => {
		await expect(runResponse({ code: 500 })).rejects.toThrow('Error');
	});

	it('code=401 清除 token', async () => {
		localStorage.setItem('token', 'expired');
		await runResponse({ code: 401, message: '未授权' }).catch(() => {});
		expect(localStorage.getItem('token')).toBeNull();
	});

	it('code=401 跳转登录页', async () => {
		await runResponse({ code: 401, message: '未授权' }).catch(() => {});
		expect(pushSpy).toHaveBeenCalledWith('/login');
	});

	it('code=401 提示登录过期', async () => {
		await runResponse({ code: 401, message: '未授权' }).catch(() => {});
		expect(toastMock.error).toHaveBeenCalledWith('登录已过期或凭证无效，请重新登录');
	});

	it('code=401 以服务端消息拒绝', async () => {
		await expect(runResponse({ code: 401, message: '未授权' })).rejects.toThrow('未授权');
	});

	it('code=401 且无消息时回落为 Unauthorized', async () => {
		await expect(runResponse({ code: 401 })).rejects.toThrow('Unauthorized');
	});

	it('code=401 不会清除 admin_name', async () => {
		localStorage.setItem('admin_name', 'admin');
		localStorage.setItem('token', 'expired');
		await runResponse({ code: 401 }).catch(() => {});
		expect(localStorage.getItem('admin_name')).toBe('admin');
	});

	it('非 401 错误不会清除 token', async () => {
		localStorage.setItem('token', 'valid');
		await runResponse({ code: 500, message: 'x' }).catch(() => {});
		expect(localStorage.getItem('token')).toBe('valid');
		expect(pushSpy).not.toHaveBeenCalled();
	});
});

describe('响应拦截器 - HTTP 错误分支', () => {
	it('响应体 code=401 时清 token、跳登录并以原错误拒绝', async () => {
		localStorage.setItem('token', 'expired');
		const error = { response: { status: 401, data: { code: 401, message: 'token 失效' } } };
		await expect(runResponseError(error)).rejects.toBe(error);
		expect(localStorage.getItem('token')).toBeNull();
		expect(pushSpy).toHaveBeenCalledWith('/login');
		expect(toastMock.error).toHaveBeenCalledWith('登录已过期或凭证无效，请重新登录');
	});

	it('响应体 code=400 时以服务端消息构造新错误', async () => {
		const error = { response: { status: 400, data: { code: 400, message: 'IP 格式非法' } } };
		await expect(runResponseError(error)).rejects.toThrow('IP 格式非法');
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	it('HTTP 401 但响应体没有 code 时拒绝且不清 token', async () => {
		localStorage.setItem('token', 'valid');
		const error = { response: { status: 401, data: { message: '登录失效' } } };
		await expect(runResponseError(error)).rejects.toThrow('登录失效');
		// 已记录：该分支只依赖响应体 code，不会清理本地 token
		expect(localStorage.getItem('token')).toBe('valid');
		expect(pushSpy).not.toHaveBeenCalled();
	});

	it('HTTP 400 但响应体没有 code 时走通用错误提示', async () => {
		const error = { response: { status: 400, data: {} }, message: 'Request failed' };
		await expect(runResponseError(error)).rejects.toBe(error);
		expect(toastMock.error).toHaveBeenCalledWith('Request failed');
	});

	it('无响应体的 HTTP 500 走通用错误提示', async () => {
		const error = { response: { status: 500, data: undefined }, message: 'Internal Error' };
		await expect(runResponseError(error)).rejects.toBe(error);
		expect(toastMock.error).toHaveBeenCalledWith('Internal Error');
	});

	it('纯网络错误（无 response）提示错误信息并原样拒绝', async () => {
		const error = new Error('Network Error');
		await expect(runResponseError(error)).rejects.toBe(error);
		expect(toastMock.error).toHaveBeenCalledWith('Network Error');
	});

	it('错误对象没有 message 时回落为默认文案', async () => {
		const error = { response: undefined };
		await expect(runResponseError(error)).rejects.toBe(error);
		expect(toastMock.error).toHaveBeenCalledWith('网络或接口错误，请检查 API 地址是否正确');
	});

	it('网络错误不会触发登录跳转', async () => {
		await runResponseError(new Error('timeout')).catch(() => {});
		expect(pushSpy).not.toHaveBeenCalled();
	});

	it('toast 模块被 request.js 复用（同一 mock 实例）', () => {
		expect(toast).toBe(toastMock);
	});
});
