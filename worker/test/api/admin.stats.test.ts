/**
 * /admin/stats/overview、/admin/stats/users、/admin/stats/users/comments —— 后台统计。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, seedComment, seedDormantNotice, seedSettings, seedTrustedLink, seedVerification, testEnv } from '../helpers/db';

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

const authed = () => bearer(token);

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

function currentMonthUtc(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('GET /admin/stats/overview —— 总量与分布', () => {
	it('空库时全部为 0，趋势为 7 个零值', async () => {
		const res = await api('/admin/stats/overview', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.data.totalComments).toBe(0);
		expect(res.body.data.totalUsers).toBe(0);
		expect(res.body.data.totalPosts).toBe(0);
		expect(res.body.data.statusDistribution).toEqual({ approved: 0, pending: 0, deleted: 0 });
		expect(res.body.data.recentComments).toHaveLength(7);
		expect(res.body.data.recentComments.every((r: any) => r.count === 0)).toBe(true);
		expect(res.body.data.topCommenters).toEqual([]);
	});

	it('统计总数、去重用户数与文章数', async () => {
		await seedComment({ author: 'A', email: 'a@example.com', post_slug: '/p/1' });
		await seedComment({ author: 'A', email: 'a@example.com', post_slug: '/p/2' });
		await seedComment({ author: 'B', email: 'b@example.com', post_slug: '/p/1' });
		const res = await api('/admin/stats/overview', { headers: authed() });
		expect(res.body.data.totalComments).toBe(3);
		// DISTINCT(author, email)：同名不同邮箱算两个人
		expect(res.body.data.totalUsers).toBe(2);
		expect(res.body.data.totalPosts).toBe(2);
	});

	it('同名不同邮箱计为两个用户', async () => {
		await seedComment({ author: 'Same', email: 'a@example.com' });
		await seedComment({ author: 'Same', email: 'b@example.com' });
		expect((await api('/admin/stats/overview', { headers: authed() })).body.data.totalUsers).toBe(2);
	});

	it('statusDistribution 按状态分组', async () => {
		await seedComment({ status: 'approved' });
		await seedComment({ status: 'approved' });
		await seedComment({ status: 'pending' });
		await seedComment({ status: 'deleted' });
		const res = await api('/admin/stats/overview', { headers: authed() });
		expect(res.body.data.statusDistribution).toEqual({ approved: 2, pending: 1, deleted: 0 + 1 });
	});

	it('已知边界：rejected 计入总数但不出现在 statusDistribution 中', async () => {
		await seedComment({ status: 'rejected' });
		const res = await api('/admin/stats/overview', { headers: authed() });
		expect(res.body.data.totalComments).toBe(1);
		expect(res.body.data.statusDistribution).toEqual({ approved: 0, pending: 0, deleted: 0 });
	});

	it('最新一条评论计入今天的桶', async () => {
		await seedComment({ pub_date: Date.now() });
		const res = await api('/admin/stats/overview', { headers: authed() });
		const today = res.body.data.recentComments.find((r: any) => r.date === todayUtc());
		expect(today.count).toBe(1);
	});

	it('窗口之外的评论不计入趋势', async () => {
		await seedComment({ pub_date: Date.now() - 40 * 24 * 3600 * 1000 });
		const res = await api('/admin/stats/overview?range=7', { headers: authed() });
		expect(res.body.data.recentComments.every((r: any) => r.count === 0)).toBe(true);
		expect(res.body.data.totalComments).toBe(1);
	});
});

describe('GET /admin/stats/overview —— range 参数', () => {
	it('默认 7 天', async () => {
		expect((await api('/admin/stats/overview', { headers: authed() })).body.data.recentComments).toHaveLength(7);
	});

	it('range=30 返回 30 个桶', async () => {
		expect((await api('/admin/stats/overview?range=30', { headers: authed() })).body.data.recentComments).toHaveLength(30);
	});

	it('range=1 只返回今天的桶', async () => {
		const res = await api('/admin/stats/overview?range=1', { headers: authed() });
		expect(res.body.data.recentComments).toHaveLength(1);
		expect(res.body.data.recentComments[0].date).toBe(todayUtc());
	});

	it('range=999 被钳制为 365', async () => {
		expect((await api('/admin/stats/overview?range=999', { headers: authed() })).body.data.recentComments).toHaveLength(365);
	});

	it('range=0 与 range=all 都按月聚合最近 12 个月', async () => {
		for (const range of ['all', '0', 'ALL']) {
			const res = await api(`/admin/stats/overview?range=${range}`, { headers: authed() });
			expect(res.body.data.recentComments).toHaveLength(12);
			expect(res.body.data.recentComments.at(-1).date).toBe(currentMonthUtc());
		}
	});

	it('非法 range 回落到 7 天', async () => {
		expect((await api('/admin/stats/overview?range=abc', { headers: authed() })).body.data.recentComments).toHaveLength(7);
		expect((await api('/admin/stats/overview?range=-5', { headers: authed() })).body.data.recentComments).toHaveLength(7);
	});

	it('按月聚合时当月评论被计入', async () => {
		await seedComment({ pub_date: Date.now() });
		const res = await api('/admin/stats/overview?range=all', { headers: authed() });
		const month = res.body.data.recentComments.find((r: any) => r.date === currentMonthUtc());
		expect(month.count).toBe(1);
	});
});

describe('GET /admin/stats/overview —— 热门评论者', () => {
	it('按评论数倒序取前 5，并输出 ISO 的最后评论时间', async () => {
		for (let i = 0; i < 6; i++) {
			await seedComment({ author: `U${i}`, email: `u${i}@example.com`, pub_date: 1730000000000 + i });
		}
		// U0 追加两条，成为第一名
		await seedComment({ author: 'U0', email: 'u0@example.com', pub_date: 1750000000000 });
		await seedComment({ author: 'U0', email: 'u0@example.com', pub_date: 1760000000000 });

		const res = await api('/admin/stats/overview', { headers: authed() });
		const top = res.body.data.topCommenters;
		expect(top).toHaveLength(5);
		expect(top[0]).toEqual({
			author: 'U0',
			email: 'u0@example.com',
			count: 3,
			lastCommentDate: new Date(1760000000000).toISOString(),
		});
	});

	it('汇总统计包含评论者的邮箱（管理端接口）', async () => {
		await seedComment({ author: 'A', email: 'a@example.com' });
		const res = await api('/admin/stats/overview', { headers: authed() });
		expect(res.body.data.topCommenters[0].email).toBe('a@example.com');
	});
});

describe('GET /admin/stats/users', () => {
	it('空库返回空列表', async () => {
		const res = await api('/admin/stats/users', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.data.users).toEqual([]);
		expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, totalPage: 0 });
	});

	it('按用户聚合评论数与各状态计数', async () => {
		await seedComment({ author: 'A', email: 'a@example.com', status: 'approved', pub_date: 1730000000000 });
		await seedComment({ author: 'A', email: 'a@example.com', status: 'pending', pub_date: 1740000000000 });
		await seedComment({ author: 'A', email: 'a@example.com', status: 'deleted', pub_date: 1750000000000 });
		await seedComment({ author: 'B', email: 'b@example.com', status: 'approved', pub_date: 1760000000000 });

		const res = await api('/admin/stats/users', { headers: authed() });
		const a = res.body.data.users.find((u: any) => u.author === 'A');
		expect(a).toMatchObject({
			email: 'a@example.com',
			commentCount: 3,
			approvedCount: 1,
			pendingCount: 1,
			deletedCount: 1,
			firstCommentDate: new Date(1730000000000).toISOString(),
			lastCommentDate: new Date(1750000000000).toISOString(),
			emailVerified: false,
			emailVerifiedAt: '',
			blacklisted: false,
		});
		// 按评论数倒序：A(3) 在 B(1) 之前
		expect(res.body.data.users[0].author).toBe('A');
	});

	it('已验证邮箱的用户标记 emailVerified 与验证时间', async () => {
		await seedComment({ author: 'A', email: 'a@example.com' });
		await seedVerification({ email: 'a@example.com', verified: 1, verified_at: '2024-01-01 00:00:00' });
		const res = await api('/admin/stats/users', { headers: authed() });
		expect(res.body.data.users[0].emailVerified).toBe(true);
		expect(res.body.data.users[0].emailVerifiedAt).toBe('2024-01-01 00:00:00');
	});

	it('verified=true 只返回已验证用户', async () => {
		await seedComment({ author: 'V', email: 'v@example.com' });
		await seedComment({ author: 'U', email: 'u@example.com' });
		await seedVerification({ email: 'v@example.com', verified: 1 });
		const res = await api('/admin/stats/users?verified=true', { headers: authed() });
		expect(res.body.data.users.map((u: any) => u.author)).toEqual(['V']);
	});

	it('verified=false 只返回未验证用户', async () => {
		await seedComment({ author: 'V', email: 'v@example.com' });
		await seedComment({ author: 'U', email: 'u@example.com' });
		await seedVerification({ email: 'v@example.com', verified: 1 });
		const res = await api('/admin/stats/users?verified=false', { headers: authed() });
		expect(res.body.data.users.map((u: any) => u.author)).toEqual(['U']);
	});

	it('未验证记录（verified=0）不算已验证', async () => {
		await seedComment({ author: 'U', email: 'u@example.com' });
		await seedVerification({ email: 'u@example.com', verified: 0 });
		expect((await api('/admin/stats/users?verified=true', { headers: authed() })).body.data.users).toEqual([]);
	});

	it('非法 verified 值等同于 all', async () => {
		await seedComment({ author: 'U', email: 'u@example.com' });
		for (const value of ['maybe', '', 'none']) {
			const res = await api(`/admin/stats/users?verified=${value}`, { headers: authed() });
			expect(res.body.data.users).toHaveLength(1);
		}
	});

	it('verified 值大小写不敏感', async () => {
		await seedComment({ author: 'U', email: 'u@example.com' });
		await seedVerification({ email: 'u@example.com', verified: 1 });
		expect((await api('/admin/stats/users?verified=TRUE', { headers: authed() })).body.data.users).toHaveLength(1);
		expect((await api('/admin/stats/users?verified=False', { headers: authed() })).body.data.users).toHaveLength(0);
	});

	it('search 按昵称或邮箱模糊匹配（不区分大小写）', async () => {
		await seedComment({ author: 'Alice', email: 'alice@example.com' });
		await seedComment({ author: 'Bob', email: 'bob@example.com' });
		expect(
			(await api('/admin/stats/users?search=alice', { headers: authed() })).body.data.users.map((u: any) => u.author)
		).toEqual(['Alice']);
		expect(
			(await api('/admin/stats/users?search=BOB@', { headers: authed() })).body.data.users.map((u: any) => u.author)
		).toEqual(['Bob']);
		expect((await api('/admin/stats/users?search=zzz', { headers: authed() })).body.data.users).toEqual([]);
	});

	it('search 两端空白被裁剪', async () => {
		await seedComment({ author: 'Alice', email: 'alice@example.com' });
		expect((await api('/admin/stats/users?search=%20alice%20', { headers: authed() })).body.data.users).toHaveLength(1);
	});

	it('邮箱黑名单中的用户被标记 blacklisted（不区分大小写）', async () => {
		await seedComment({ author: 'Bad', email: 'Bad@Example.com' });
		await seedSettings({ email_blacklist: JSON.stringify(['bad@example.com']) });
		const res = await api('/admin/stats/users', { headers: authed() });
		expect(res.body.data.users[0].blacklisted).toBe(true);
	});

	it('邮箱黑名单为非法 JSON 时不标记任何用户', async () => {
		await seedComment({ author: 'Bad', email: 'bad@example.com' });
		await seedSettings({ email_blacklist: 'not-json' });
		const res = await api('/admin/stats/users', { headers: authed() });
		expect(res.body.data.users[0].blacklisted).toBe(false);
	});

	it('分页：limit 上限 100，page 钳制为 1', async () => {
		for (let i = 0; i < 3; i++) {
			await seedComment({ author: `U${i}`, email: `u${i}@example.com` });
		}
		const capped = await api('/admin/stats/users?limit=999', { headers: authed() });
		expect(capped.body.data.pagination.limit).toBe(100);

		const paged = await api('/admin/stats/users?limit=2&page=2', { headers: authed() });
		expect(paged.body.data.users).toHaveLength(1);
		expect(paged.body.data.pagination).toEqual({ page: 2, limit: 2, totalPage: 2 });

		const clamped = await api('/admin/stats/users?page=-1', { headers: authed() });
		expect(clamped.body.data.pagination.page).toBe(1);
	});

	it('limit=0 因 || 短路回落到默认 20', async () => {
		await seedComment();
		expect((await api('/admin/stats/users?limit=0', { headers: authed() })).body.data.pagination.limit).toBe(20);
	});

	it('分页 totalPage 基于过滤后的去重用户数', async () => {
		for (let i = 0; i < 5; i++) {
			await seedComment({ author: `U${i}`, email: `u${i}@example.com` });
		}
		const res = await api('/admin/stats/users?limit=2', { headers: authed() });
		expect(res.body.data.pagination.totalPage).toBe(3);
	});
});

/**
 * 用户列表的「网站链接是否休眠」列（新增 `url` + `urlDormant`，与 Node 版同口径）。
 *
 * 身份口径与公开评论区的 `urlDormant` 完全一致（见 doc/link_security.md 第 2 节）：
 * 按归一化邮箱识别同一个人、跨文章统计最后一条评论、严格大于 N 天、
 * `rejected` / `deleted` 不计入「来过」、网址取「最近一次非空」。
 */
