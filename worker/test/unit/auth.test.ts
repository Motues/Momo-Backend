/**
 * src/utils/auth.ts —— 管理端 Bearer 令牌中间件。
 *
 * 会话数据存放在 KV 的 `token:<uuid>` 键下（20 分钟 TTL，见 api/admin/login.ts）。
 * 中间件只校验「令牌存在」，不绑定登录 IP（S11 的设计决定）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSchema, kvKeys, testEnv } from '../helpers/db';
import { adminAuth } from '../../src/utils/auth';
import type { Bindings } from '../../src/bindings';
import { bearer } from '../helpers/http';

function buildApp() {
	const app = new Hono<{ Bindings: Bindings }>();
	app.use('/admin/*', adminAuth);
	app.get('/admin/ping', (c) => c.json({ code: 200, message: 'pong' }));
	return app;
}

const env = testEnv as unknown as Bindings;

/** 直接往 KV 里塞一个合法会话，返回 token */
async function seedSession(user = 'momo', expiresIn = 1200): Promise<string> {
	const token = crypto.randomUUID();
	await testEnv.MOMO_AUTH_KV.put(`token:${token}`, JSON.stringify({ user, ip: '127.0.0.1' }), {
		expirationTtl: expiresIn,
	});
	return token;
}

describe('adminAuth', () => {
	beforeEach(createSchema);

	it('缺少 Authorization 头返回 401', async () => {
		const res = await buildApp().request('/admin/ping', {}, env);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ code: 401, message: 'Unauthorized' });
	});

	it('空字符串 Authorization 头同样返回 401', async () => {
		const res = await buildApp().request('/admin/ping', { headers: { authorization: '' } }, env);
		expect(res.status).toBe(401);
		expect((await res.json()).code).toBe(401);
	});

	it('KV 中不存在的令牌返回 401「Token expired or invalid」', async () => {
		const res = await buildApp().request(
			'/admin/ping',
			{ headers: bearer('not-a-real-token') },
			env
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ code: 401, message: 'Token expired or invalid' });
	});

	it('KV 中存在令牌时放行', async () => {
		const token = await seedSession();
		const res = await buildApp().request('/admin/ping', { headers: bearer(token) }, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ code: 200, message: 'pong' });
	});

	it('被吊销（删除）的令牌立即失效，等价于过期', async () => {
		const token = await seedSession();
		expect((await buildApp().request('/admin/ping', { headers: bearer(token) }, env)).status).toBe(200);
		await testEnv.MOMO_AUTH_KV.delete(`token:${token}`);
		expect((await buildApp().request('/admin/ping', { headers: bearer(token) }, env)).status).toBe(401);
	});

	it('不绑定登录 IP：会话中的 ip 与会话期间的请求 IP 不一致也放行', async () => {
		const token = await seedSession();
		const res = await buildApp().request(
			'/admin/ping',
			{ headers: { ...bearer(token), 'cf-connecting-ip': '198.51.100.9' } },
			env
		);
		expect(res.status).toBe(200);
	});

	it('Authorization 头里裸令牌（无 Bearer 前缀）也能通过 replace 语义被接受', async () => {
		// 实现是 authorization?.replace('Bearer ', '')，未命中时原样保留
		const token = await seedSession();
		const res = await buildApp().request('/admin/ping', { headers: { authorization: token } }, env);
		expect(res.status).toBe(200);
	});

	it('只替换第一处 "Bearer "：重复前缀会留下残留导致 401', async () => {
		const token = await seedSession();
		const res = await buildApp().request(
			'/admin/ping',
			{ headers: { authorization: `Bearer Bearer ${token}` } },
			env
		);
		expect(res.status).toBe(401);
	});

	it('KV 中的键必须以 token: 为前缀（其它前缀不算会话）', async () => {
		const token = crypto.randomUUID();
		await testEnv.MOMO_AUTH_KV.put(token, JSON.stringify({ user: 'momo' }), { expirationTtl: 1200 });
		const res = await buildApp().request('/admin/ping', { headers: bearer(token) }, env);
		expect(res.status).toBe(401);
		expect(await kvKeys()).toEqual([token]);
	});

	it('非 /admin/* 路径不受该中间件影响', async () => {
		const app = new Hono<{ Bindings: Bindings }>();
		app.use('/admin/*', adminAuth);
		app.get('/api/comments', (c) => c.json({ code: 200 }));
		const res = await app.request('/api/comments', {}, env);
		expect(res.status).toBe(200);
	});
});
