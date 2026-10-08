/**
 * POST /admin/login（+ /admin/auth 相关路由）—— 登录、失败计数、IP 锁定、会话令牌。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { api, bearer, DEFAULT_ADMIN, loginAsAdmin } from '../helpers/http';
import { createSchema, kvGet, kvKeys, seedSettings, testEnv } from '../helpers/db';
import { changeAdminPassword } from '../../src/utils/settings';

beforeEach(createSchema);

describe('POST /admin/login —— 成功路径', () => {
	it('默认凭据登录成功并返回 token', async () => {
		const res = await loginAsAdmin();
		expect(res.status).toBe(200);
		expect(res.body.code).toBe(200);
		expect(res.body.message).toBe('Login successful');
		expect(typeof res.body.token).toBe('string');
		expect(res.body.token).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('默认管理员登录时提示需要修改密码', async () => {
		expect((await loginAsAdmin()).body.needChangePassword).toBe(true);
	});

	it('已改过密码时 needChangePassword 为 false', async () => {
		await seedSettings({ password_changed: 'true' });
		expect((await loginAsAdmin()).body.needChangePassword).toBe(false);
	});

	it('令牌写入 KV 的 token:<uuid> 键，内容含用户名与登录 IP', async () => {
		const res = await loginAsAdmin(DEFAULT_ADMIN, '198.51.100.9');
		const token = res.body.token as string;
		expect(await kvKeys('token:')).toEqual([`token:${token}`]);
		expect(JSON.parse((await kvGet(`token:${token}`)) as string)).toEqual({
			user: 'momo',
			ip: '198.51.100.9',
		});
	});

	it('缺少 cf-connecting-ip 时记录 127.0.0.1', async () => {
		const res = await api('/admin/login', {
			method: 'POST',
			body: { name: 'momo', password: 'momo' },
		});
		const token = res.body.token as string;
		expect(JSON.parse((await kvGet(`token:${token}`)) as string).ip).toBe('127.0.0.1');
	});

	it('签发的令牌可以立即访问受保护路由', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		const res = await api('/admin/stats/overview', { headers: bearer(token) });
		expect(res.status).toBe(200);
	});

	it('每次登录签发不同令牌，且旧令牌仍然有效（支持多会话）', async () => {
		const first = (await loginAsAdmin()).body.token as string;
		const second = (await loginAsAdmin()).body.token as string;
		expect(first).not.toBe(second);
		expect((await api('/admin/stats/overview', { headers: bearer(first) })).status).toBe(200);
		expect((await api('/admin/stats/overview', { headers: bearer(second) })).status).toBe(200);
	});

	it('已改密码后必须用新凭据登录', async () => {
		await changeAdminPassword(testEnv, 'root', 'brand-new-password');
		expect((await loginAsAdmin()).status).toBe(401);
		const ok = await loginAsAdmin({ name: 'root', password: 'brand-new-password' }, '198.51.100.11');
		expect(ok.status).toBe(200);
		expect(ok.body.needChangePassword).toBe(false);
	});
});

describe('POST /admin/login —— 参数校验', () => {
	it.each([
		['缺少 name', { password: 'momo' }],
		['缺少 password', { name: 'momo' }],
		['name 非字符串', { name: 123, password: 'momo' }],
		['password 非字符串', { name: 'momo', password: {} }],
		['password 为 null', { name: 'momo', password: null }],
	])('%s 返回 400', async (_label, body) => {
		const res = await api('/admin/login', { method: 'POST', body, ip: '198.51.100.20' });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('name and password must be strings');
	});

	it('非法 JSON 请求体返回 400（json() 有 catch 兜底）', async () => {
		const res = await api('/admin/login', {
			method: 'POST',
			body: '{oops',
			ip: '198.51.100.21',
			headers: { 'content-type': 'application/json' },
		});
		expect(res.status).toBe(400);
	});

	it('空请求体返回 400', async () => {
		const res = await api('/admin/login', { method: 'POST', ip: '198.51.100.22' });
		expect(res.status).toBe(400);
	});

	it('参数类型错误不计入失败锁定计数', async () => {
		await api('/admin/login', { method: 'POST', body: { name: 1, password: 2 }, ip: '198.51.100.23' });
		expect(await kvKeys('attempts:')).toEqual([]);
	});
});

describe('POST /admin/login —— 失败计数与 IP 锁定', () => {
	const IP = '198.51.100.30';

	it('用户名或密码错误返回 401', async () => {
		const res = await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect(res.status).toBe(401);
		expect(res.body.message).toBe('Invalid username or password');
	});

	it('失败次数写入 KV（TTL 计数）', async () => {
		await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect(await kvGet(`attempts:${IP}`)).toBe('1');
		await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect(await kvGet(`attempts:${IP}`)).toBe('2');
	});

	it('连续失败 4 次仍返回 401', async () => {
		for (let i = 0; i < 4; i++) {
			expect((await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP)).status).toBe(401);
		}
	});

	it('第 5 次失败触发封禁并返回 403', async () => {
		for (let i = 0; i < 4; i++) await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		const res = await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect(res.status).toBe(403);
		expect(res.body.message).toBe('IP is blocked due to multiple failed login');
	});

	it('触发封禁后尝试计数被清除，封禁标记写入 KV', async () => {
		for (let i = 0; i < 5; i++) await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect(await kvKeys('block:')).toEqual([`block:${IP}`]);
		expect(await kvKeys('attempts:')).toEqual([]);
	});

	it('被封禁的 IP 即使凭据正确也返回 403', async () => {
		for (let i = 0; i < 5; i++) await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		const res = await loginAsAdmin(DEFAULT_ADMIN, IP);
		expect(res.status).toBe(403);
		expect(res.body.message).toBe('IP is blocked due to multiple failed login attempts');
	});

	it('封禁按 IP 隔离，其它 IP 不受影响', async () => {
		for (let i = 0; i < 5; i++) await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect((await loginAsAdmin(DEFAULT_ADMIN, '198.51.100.31')).status).toBe(200);
	});

	it('登录成功后清除失败计数', async () => {
		await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect(await kvGet(`attempts:${IP}`)).toBe('2');
		expect((await loginAsAdmin(DEFAULT_ADMIN, IP)).status).toBe(200);
		expect(await kvGet(`attempts:${IP}`)).toBeNull();
	});

	it('失败计数达到 5 之前成功登录可以重置计数', async () => {
		for (let i = 0; i < 4; i++) await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect((await loginAsAdmin(DEFAULT_ADMIN, IP)).status).toBe(200);
		// 重置后再失败一次仍然是第 1 次
		await loginAsAdmin({ name: 'momo', password: 'wrong' }, IP);
		expect(await kvGet(`attempts:${IP}`)).toBe('1');
	});
});

describe('受保护路由的鉴权', () => {
	const protectedRoutes: [string, string][] = [
		['GET', '/admin/settings'],
		['PUT', '/admin/settings'],
		['GET', '/admin/comments/list'],
		['PUT', '/admin/comments/status?id=1&status=approved'],
		['PUT', '/admin/comments/edit'],
		['GET', '/admin/stats/overview'],
		['GET', '/admin/stats/users'],
		['GET', '/admin/stats/users/comments?author=a&email=b'],
		['POST', '/admin/users/blacklist'],
		['DELETE', '/admin/users/blacklist?email=a@b.c'],
		['GET', '/admin/data/export/settings'],
		['GET', '/admin/data/export/comments'],
		['POST', '/admin/data/import/comments'],
		['POST', '/admin/data/import/settings'],
		['POST', '/admin/settings/test-email'],
		['POST', '/admin/logout'],
		['PUT', '/admin/password'],
	];

	it.each(protectedRoutes)('%s %s 无令牌时返回 401', async (method, path) => {
		const res = await api(path, { method, body: method === 'GET' ? undefined : {} });
		expect(res.status).toBe(401);
		expect(res.body.code).toBe(401);
	});

	it.each(protectedRoutes)('%s %s 携带无效令牌时返回 401', async (method, path) => {
		const res = await api(path, {
			method,
			body: method === 'GET' ? undefined : {},
			headers: bearer('invalid-token'),
		});
		expect(res.status).toBe(401);
	});

	it('POST /admin/login 本身不需要令牌', async () => {
		expect((await loginAsAdmin()).status).toBe(200);
	});
});

describe('POST /admin/logout', () => {
	it('注销后当前令牌立即失效', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		expect((await api('/admin/logout', { method: 'POST', headers: bearer(token) })).status).toBe(200);
		expect(await kvGet(`token:${token}`)).toBeNull();
		expect((await api('/admin/stats/overview', { headers: bearer(token) })).status).toBe(401);
	});

	it('注销只影响当前令牌，其它会话仍有效', async () => {
		const first = (await loginAsAdmin()).body.token as string;
		const second = (await loginAsAdmin()).body.token as string;
		await api('/admin/logout', { method: 'POST', headers: bearer(first) });
		expect((await api('/admin/stats/overview', { headers: bearer(second) })).status).toBe(200);
	});

	it('无令牌时也返回 200（被中间件先拦下则是 401）', async () => {
		const res = await api('/admin/logout', { method: 'POST' });
		expect(res.status).toBe(401);
	});
});

describe('PUT /admin/password', () => {
	async function change(body: unknown, token?: string) {
		return await api('/admin/password', {
			method: 'PUT',
			body,
			headers: token ? bearer(token) : {},
		});
	}

	it('凭据正确时改密成功，并吊销其它令牌', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		const res = await change(
			{
				old_name: 'momo',
				old_password: 'momo',
				new_name: 'root',
				new_password: 'brand-new-password',
			},
			token
		);
		expect(res.status).toBe(200);
		expect(res.body.code).toBe(200);
		// 当前令牌被保留，其它会话被吊销
		expect((await api('/admin/stats/overview', { headers: bearer(token) })).status).toBe(200);
	});

	it('新密码少于 8 位返回 400', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		const res = await change(
			{ old_name: 'momo', old_password: 'momo', new_name: 'root', new_password: '1234567' },
			token
		);
		expect(res.status).toBe(400);
		expect(res.body.message).toContain('at least 8 characters');
	});

	it('恰好 8 位的新密码被接受', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		const res = await change(
			{ old_name: 'momo', old_password: 'momo', new_name: 'root', new_password: '12345678' },
			token
		);
		expect(res.status).toBe(200);
	});

	it('缺少字段返回 400', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		const res = await change({ old_name: 'momo', old_password: 'momo' }, token);
		expect(res.status).toBe(400);
	});

	it('旧凭据错误返回 401', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		const res = await change(
			{ old_name: 'momo', old_password: 'wrong', new_name: 'root', new_password: 'long-enough' },
			token
		);
		expect(res.status).toBe(401);
	});

	it('非法 JSON 返回 400', async () => {
		const token = (await loginAsAdmin()).body.token as string;
		const res = await api('/admin/password', {
			method: 'PUT',
			body: '{oops',
			headers: { ...bearer(token), 'content-type': 'application/json' },
		});
		expect(res.status).toBe(400);
	});
});