describe('GET /admin/stats/users — 网站链接是否休眠', () => {
	const DAY = 24 * 3600 * 1000;

	const userOf = (body: any, email: string) =>
		body.data.users.find((u: any) => u.email.trim().toLowerCase() === email);

	it('从来没有留过网址：url 为空串、urlDormant 为 false', async () => {
		await seedComment({ author: '甲', email: 'a@x.com', url: null, pub_date: Date.now() - 90 * DAY });
		await seedSettings({ link_security_enabled: 'true' });

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.url).toBe('');
		expect(user.urlDormant).toBe(false);
	});

	it('功能关闭：不标记休眠，但仍然下发用户留过的网址', async () => {
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 90 * DAY,
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.url).toBe('https://a.example.com');
		expect(user.urlDormant).toBe(false);
	});

	it('超过 N 天没来评论：标记为休眠', async () => {
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: '30' });
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 31 * DAY,
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.url).toBe('https://a.example.com');
		expect(user.urlDormant).toBe(true);
	});

	it('刚好 N 天不算休眠（严格大于）', async () => {
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: '30' });
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 30 * DAY + 60000,
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		expect(userOf(res.body, 'a@x.com').urlDormant).toBe(false);
	});

	it('以最新链接为准：较晚的评论带新网址时取新网址', async () => {
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: '30' });
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://old.example.com',
			pub_date: Date.now() - 60 * DAY,
		});
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://new.example.com',
			pub_date: Date.now() - 31 * DAY,
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.url).toBe('https://new.example.com');
		expect(user.urlDormant).toBe(true);
	});

	it('较晚的评论没有网址时，保留最近一次非空网址', async () => {
		await seedSettings({ link_security_enabled: 'true' });
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://old.example.com',
			pub_date: Date.now() - 60 * DAY,
		});
		await seedComment({ author: '甲', email: 'a@x.com', url: null, pub_date: Date.now() - 60000 });

		const res = await api('/admin/stats/users', { headers: authed() });
		const user = userOf(res.body, 'a@x.com');
		expect(user.url).toBe('https://old.example.com');
		// 刚刚评论过 → 不休眠
		expect(user.urlDormant).toBe(false);
	});

	it('身份按邮箱归一化：换昵称后再次评论同样解除休眠', async () => {
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: '30' });
		await seedComment({
			author: '甲',
			email: 'A@X.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 90 * DAY,
		});
		await seedComment({
			author: '甲（改名）',
			email: ' a@x.com ',
			url: 'https://a.example.com',
			pub_date: Date.now() - DAY,
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		const renamed = userOf(res.body, 'a@x.com');
		expect(renamed.urlDormant).toBe(false);
		expect(renamed.url).toBe('https://a.example.com');
	});

	it('rejected / deleted 的评论不算「来过」', async () => {
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: '30' });
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 90 * DAY,
			status: 'approved',
		});
		await seedComment({
			author: '甲',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 60000,
			status: 'deleted',
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		expect(userOf(res.body, 'a@x.com').urlDormant).toBe(true);
	});

	it('天数脏值按默认 30 天处理', async () => {
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: 'abc' });
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
			pub_date: Date.now() - 10 * DAY,
		});

		const res = await api('/admin/stats/users', { headers: authed() });
		expect(userOf(res.body, 'a@x.com').urlDormant).toBe(true);
		expect(userOf(res.body, 'b@x.com').urlDormant).toBe(false);
	});
});

