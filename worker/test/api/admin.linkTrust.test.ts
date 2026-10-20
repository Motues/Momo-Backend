/**
 * /admin/links/trust —— 休眠链接的人工确认（TrustedLink）。
 *
 * 覆盖（见 spec §3 / §4 / §5 与 doc/link_security.md）：
 *  - POST 写入 / 参数校验 / 幂等 upsert / 天数归一化；
 *  - DELETE 撤销 / 本来就没有；
 *  - 用户列表 `urlTrustedUntil` 与「人工确认豁免休眠」，含过期、恰好到期、换链接不继承。
 *
 * 鉴权口径的说明：这两条路由注册在 `app.use('/admin/*', adminAuth)` 之后，与其它
 * /admin 路由共用同一套中间件，因此「缺 token」的 401 文案是 Worker 既有的
 * `Unauthorized` / `Token expired or invalid`（Node/Go 那边是 `Invalid token`，
 * 属于跨端既有差异，本改动不顺手改鉴权中间件）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import {
	allTrustedLinks,
	createSchema,
	seedComment,
	seedSettings,
	seedTrustedLink,
} from '../helpers/db';
import { DAY_MS } from '../../src/utils/linkSecurity';

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const authed = () => bearer(token);

function trust(body: unknown, headers: Record<string, string> = authed()) {
	return api('/admin/links/trust', { method: 'POST', headers, body });
}

function untrust(query: string, headers: Record<string, string> = authed()) {
	return api(`/admin/links/trust${query}`, { method: 'DELETE', headers });
}

/** 固定「现在」以断言到期时间与边界（刚好等于 now vs now + 1 毫秒） */
async function withFrozenNow<T>(now: number, run: () => Promise<T>): Promise<T> {
	const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
	try {
		return await run();
	} finally {
		spy.mockRestore();
	}
}

const userOf = (body: any, email: string) =>
	body.data.users.find((u: any) => u.email.trim().toLowerCase() === email);

