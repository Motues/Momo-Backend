/**
 * HTTP 集成测试辅助：直接调用 Hono app（不使用 SELF.fetch），
 * 显式传入 miniflare 注入的 env 与一个真实的 ExecutionContext。
 *
 * 为什么必须传 ExecutionContext：
 * postComment / admin settings 等 handler 会调用 `c.executionCtx.waitUntil(...)`，
 * Hono 在没有 ExecutionContext 时会抛 "This context has no ExecutionContext"，
 * 那会把一条本来成功的写入变成 500（纯测试环境差异，不是产品缺陷）。
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../../src/index';
import { testEnv } from './db';
import type { Bindings } from '../../src/bindings';

export interface ApiOptions {
	method?: string;
	headers?: Record<string, string>;
	/** 对象会被 JSON.stringify；字符串按原样发送 */
	body?: unknown;
	/** 写入 cf-connecting-ip 请求头（handler 侧的客户端 IP 来源） */
	ip?: string;
	/** 默认 true：等待 waitUntil 注册的后台任务（邮件通知等）执行完毕 */
	waitUntil?: boolean;
}

export interface ApiResult<T = any> {
	status: number;
	body: T;
	/** 原始 Response，用于断言响应头 / 非 JSON 响应体 */
	response: Response;
}

/** 发送一次请求并解析 JSON 响应体 */
export async function api<T = any>(path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (options.ip) headers['cf-connecting-ip'] = options.ip;

	let body: string | undefined;
	if (options.body !== undefined && options.body !== null) {
		body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
		if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
			headers['content-type'] = 'application/json';
		}
	}

	const ctx = createExecutionContext();
	const response = await app.request(
		path,
		{ method: options.method ?? 'GET', headers, body },
		testEnv as unknown as Bindings,
		ctx
	);
	if (options.waitUntil !== false) await waitOnExecutionContext(ctx);

	const text = await response.text();
	let parsed: any = text;
	try {
		parsed = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { status: response.status, body: parsed as T, response };
}

/** 发送一次请求，返回原始 Response（用于 verify-email 这类 HTML 端点） */
export async function rawRequest(path: string, options: ApiOptions = {}): Promise<Response> {
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (options.ip) headers['cf-connecting-ip'] = options.ip;
	const ctx = createExecutionContext();
	const response = await app.request(
		path,
		{ method: options.method ?? 'GET', headers },
		testEnv as unknown as Bindings,
		ctx
	);
	if (options.waitUntil !== false) await waitOnExecutionContext(ctx);
	return response;
}

/** 管理员默认凭据（settings.ts 中的 DEFAULT_ADMIN_*） */
export const DEFAULT_ADMIN = { name: 'momo', password: 'momo' } as const;

/** 构造 Authorization: Bearer <token> 请求头 */
export function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

/** 登录并返回 token（默认使用默认管理员凭据） */
export async function loginAsAdmin(
	credentials: { name: string; password: string } = DEFAULT_ADMIN,
	ip = '203.0.113.10'
): Promise<ApiResult<{ code: number; token?: string; needChangePassword?: boolean }>> {
	return await api('/admin/login', {
		method: 'POST',
		ip,
		body: { name: credentials.name, password: credentials.password },
	});
}

/** 登录并断言成功，返回 token */
export async function adminToken(
	credentials: { name: string; password: string } = DEFAULT_ADMIN,
	ip = '203.0.113.10'
): Promise<string> {
	const res = await loginAsAdmin(credentials, ip);
	if (res.status !== 200 || !res.body?.token) {
		throw new Error(`管理员登录失败：status=${res.status} body=${JSON.stringify(res.body)}`);
	}
	return res.body.token;
}