/**
 * `linkStatus` 筛选（任务规范 §2 / §7）与 `urlTrustedSource`（§5）。
 *
 * 四个用户的形态：
 *  - Alice（a@x.com）：90 天前评论 + 有链接 → 休眠；
 *  - Bob（b@x.com）：90 天前评论 + 有链接 + 有效人工确认 → trusted（不休眠）；
 *  - Carol（c@x.com）：90 天前评论、没有链接 → none；
 *  - Dave（d@x.com）：刚刚评论 + 有链接 → normal。
 */
describe('GET /admin/stats/users — linkStatus 筛选与 urlTrustedSource', () => {
	const DAY = 24 * 3600 * 1000;

	const userOf = (body: any, email: string) =>
		body.data.users.find((u: any) => u.email.trim().toLowerCase() === email);
	const emailsOf = (body: any) =>
		body.data.users.map((u: any) => String(u.email).trim().toLowerCase()).sort();

	async function seedUsers() {
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: '30' });
		await seedComment({
			author: 'Alice',
			email: 'a@x.com',
			url: 'https://a.example.com',
			pub_date: Date.now() - 90 * DAY,
		});
		await seedComment({
			author: 'Bob',
			email: 'b@x.com',
			url: 'https://b.example.com',
			pub_date: Date.now() - 90 * DAY,
		});
		await seedTrustedLink({ email: 'b@x.com', url: 'https://b.example.com' });
		await seedComment({
			author: 'Carol',
			email: 'c@x.com',
			url: null,
			pub_date: Date.now() - 90 * DAY,
		});
		await seedComment({
			author: 'Dave',
			email: 'd@x.com',
			url: 'https://d.example.com',
			pub_date: Date.now() - 60000,
		});
	}

	it('dormant：只返回有链接且被判定为休眠的用户', async () => {
		await seedUsers();
		const res = await api('/admin/stats/users?linkStatus=dormant', { headers: authed() });
		expect(emailsOf(res.body)).toEqual(['a@x.com']);
		expect(userOf(res.body, 'a@x.com').urlDormant).toBe(true);
	});

	it('trusted：只返回有未过期人工确认的用户', async () => {
		await seedUsers();
		const res = await api('/admin/stats/users?linkStatus=trusted', { headers: authed() });
		expect(emailsOf(res.body)).toEqual(['b@x.com']);
		expect(userOf(res.body, 'b@x.com').urlDormant).toBe(false);
		expect(userOf(res.body, 'b@x.com').urlTrustedUntil).not.toBe('');
	});

	it('normal：有链接、既不休眠也没有处于人工确认中', async () => {
		await seedUsers();
		const res = await api('/admin/stats/users?linkStatus=normal', { headers: authed() });
		expect(emailsOf(res.body)).toEqual(['d@x.com']);
	});

	it('none：没有留下过链接的用户', async () => {
		await seedUsers();
		const res = await api('/admin/stats/users?linkStatus=none', { headers: authed() });
		expect(emailsOf(res.body)).toEqual(['c@x.com']);
		expect(userOf(res.body, 'c@x.com').url).toBe('');
	});

	it('无法识别的取值按 all 处理（与 verified=maybe 的宽容口径一致）', async () => {
		await seedUsers();
		for (const value of ['maybe', '', '  ', 'DORMANT2', '1']) {
			const res = await api(`/admin/stats/users?linkStatus=${encodeURIComponent(value)}`, {
				headers: authed(),
			});
			expect(emailsOf(res.body), value).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
		}
		// 大小写不敏感
		const upper = await api('/admin/stats/users?linkStatus=DORMANT', { headers: authed() });
		expect(emailsOf(upper.body)).toEqual(['a@x.com']);
	});

	it('过滤发生在分页之前：totalPage 反映过滤后的集合（2 个休眠 / limit=1 → 2 页）', async () => {
		await seedUsers();
		// Alice 之外再造一个休眠用户，共 2 个休眠
		await seedComment({
			author: 'Eve',
			email: 'e@x.com',
			url: 'https://e.example.com',
			pub_date: Date.now() - 90 * DAY,
		});

		const res = await api('/admin/stats/users?linkStatus=dormant&limit=1', { headers: authed() });
		expect(res.body.data.users).toHaveLength(1);
		expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 1, totalPage: 2 });

		const second = await api('/admin/stats/users?linkStatus=dormant&limit=1&page=2', {
			headers: authed(),
		});
		expect(second.body.data.users).toHaveLength(1);
		const both = [...emailsOf(res.body), ...emailsOf(second.body)].sort();
		expect(both).toEqual(['a@x.com', 'e@x.com']);
	});

	it('与 search / verified 组合', async () => {
		await seedUsers();
		await seedVerification({ email: 'a@x.com', verified: 1 });

		const bySearch = await api('/admin/stats/users?linkStatus=dormant&search=alice', {
			headers: authed(),
		});
		expect(emailsOf(bySearch.body)).toEqual(['a@x.com']);

		const noMatch = await api('/admin/stats/users?linkStatus=dormant&search=bob', {
			headers: authed(),
		});
		expect(emailsOf(noMatch.body)).toEqual([]);
		expect(noMatch.body.data.pagination.totalPage).toBe(0);

		const verifiedTrue = await api('/admin/stats/users?linkStatus=dormant&verified=true', {
			headers: authed(),
		});
		expect(emailsOf(verifiedTrue.body)).toEqual(['a@x.com']);

		const verifiedFalse = await api('/admin/stats/users?linkStatus=dormant&verified=false', {
			headers: authed(),
		});
		expect(emailsOf(verifiedFalse.body)).toEqual([]);
	});

	it('功能关闭时 dormant 为空集，none / normal / trusted 仍按各自语义工作', async () => {
		await seedUsers();
		await testEnv.MOMO_DB.prepare("UPDATE Settings SET value = 'false' WHERE key = 'link_security_enabled'").run();

		const dormant = await api('/admin/stats/users?linkStatus=dormant', { headers: authed() });
		expect(emailsOf(dormant.body)).toEqual([]);

		// 关闭时 Alice 不再休眠 → 落到 normal（trusted 与开关无关）
		const normal = await api('/admin/stats/users?linkStatus=normal', { headers: authed() });
		expect(emailsOf(normal.body)).toEqual(['a@x.com', 'd@x.com']);

		const none = await api('/admin/stats/users?linkStatus=none', { headers: authed() });
		expect(emailsOf(none.body)).toEqual(['c@x.com']);

		const trusted = await api('/admin/stats/users?linkStatus=trusted', { headers: authed() });
		expect(emailsOf(trusted.body)).toEqual(['b@x.com']);
	});

	it('urlTrustedSource：管理员确认 → admin，无确认 → 空串', async () => {
		await seedUsers();
		const res = await api('/admin/stats/users', { headers: authed() });
		expect(userOf(res.body, 'b@x.com').urlTrustedSource).toBe('admin');
		expect(userOf(res.body, 'a@x.com').urlTrustedSource).toBe('');
		expect(userOf(res.body, 'c@x.com').urlTrustedSource).toBe('');
	});

	it('urlTrustedSource：本人从提醒页确认 → self', async () => {
		await seedUsers();
		await seedDormantNotice({
			email: 'a@x.com',
			url: 'https://a.example.com',
			last_comment_at: Date.now() - 90 * DAY,
			token: 'tok-self',
		});

		const confirm = await api('/api/link-dormant/confirm?token=tok-self', { method: 'POST' });
		expect(confirm.status).toBe(200);
		expect(String(confirm.body)).toContain('确认成功！');

		const res = await api('/admin/stats/users', { headers: authed() });
		expect(userOf(res.body, 'a@x.com').urlTrustedSource).toBe('self');
		expect(userOf(res.body, 'a@x.com').urlDormant).toBe(false);
		expect(userOf(res.body, 'a@x.com').urlTrustedUntil).not.toBe('');
	});
});

