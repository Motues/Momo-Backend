/**
 * GET /api/comments —— 公开评论列表（只读 approved、嵌套、分页、博主标识、人机验证配置）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { api } from '../helpers/http';
import { createSchema, seedComment, seedSettings } from '../helpers/db';
import { allowRequest } from '../../src/utils/rateLimit';

const SLUG = '/posts/demo';
const ADMIN_EMAIL = 'admin@example.com';

/** 递增 IP：评论列表限流是模块级内存计数（120/分钟），避免用例之间互相打满 */
let ipCounter = 0;
async function getComments(query: string, headers: Record<string, string> = {}) {
	ipCounter += 1;
	return await api(`/api/comments${query}`, {
		ip: `198.18.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
		headers,
	});
}

beforeEach(createSchema);

describe('GET /api/comments —— 参数校验', () => {
	it('缺少 post_slug 返回 400', async () => {
		const res = await getComments('');
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ code: 400, message: 'post_slug is required' });
	});

	it('post_slug 为空串同样返回 400', async () => {
		const res = await getComments('?post_slug=');
		expect(res.status).toBe(400);
	});

	it('page / limit 非法时使用默认值', async () => {
		await seedComment({ post_slug: SLUG });
		const res = await getComments(`?post_slug=${SLUG}&page=abc&limit=abc`);
		expect(res.status).toBe(200);
		expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, totalPage: 1 });
	});

	it('page=0 / 负数被钳制为 1', async () => {
		await seedComment({ post_slug: SLUG });
		for (const page of ['0', '-5']) {
			const res = await getComments(`?post_slug=${SLUG}&page=${page}`);
			expect(res.body.data.pagination.page).toBe(1);
		}
	});

	it('limit 上限被钳制为 50，负数为 1，0 因 || 短路回落到默认 20', async () => {
		await seedComment({ post_slug: SLUG });
		expect((await getComments(`?post_slug=${SLUG}&limit=999`)).body.data.pagination.limit).toBe(50);
		expect((await getComments(`?post_slug=${SLUG}&limit=-3`)).body.data.pagination.limit).toBe(1);
		// parseInt('0') === 0 是 falsy，被 `|| 20` 短路成默认值
		expect((await getComments(`?post_slug=${SLUG}&limit=0`)).body.data.pagination.limit).toBe(20);
	});
});

describe('GET /api/comments —— 过滤与排序', () => {
	it('只返回指定文章的评论', async () => {
		await seedComment({ post_slug: '/posts/a', author: 'A' });
		await seedComment({ post_slug: '/posts/b', author: 'B' });
		const res = await getComments('?post_slug=/posts/a');
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['A']);
	});

	it('只返回 approved 状态', async () => {
		await seedComment({ post_slug: SLUG, author: 'Approved', status: 'approved' });
		await seedComment({ post_slug: SLUG, author: 'Pending', status: 'pending' });
		await seedComment({ post_slug: SLUG, author: 'Rejected', status: 'rejected' });
		await seedComment({ post_slug: SLUG, author: 'Deleted', status: 'deleted' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['Approved']);
	});

	it('按 pub_date 倒序排列', async () => {
		await seedComment({ post_slug: SLUG, author: 'Old', pub_date: 1700000000000 });
		await seedComment({ post_slug: SLUG, author: 'New', pub_date: 1750000000000 });
		await seedComment({ post_slug: SLUG, author: 'Mid', pub_date: 1730000000000 });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['New', 'Mid', 'Old']);
	});

	it('没有任何评论时返回空列表且 totalPage 为 1', async () => {
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.status).toBe(200);
		expect(res.body.data.comments).toEqual([]);
		expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, totalPage: 1 });
	});
});

describe('GET /api/comments —— 响应体契约', () => {
	it('不泄露 email，url 为空时字段被省略', async () => {
		await seedComment({ post_slug: SLUG, email: 'private@example.com', url: null });
		const res = await getComments(`?post_slug=${SLUG}`);
		const comment = res.body.data.comments[0];
		expect(JSON.stringify(res.body)).not.toContain('private@example.com');
		expect(comment.email).toBeUndefined();
		expect(comment.url).toBeUndefined();
	});

	it('url 有值时原样返回', async () => {
		await seedComment({ post_slug: SLUG, url: 'https://me.example.com' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].url).toBe('https://me.example.com');
	});

	it('pubDate 输出 ISO 字符串（库里是毫秒整数）', async () => {
		await seedComment({ post_slug: SLUG, pub_date: 1730000000000 });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].pubDate).toBe('2024-10-27T03:33:20.000Z');
	});

	it('历史 ISO 字符串 pub_date 也能输出 ISO', async () => {
		await seedComment({ post_slug: SLUG, pub_date: '2024-03-05T06:07:08.000Z' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].pubDate).toBe('2024-03-05T06:07:08.000Z');
	});

	it('无法解析的 pub_date 输出空串（而不是 Invalid Date）', async () => {
		await seedComment({ post_slug: SLUG, pub_date: 'garbage' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].pubDate).toBe('');
	});

	it('contentText / contentHtml 字段名与数据库列映射正确', async () => {
		await seedComment({ post_slug: SLUG, content_text: 'plain', content_html: '<p>plain</p>' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].contentText).toBe('plain');
		expect(res.body.data.comments[0].contentHtml).toBe('<p>plain</p>');
	});

	it('头像使用 cravatar MD5（邮箱去空格 + 小写）', async () => {
		await seedComment({ post_slug: SLUG, email: '  Alice@Example.COM ' });
		const res = await getComments(`?post_slug=${SLUG}`);
		const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode('alice@example.com'));
		const hex = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(res.body.data.comments[0].avatar).toBe(
			`https://open.motues.top/avatar?name=${hex}&mode=cravatar&variant=beam`
		);
	});

	it('MD5 取值固定（运行时 MD5 实现未漂移）', async () => {
		await seedComment({ post_slug: SLUG, email: 'a@b.c' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].avatar).toBe(
			'https://open.motues.top/avatar?name=5d60d4e28066df254d5452f92c910092&mode=cravatar&variant=beam'
		);
	});
});