describe('POST /admin/links/trust', () => {
	it('缺少 token 返回 401', async () => {
		const res = await trust({ email: 'a@x.com', url: 'https://a.example.com' }, {});
		expect(res.status).toBe(401);
		expect(res.body.code).toBe(401);
		expect(await allTrustedLinks()).toHaveLength(0);
	});

	it('缺少 / 空白 email 或 url 返回 400 与固定文案', async () => {
		for (const body of [
			{ url: 'https://a.example.com' },
			{ email: 'a@x.com' },
			{ email: '   ', url: 'https://a.example.com' },
			{ email: 'a@x.com', url: '   ' },
			{ email: null, url: null },
		]) {
			const res = await trust(body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.body).toEqual({ code: 400, message: 'email and url are required' });
		}
	});

	it('url 为 javascript: 时 sanitizeUrl 归空 → 400，且不落库', async () => {
		const res = await trust({ email: 'a@x.com', url: 'javascript:alert(1)' });
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('email and url are required');
		expect(await allTrustedLinks()).toHaveLength(0);
	});

	it('非法 JSON 请求体按缺参处理 → 400', async () => {
		const res = await api('/admin/links/trust', {
			method: 'POST',
			headers: { ...authed(), 'content-type': 'application/json' },
			body: '{oops',
		});
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('email and url are required');
	});

	it('正常写入：link_dormant_days=10，expiresAt = now + 10 天，email/url 归一化', async () => {
		await seedSettings({ link_dormant_days: '10' });
		const now = Date.now();
		const res = await withFrozenNow(now, () =>
			trust({ email: '  Alice@Example.COM  ', url: '  https://alice.example.com  ' })
		);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'Link trusted successfully',
			data: {
				email: 'alice@example.com',
				url: 'https://alice.example.com',
				expiresAt: new Date(now + 10 * DAY_MS).toISOString(),
				days: 10,
			},
		});

		const rows = await allTrustedLinks();
		expect(rows).toHaveLength(1);
		expect(rows[0].email).toBe('alice@example.com');
		expect(rows[0].url).toBe('https://alice.example.com');
		expect(rows[0].expires_at).toBe(new Date(now + 10 * DAY_MS).toISOString());
		expect(rows[0].created_at).toBe(new Date(now).toISOString());
		// 写入格式必须与 new Date(ms).toISOString() 逐字一致
		expect(rows[0].expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it('未配置 / 脏值天数时回退 30 天，超上限夹取 3650', async () => {
		const before = Date.now();
		const res = await trust({ email: 'a@x.com', url: 'https://a.example.com' });
		const after = Date.now();
		expect(res.body.data.days).toBe(30);
		const ts = Date.parse(res.body.data.expiresAt);
		expect(ts).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
		expect(ts).toBeLessThanOrEqual(after + 30 * DAY_MS);

		await seedSettings({ link_dormant_days: 'abc' });
		expect((await trust({ email: 'b@x.com', url: 'https://b.example.com' })).body.data.days).toBe(30);

		await seedSettings({ link_dormant_days: '99999' });
		expect((await trust({ email: 'c@x.com', url: 'https://c.example.com' })).body.data.days).toBe(3650);
	});

	it('幂等 upsert：同一 (email, url) 连续两次只留一行，第二次刷新 expires_at / created_at', async () => {
		await seedSettings({ link_dormant_days: '10' });
		const first = 1_800_000_000_000;
		const firstRes = await withFrozenNow(first, () =>
			trust({ email: 'a@x.com', url: 'https://a.example.com' })
		);
		expect(firstRes.body.data.expiresAt).toBe(new Date(first + 10 * DAY_MS).toISOString());

		const second = first + 5 * DAY_MS;
		const secondRes = await withFrozenNow(second, () =>
			trust({ email: 'A@X.com', url: 'https://a.example.com' })
		);
		expect(secondRes.status).toBe(200);

		const rows = await allTrustedLinks();
		expect(rows).toHaveLength(1);
		expect(rows[0].expires_at).toBe(new Date(second + 10 * DAY_MS).toISOString());
		expect(rows[0].created_at).toBe(new Date(second).toISOString());
	});

	it('不同 url 各自一行（确认不覆盖另一条链接）', async () => {
		await trust({ email: 'a@x.com', url: 'https://old.example.com' });
		await trust({ email: 'a@x.com', url: 'https://new.example.com' });
		const rows = await allTrustedLinks();
		expect(rows.map((row) => row.url).sort()).toEqual([
			'https://new.example.com',
			'https://old.example.com',
		]);
	});

	it('相对路径等合法 url 也被接受', async () => {
		expect((await trust({ email: 'a@x.com', url: '/about' })).status).toBe(200);
		expect((await trust({ email: 'a@x.com', url: 'mailto:a@x.com' })).status).toBe(200);
	});

	it('功能关闭（默认）时也照常写入：开启后按 expires_at 生效', async () => {
		const res = await trust({ email: 'a@x.com', url: 'https://a.example.com' });
		expect(res.status).toBe(200);
		expect(await allTrustedLinks()).toHaveLength(1);
	});
});

describe('DELETE /admin/links/trust', () => {
	const email = 'a@x.com';
	const url = 'https://a.example.com';

	it('缺少 token 返回 401', async () => {
		const res = await untrust('', {});
		expect(res.status).toBe(401);
		expect(res.body.code).toBe(401);
	});

	it('缺少 / 空白 email 或 url 返回 400 与固定文案', async () => {
		for (const query of [
			'',
			`?email=${encodeURIComponent(email)}`,
			`?url=${encodeURIComponent(url)}`,
			`?email=${encodeURIComponent('   ')}&url=${encodeURIComponent(url)}`,
			`?email=${encodeURIComponent(email)}&url=${encodeURIComponent('javascript:alert(1)')}`,
		]) {
			const res = await untrust(query);
			expect(res.status, query).toBe(400);
			expect(res.body).toEqual({ code: 400, message: 'email and url are required' });
		}
	});

	it('删除已有记录 → revoked true；再删 → revoked false（都是 200）', async () => {
		await trust({ email, url });
		const res = await untrust(
			`?email=${encodeURIComponent(' A@X.com ')}&url=${encodeURIComponent(url)}`
		);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			code: 200,
			message: 'Link trust revoked',
			data: { email, url, revoked: true },
		});
		expect(await allTrustedLinks()).toHaveLength(0);

		const again = await untrust(
			`?email=${encodeURIComponent(email)}&url=${encodeURIComponent(url)}`
		);
		expect(again.status).toBe(200);
		expect(again.body).toEqual({
			code: 200,
			message: 'Link is not trusted',
			data: { email, url, revoked: false },
		});
	});

	it('url 不匹配时不删除（不会误伤同一邮箱的其它链接）', async () => {
		await trust({ email, url });
		const res = await untrust(
			`?email=${encodeURIComponent(email)}&url=${encodeURIComponent('https://other.example.com')}`
		);
		expect(res.body.message).toBe('Link is not trusted');
		expect(await allTrustedLinks()).toHaveLength(1);
	});
});