describe('GET /admin/stats/users/comments', () => {	it('缺少 author 或 email 返回 400', async () => {
		expect((await api('/admin/stats/users/comments', { headers: authed() })).status).toBe(400);
		expect((await api('/admin/stats/users/comments?author=A', { headers: authed() })).status).toBe(400);
		expect((await api('/admin/stats/users/comments?email=a@example.com', { headers: authed() })).status).toBe(400);
	});

	it('返回该用户的评论（按 pub_date 倒序）与分页信息', async () => {
		await seedComment({ author: 'A', email: 'a@example.com', pub_date: 1730000000000, content_text: 'old' });
		await seedComment({ author: 'A', email: 'a@example.com', pub_date: 1750000000000, content_text: 'new' });
		await seedComment({ author: 'B', email: 'b@example.com' });

		const res = await api('/admin/stats/users/comments?author=A&email=a@example.com', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.message).toBe('User comments fetched successfully');
		expect(res.body.data.comments.map((c: any) => c.contentText)).toEqual(['new', 'old']);
		expect(res.body.data.comments[0]).toMatchObject({
			postSlug: '/posts/demo',
			author: 'A',
			email: 'a@example.com',
			// 后台头像按来源配置生成，不受 avatar_enabled 影响
			avatar: 'https://open.motues.top/avatar?name=b418773a2c51fb9777a1648346fa7394&mode=cravatar&variant=beam',
			status: 'approved',
			pubDate: new Date(1750000000000).toISOString(),
		});
		expect(res.body.data.pagination).toEqual({ page: 1, limit: 10, totalPage: 1 });
	});

	it('同名不同邮箱不会互相混入', async () => {
		await seedComment({ author: 'A', email: 'a@example.com' });
		await seedComment({ author: 'A', email: 'other@example.com' });
		const res = await api('/admin/stats/users/comments?author=A&email=a@example.com', { headers: authed() });
		expect(res.body.data.comments).toHaveLength(1);
		expect(res.body.data.comments[0].email).toBe('a@example.com');
	});

	it('每页固定 10 条并支持翻页', async () => {
		for (let i = 0; i < 12; i++) {
			await seedComment({ author: 'A', email: 'a@example.com', pub_date: 1700000000000 + i * 1000 });
		}
		const second = await api('/admin/stats/users/comments?author=A&email=a@example.com&page=2', { headers: authed() });
		expect(second.body.data.comments).toHaveLength(2);
		expect(second.body.data.pagination).toEqual({ page: 2, limit: 10, totalPage: 2 });
	});

	it('查不到用户时返回空列表但 200', async () => {
		const res = await api('/admin/stats/users/comments?author=X&email=x@example.com', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.data.comments).toEqual([]);
		expect(res.body.data.pagination.totalPage).toBe(0);
	});

	it('未被任何评论引用的用户不会出现在 /admin/stats/users', async () => {
		const res = await api('/admin/stats/users', { headers: authed() });
		expect(res.body.data.users).toEqual([]);
		expect(await testEnv.MOMO_DB.prepare('SELECT COUNT(*) as c FROM Comment').first()).toEqual({ c: 0 });
	});
});