describe('GET /api/comments —— 博主标识与设置下发', () => {
	it('邮箱等于 admin_email 的评论标记 isBlogger', async () => {
		await seedSettings({ admin_email: ADMIN_EMAIL });
		await seedComment({ post_slug: SLUG, author: 'Admin', email: ADMIN_EMAIL });
		await seedComment({ post_slug: SLUG, author: 'Guest', email: 'guest@example.com', pub_date: 1700000000000 });
		const res = await getComments(`?post_slug=${SLUG}`);
		const byAuthor = Object.fromEntries(res.body.data.comments.map((c: any) => [c.author, c.isBlogger]));
		expect(byAuthor).toEqual({ Admin: true, Guest: false });
	});

	it('未配置 admin_email 时没有评论被标记为博主', async () => {
		await seedComment({ post_slug: SLUG, email: ADMIN_EMAIL });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].isBlogger).toBe(false);
	});

	it('下发博主徽章 / 占位符设置', async () => {
		await seedSettings({
			blogger_badge_enabled: 'true',
			blogger_badge_text: '博主',
			placeholder_name: '昵称',
			placeholder_email: '邮箱',
			placeholder_content: '内容',
			placeholder_url: '网址',
		});
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data).toMatchObject({
			blogger_badge_enabled: 'true',
			blogger_badge_text: '博主',
			placeholder_name: '昵称',
			placeholder_email: '邮箱',
			placeholder_content: '内容',
			placeholder_url: '网址',
		});
	});

	it('未配置时博主徽章相关字段回落到空值 / false', async () => {
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data).toMatchObject({
			blogger_badge_enabled: 'false',
			blogger_badge_text: '',
			placeholder_name: '',
			admin_comment_key_configured: 'false',
			admin_email_hash: '',
			verify_enabled: 'false',
			verify_honeypot: '',
			verify_version: '2',
		});
	});

	it('密钥功能开启时下发 admin_comment_key_configured = "true" 与邮箱哈希', async () => {
		await seedSettings({
			admin_email: ADMIN_EMAIL,
			admin_comment_key: 'k',
			admin_comment_key_enabled: 'true',
		});
		const res = await getComments(`?post_slug=${SLUG}`);
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ADMIN_EMAIL));
		const expected = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(res.body.data.admin_comment_key_configured).toBe('true');
		expect(res.body.data.admin_email_hash).toBe(expected);
	});

	it('密钥功能关闭时不下发邮箱哈希（避免离线枚举管理员邮箱）', async () => {
		await seedSettings({ admin_email: ADMIN_EMAIL, admin_comment_key: 'k' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.admin_email_hash).toBe('');
		expect(res.body.data.admin_comment_key_configured).toBe('false');
	});

	it('开启无感验证时下发 verify_enabled 与按文章派生的蜜罐字段', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.verify_enabled).toBe('true');
		expect(res.body.data.verify_honeypot).toMatch(/^v_[0-9a-f]{10}$/);
		// 前端据此判断前后端协议是否配套（协议 v2）
		expect(res.body.data.verify_version).toBe('2');
	});

	it('蜜罐字段名随 post_slug 变化', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		const a = await getComments('?post_slug=/posts/a');
		const b = await getComments('?post_slug=/posts/b');
		expect(a.body.data.verify_honeypot).not.toBe(b.body.data.verify_honeypot);
	});
});