/**
 * 用户列表：`urlTrustedUntil`（原样下发 expires_at）与人工确认豁免休眠。
 * 与公开评论区同口径：身份是归一化邮箱、网址逐字相等、到期「严格大于」才算有效。
 */
describe('GET /admin/stats/users — 人工确认（TrustedLink）', () => {
	const DAY = DAY_MS;
	const dormanted = (extra: Record<string, string> = {}) =>
		seedSettings({ link_security_enabled: 'true', link_dormant_days: '30', ...extra });

	it('休眠链接 + 有效确认 → urlDormant false 且 urlTrustedUntil 等于写入的 expires_at', async () => {
		await dormanted();
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 31 * DAY,
		});
		const expiresAt = new Date(Date.now() + 10 * DAY).toISOString();
		await seedTrustedLink({ email: 'a@x.com', url: 'https://a.example.com', expires_at: expiresAt });

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.url).toBe('https://a.example.com');
		expect(user.urlDormant).toBe(false);
		expect(user.urlTrustedUntil).toBe(expiresAt);
	});

	it('已过期的人工确认 → urlDormant true 且 urlTrustedUntil 为空串', async () => {
		await dormanted();
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 31 * DAY,
		});
		await seedTrustedLink({
			email: 'a@x.com',
			url: 'https://a.example.com',
			expires_at: new Date(Date.now() - DAY).toISOString(),
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.urlDormant).toBe(true);
		expect(user.urlTrustedUntil).toBe('');
	});

	it('边界：expires_at 恰好等于 now → 视为过期（严格大于）', async () => {
		const now = Date.now();
		await dormanted();
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: now - 31 * DAY,
		});
		await seedTrustedLink({
			email: 'a@x.com',
			url: 'https://a.example.com',
			expires_at: new Date(now).toISOString(),
		});

		const res = await withFrozenNow(now, () => api('/admin/stats/users', { headers: authed() }));
		const user = userOf(res.body, 'a@x.com');
		expect(user.urlDormant).toBe(true);
		expect(user.urlTrustedUntil).toBe('');
	});

	it('换链接不继承：确认的是旧网址，用户改留新网址后恢复休眠', async () => {
		await dormanted();
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://new.example.com',
			pub_date: Date.now() - 31 * DAY,
		});
		// 只有「旧网址」被确认过
		await seedTrustedLink({
			email: 'a@x.com',
			url: 'https://old.example.com',
			expires_at: new Date(Date.now() + 10 * DAY).toISOString(),
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.url).toBe('https://new.example.com');
		expect(user.urlDormant).toBe(true);
		expect(user.urlTrustedUntil).toBe('');
	});

	it('从未确认过时字段存在且为空串；同一页其他用户不受影响', async () => {
		await dormanted();
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 31 * DAY,
		});
		await seedComment({
			author: '乙',
			email: 'b@x.com',
			url: 'https://b.example.com',
			pub_date: Date.now() - 31 * DAY,
		});
		await seedTrustedLink({
			email: 'a@x.com',
			url: 'https://a.example.com',
			expires_at: new Date(Date.now() + 10 * DAY).toISOString(),
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		const a = userOf(res.body, 'a@x.com');
		const b = userOf(res.body, 'b@x.com');
		expect(a.urlDormant).toBe(false);
		expect(b.urlDormant).toBe(true);
		expect(b.urlTrustedUntil).toBe('');
		expect('urlTrustedUntil' in b).toBe(true);
	});

	it('邮箱归一化后匹配：确认与评论的邮箱大小写 / 空白不同也算同一条', async () => {
		const expiresAt = new Date(Date.now() + 10 * DAY).toISOString();
		await dormanted();
		await seedComment({
			author: '甲',
			email: ' A@X.com ',
			url: 'https://a.example.com',
			pub_date: Date.now() - 31 * DAY,
		});
		await seedTrustedLink({ email: 'a@x.com', url: 'https://a.example.com', expires_at: expiresAt });

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.urlTrustedUntil).toBe(expiresAt);
		expect(user.urlDormant).toBe(false);
	});

	it('功能关闭时 urlTrustedUntil 照常下发，但 urlDormant 恒为 false', async () => {
		const expiresAt = new Date(Date.now() + 10 * DAY).toISOString();
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 90 * DAY,
		});
		await seedTrustedLink({ email: 'a@x.com', url: 'https://a.example.com', expires_at: expiresAt });

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.urlTrustedUntil).toBe(expiresAt);
		expect(user.urlDormant).toBe(false);
	});
});