/**
 * 数据统计页首页扩展（窗口指标 / 热门文章 / 客户端分布 / 最新评论）：
 * 全部是**新增字段**，不改变既有字段的口径与格式。
 * 归一化规则本身由 test/unit/vectors.stats-distribution-v1.test.ts 的固定向量钉死，
 * 这里只验证接口层的聚合、排序、截断与序列化。
 */
describe('GET /admin/stats/overview — 新增字段：空库', () => {
	it('空库时所有列表为 []（不是 null）、窗口指标为 0、环比为 null', async () => {
		const res = await api('/admin/stats/overview', { headers: authed() });
		expect(res.status).toBe(200);
		const d = res.body.data;

		expect(d.topPosts).toEqual([]);
		expect(d.deviceDistribution).toEqual([]);
		expect(d.browserDistribution).toEqual([]);
		expect(d.osDistribution).toEqual([]);
		expect(d.latestComments).toEqual([]);

		expect(d.windowComments).toBe(0);
		expect(d.prevWindowComments).toBe(0);
		expect(d.commentsDelta).toBeNull();
		expect(d.windowUsers).toBe(0);
		expect(d.prevWindowUsers).toBe(0);
		expect(d.usersDelta).toBeNull();
		expect(d.todayComments).toBe(0);
		expect(d.last7DaysComments).toBe(0);
	});
});