describe('GET /api/comments —— 嵌套与分页', () => {
	it('回复挂在父评论的 replies 下，父评论不出现在顶层', async () => {
		const parentId = await seedComment({ post_slug: SLUG, author: 'Parent', pub_date: 1730000000000 });
		await seedComment({ post_slug: SLUG, author: 'Child', parent_id: parentId, pub_date: 1720000000000 });
		const res = await getComments(`?post_slug=${SLUG}`);
		const comments = res.body.data.comments;
		expect(comments).toHaveLength(1);
		expect(comments[0].author).toBe('Parent');
		expect(comments[0].replies.map((r: any) => r.author)).toEqual(['Child']);
	});

	it('多层回复会按父链挂载（不是扁平化）', async () => {
		const root = await seedComment({ post_slug: SLUG, author: 'Root', pub_date: 1750000000000 });
		const mid = await seedComment({ post_slug: SLUG, author: 'Mid', parent_id: root, pub_date: 1740000000000 });
		await seedComment({ post_slug: SLUG, author: 'Leaf', parent_id: mid, pub_date: 1730000000000 });
		const res = await getComments(`?post_slug=${SLUG}`);
		const rootNode = res.body.data.comments[0];
		expect(rootNode.author).toBe('Root');
		expect(rootNode.replies[0].author).toBe('Mid');
		expect(rootNode.replies[0].replies[0].author).toBe('Leaf');
	});

	it('父评论未通过审核时回复被丢弃（不会变成顶层评论）', async () => {
		const pendingParent = await seedComment({ post_slug: SLUG, author: 'PendingParent', status: 'pending' });
		await seedComment({ post_slug: SLUG, author: 'Orphan', parent_id: pendingParent });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments).toEqual([]);
	});

	it('父评论属于其它文章时回复被丢弃', async () => {
		const otherParent = await seedComment({ post_slug: '/posts/other', author: 'OtherParent' });
		await seedComment({ post_slug: SLUG, author: 'Orphan', parent_id: otherParent });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments).toEqual([]);
	});

	it('nested=false 时返回扁平列表且按 pub_date 倒序', async () => {
		const parentId = await seedComment({ post_slug: SLUG, author: 'Parent', pub_date: 1730000000000 });
		await seedComment({ post_slug: SLUG, author: 'Child', parent_id: parentId, pub_date: 1740000000000 });
		const res = await getComments(`?post_slug=${SLUG}&nested=false`);
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['Child', 'Parent']);
		expect(res.body.data.comments[0].replies).toEqual([]);
	});

	it('嵌套模式下按顶层评论分页', async () => {
		for (let i = 0; i < 5; i++) {
			await seedComment({ post_slug: SLUG, author: `Root${i}`, pub_date: 1730000000000 + i * 1000 });
		}
		const res = await getComments(`?post_slug=${SLUG}&limit=2&page=2`);
		expect(res.body.data.comments).toHaveLength(2);
		expect(res.body.data.pagination).toEqual({ page: 2, limit: 2, totalPage: 3 });
		// pub_date 倒序：page2 应为 Root2 / Root1
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['Root2', 'Root1']);
	});

	it('嵌套模式下回复不计入顶层分页', async () => {
		const parentId = await seedComment({ post_slug: SLUG, pub_date: 1750000000000 });
		for (let i = 0; i < 5; i++) {
			await seedComment({ post_slug: SLUG, parent_id: parentId, author: `Child${i}` });
		}
		const res = await getComments(`?post_slug=${SLUG}&limit=2`);
		expect(res.body.data.comments).toHaveLength(1);
		expect(res.body.data.comments[0].replies).toHaveLength(5);
		expect(res.body.data.pagination.totalPage).toBe(1);
	});

	it('扁平模式按全部评论分页', async () => {
		for (let i = 0; i < 5; i++) {
			await seedComment({ post_slug: SLUG, author: `C${i}`, pub_date: 1730000000000 + i * 1000 });
		}
		const res = await getComments(`?post_slug=${SLUG}&nested=false&limit=2&page=3`);
		expect(res.body.data.comments.map((c: any) => c.author)).toEqual(['C0']);
		expect(res.body.data.pagination).toEqual({ page: 3, limit: 2, totalPage: 3 });
	});

	it('超出末页时返回空数组但 totalPage 仍正确', async () => {
		await seedComment({ post_slug: SLUG });
		const res = await getComments(`?post_slug=${SLUG}&page=99`);
		expect(res.body.data.comments).toEqual([]);
		expect(res.body.data.pagination.totalPage).toBe(1);
	});
});

