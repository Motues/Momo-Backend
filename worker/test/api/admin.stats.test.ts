/**
 * /admin/stats/overview、/admin/stats/users、/admin/stats/users/comments —— 后台统计。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, seedComment, seedSettings, seedVerification, testEnv } from '../helpers/db';

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

describe('GET /admin/stats/users/comments', () => {
	it('缺少 author 或 email 返回 400', async () => {
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