describe('GET /admin/stats/overview — 热门文章 Top 5', () => {
	it('按评论数倒序、并列按 post_slug 升序、最多 5 条，lastCommentDate 为 ISO', async () => {
		// count：a=2 b=2 c=d=e=f=1；并列的 1 条组按 slug 升序取前三个
		await seedComment({ post_slug: '/p/a', pub_date: 1730000000000 });
		await seedComment({ post_slug: '/p/a', pub_date: 1730000000001 });
		await seedComment({ post_slug: '/p/b', pub_date: 1730000000002 });
		await seedComment({ post_slug: '/p/b', pub_date: 1730000000003 });
		for (const slug of ['/p/c', '/p/d', '/p/e', '/p/f']) {
			await seedComment({ post_slug: slug, pub_date: 1730000000004 });
		}

		const res = await api('/admin/stats/overview', { headers: authed() });
		const topPosts = res.body.data.topPosts;
		expect(topPosts.map((p: any) => p.postSlug)).toEqual(['/p/a', '/p/b', '/p/c', '/p/d', '/p/e']);
		expect(topPosts[0]).toEqual({
			postSlug: '/p/a',
			count: 2,
			lastCommentDate: new Date(1730000000001).toISOString(),
		});
		expect(topPosts[2]).toEqual({
			postSlug: '/p/c',
			count: 1,
			lastCommentDate: new Date(1730000000004).toISOString(),
		});
	});
});