describe('GET /api/comments —— 限流', () => {
	it('同一 IP 每分钟超过 120 次后被限流', async () => {
		const ip = '198.51.100.250';
		// 直接使用与路由同一个模块实例的滑动窗口，先把该 IP 的计数填到 119，
		// 这样只需 2 次真实 HTTP 请求即可覆盖到第 121 次的分支（120 次请求会超时）。
		const key = `comments:get:${ip}`;
		for (let i = 0; i < 119; i++) {
			expect(allowRequest(key, 120, 60_000)).toBe(true);
		}

		// 第 120 次仍然放行
		expect((await api(`/api/comments?post_slug=${SLUG}`, { ip })).status).toBe(200);

		// 第 121 次被限流
		const limited = await api(`/api/comments?post_slug=${SLUG}`, { ip });
		expect(limited.status).toBe(429);
		expect(limited.body).toEqual({ code: 429, message: 'Too many requests. Please slow down.' });
	});

	it('未达上限时连续请求都返回 200（对照）', async () => {
		const ip = '198.51.100.251';
		for (let i = 0; i < 5; i++) {
			expect((await api(`/api/comments?post_slug=${SLUG}`, { ip })).status).toBe(200);
		}
	});

	it('限流按 IP 隔离，一个 IP 被限流不影响其它 IP', async () => {
		const blockedIp = '198.51.100.252';
		for (let i = 0; i < 120; i++) {
			allowRequest(`comments:get:${blockedIp}`, 120, 60_000);
		}
		expect((await api(`/api/comments?post_slug=${SLUG}`, { ip: blockedIp })).status).toBe(429);
		expect((await api(`/api/comments?post_slug=${SLUG}`, { ip: '198.51.100.253' })).status).toBe(200);
	});
});