describe('GET /admin/stats/overview — 浏览器分布', () => {
	it('归一化版本号 → 同名合并 → 数量降序/名称升序 → 截断 5 档', async () => {
		const browsers = [
			'Chrome 142.0.0.0',
			'Chrome 145.0.0.0',
			'  Chrome  ', // 两端空白，仍归入 Chrome
			'Edge 147.0.0.0',
			'Edge 147.0.0.0',
			'Safari 17.0',
			'Safari 17.0',
			'Firefox 121.0',
			'Mobile Chrome 122.0.0.0',
			'Opera 9.80',
			'Mobile Safari 17.0',
		];
		for (const browser of browsers) {
			await seedComment({ browser });
		}

		const res = await api('/admin/stats/overview', { headers: authed() });
		// Opera（1）与 Mobile Safari（1）因升序排在后面被截掉
		expect(res.body.data.browserDistribution).toEqual([
			{ name: 'Chrome', count: 3 },
			{ name: 'Edge', count: 2 },
			{ name: 'Safari', count: 2 },
			{ name: 'Firefox', count: 1 },
			{ name: 'Mobile Chrome', count: 1 },
		]);
	});
});

describe('GET /admin/stats/overview — 操作系统分布', () => {
	it('归一化合并后按数量降序/名称升序取 5 档', async () => {
		const systems = [
			'Windows 10',
			'Windows 10.0',
			'Windows 11',
			'macOS 10.15.7',
			'iOS 17.7.2',
			'Android 10',
			'Android 12',
			'HarmonyOS ', // 尾部空白
			'Chrome OS 120.0.0.0',
		];
		for (const os of systems) {
			await seedComment({ os });
		}

		const res = await api('/admin/stats/overview', { headers: authed() });
		// macOS（1）被截掉：Chrome OS < HarmonyOS < iOS
		expect(res.body.data.osDistribution).toEqual([
			{ name: 'Windows', count: 3 },
			{ name: 'Android', count: 2 },
			{ name: 'Chrome OS', count: 1 },
			{ name: 'HarmonyOS', count: 1 },
			{ name: 'iOS', count: 1 },
		]);
	});
});

describe('GET /admin/stats/overview — 设备分布', () => {
	it('空值算桌面、移动关键词优先于桌面关键词、机型码算移动、平板单列', async () => {
		const devices: (string | null)[] = [
			null, // ua-parser 对桌面端不下发 device
			'',
			'Desktop',
			'iPhone',
			'Windows Phone', // 同时含 windows 与 phone，必须判为移动
			'ABR-AL60', // 只剩机型码
			'iPad',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
		];
		for (const device of devices) {
			await seedComment({ device });
		}

		const res = await api('/admin/stats/overview', { headers: authed() });
		// 桌面(3) 与 移动(3) 并列：按名称升序 桌面(U+684C) < 移动(U+79FB)
		expect(res.body.data.deviceDistribution).toEqual([
			{ name: '桌面', count: 3 },
			{ name: '移动', count: 3 },
			{ name: '平板', count: 1 },
			{ name: '未知', count: 1 },
		]);
	});

	it('历史脏数据：整条原始 UA 三列都归入「未知」', async () => {
		const ua =
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
		await seedComment({ browser: ua, os: ua, device: ua });
		await seedComment({ browser: ua, os: ua, device: ua });

		const res = await api('/admin/stats/overview', { headers: authed() });
		expect(res.body.data.browserDistribution).toEqual([{ name: '未知', count: 2 }]);
		expect(res.body.data.osDistribution).toEqual([{ name: '未知', count: 2 }]);
		expect(res.body.data.deviceDistribution).toEqual([{ name: '未知', count: 2 }]);
	});
});

describe('GET /admin/stats/overview — 时间窗口指标', () => {
	const DAY = 24 * 3600 * 1000;

	it('range=7：窗口与上一个等长窗口的评论数/活跃用户数与环比', async () => {
		const now = Date.now();
		// 当前窗口：今天起往前 7 天
		await seedComment({ author: 'A', email: 'a@example.com', pub_date: now - DAY });
		await seedComment({ author: 'B', email: 'b@example.com', pub_date: now - 2 * DAY });
		// 上一个窗口：再往前 7 天
		await seedComment({ author: 'C', email: 'c@example.com', pub_date: now - 8 * DAY });
		// 两个窗口之外
		await seedComment({ author: 'D', email: 'd@example.com', pub_date: now - 30 * DAY });

		const res = await api('/admin/stats/overview?range=7', { headers: authed() });
		const d = res.body.data;
		expect(d.windowComments).toBe(2);
		expect(d.prevWindowComments).toBe(1);
		expect(d.commentsDelta).toBe(100);
		expect(d.windowUsers).toBe(2);
		expect(d.prevWindowUsers).toBe(1);
		expect(d.usersDelta).toBe(100);
	});

	it('上一个窗口为 0 时环比为 null（不是 0 也不是 100）', async () => {
		await seedComment({ pub_date: Date.now() - 24 * 3600 * 1000 });
		const d = (await api('/admin/stats/overview?range=7', { headers: authed() })).body.data;
		expect(d.windowComments).toBe(1);
		expect(d.prevWindowComments).toBe(0);
		expect(d.commentsDelta).toBeNull();
		expect(d.windowUsers).toBe(1);
		expect(d.prevWindowUsers).toBe(0);
		expect(d.usersDelta).toBeNull();
	});

	it('环比按下取整（四舍五入）', async () => {
		const now = Date.now();
		for (let i = 0; i < 3; i++) {
			await seedComment({ author: `P${i}`, email: `p${i}@example.com`, pub_date: now - 8 * DAY });
		}
		await seedComment({ author: 'N', email: 'n@example.com', pub_date: now - DAY });
		const d = (await api('/admin/stats/overview?range=7', { headers: authed() })).body.data;
		// (1 - 3) / 3 * 100 = -66.67 → -67
		expect(d.commentsDelta).toBe(-67);
	});

	it('range=1 的窗口只有今天，上一个窗口是昨天', async () => {
		const now = new Date();
		const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		await seedComment({ pub_date: Date.now() });
		await seedComment({ pub_date: startOfToday - 3600 * 1000 });
		const d = (await api('/admin/stats/overview?range=1', { headers: authed() })).body.data;
		expect(d.windowComments).toBe(1);
		expect(d.prevWindowComments).toBe(1);
	});

	it('range=all：窗口 = 最近 12 个自然月，且等于 recentComments 之和；上一窗口 = 再往前 12 个月', async () => {
		const now = new Date();
		const sixMonthsAgo = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 15);
		const thirteenMonthsAgo = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15);
		await seedComment({ pub_date: Date.now() });
		await seedComment({ pub_date: sixMonthsAgo });
		await seedComment({ pub_date: thirteenMonthsAgo });

		const d = (await api('/admin/stats/overview?range=all', { headers: authed() })).body.data;
		expect(d.windowComments).toBe(2);
		expect(d.windowComments).toBe(
			d.recentComments.reduce((sum: number, row: any) => sum + row.count, 0)
		);
		expect(d.prevWindowComments).toBe(1);
		// range=0 与 range=all 同口径
		const zero = (await api('/admin/stats/overview?range=0', { headers: authed() })).body.data;
		expect(zero.windowComments).toBe(2);
		expect(zero.prevWindowComments).toBe(1);
	});
});

describe('GET /admin/stats/overview — 今日与最近 7 日', () => {
	const DAY = 24 * 3600 * 1000;

	it('todayComments 只算今天（UTC），last7DaysComments 含今天共 7 个 UTC 日', async () => {
		const now = Date.now();
		await seedComment({ pub_date: now });
		await seedComment({ pub_date: now });
		await seedComment({ pub_date: now - DAY });
		await seedComment({ pub_date: now - 6 * DAY });
		await seedComment({ pub_date: now - 7 * DAY }); // 第 8 个 UTC 日之前，不计入

		const d = (await api('/admin/stats/overview', { headers: authed() })).body.data;
		expect(d.todayComments).toBe(2);
		expect(d.last7DaysComments).toBe(4);
	});
});

describe('GET /admin/stats/overview — 最新评论动态', () => {
	it('按 pub_date 倒序取 5 条，含所有状态且不下发截断后的正文', async () => {
		const ids: number[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push(
				await seedComment({
					author: `U${i}`,
					email: `u${i}@example.com`,
					post_slug: `/p/${i}`,
					content_text: `content-${i}`,
					content_html: `<p>content-${i}</p>`,
					status: i % 2 === 0 ? 'pending' : 'approved',
					pub_date: 1730000000000 + i * 1000,
				})
			);
		}

		const d = (await api('/admin/stats/overview', { headers: authed() })).body.data;
		expect(d.latestComments).toHaveLength(5);
		expect(d.latestComments.map((c: any) => c.id)).toEqual([
			ids[5],
			ids[4],
			ids[3],
			ids[2],
			ids[1],
		]);
		expect(d.latestComments[0]).toEqual({
			id: ids[5],
			author: 'U5',
			email: 'u5@example.com',
			postSlug: '/p/5',
			contentText: 'content-5',
			status: 'approved',
			pubDate: new Date(1730000005000).toISOString(),
		});
	});

	it('pub_date 相同时按 id 倒序', async () => {
		const first = await seedComment({ author: '旧', pub_date: 1730000000000 });
		const second = await seedComment({ author: '新', pub_date: 1730000000000 });
		const d = (await api('/admin/stats/overview', { headers: authed() })).body.data;
		expect(d.latestComments.map((c: any) => c.id)).toEqual([second, first]);
	});

	it('deleted / rejected 也出现在动态里（含所有状态）', async () => {
		await seedComment({ status: 'deleted', pub_date: 1730000000000 });
		await seedComment({ status: 'rejected', pub_date: 1730000001000 });
		const d = (await api('/admin/stats/overview', { headers: authed() })).body.data;
		expect(d.latestComments.map((c: any) => c.status)).toEqual(['rejected', 'deleted']);
	});
});
