/**
 * GET /api/comments —— 公开评论列表（只读 approved、嵌套、分页、博主标识、人机验证配置）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api } from '../helpers/http';
import { createSchema, seedComment, seedSettings, seedTrustedLink, testEnv } from '../helpers/db';
import { allowRequest } from '../../src/utils/rateLimit';
import { DEFAULT_LINK_DORMANT_DAYS, DAY_MS } from '../../src/utils/linkSecurity';
import { DEFAULT_AVATAR_URL } from '../../src/utils/avatar';

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

/** 固定「现在」以断言休眠边界（刚好 N 天 vs N 天 + 1 毫秒） */
async function withFrozenNow<T>(now: number, run: () => Promise<T>): Promise<T> {
	const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
	try {
		return await run();
	} finally {
		spy.mockRestore();
	}
}

beforeEach(createSchema);

afterEach(() => {
	vi.restoreAllMocks();
});

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

	it('avatar_source=custom：按模板生成（占位符 + percent-encode）', async () => {
		await seedComment({ post_slug: SLUG, author: '张三', email: '张三@example.com' });
		await seedSettings({
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/avatar/{hash}.png?email={email}&name={author}',
		});
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].avatar).toBe(
			'https://cdn.example.com/avatar/3f848e3f116808796c3e9bc7a7e2cc44.png?email=%E5%BC%A0%E4%B8%89%40example.com&name=%E5%BC%A0%E4%B8%89'
		);
	});

	it('avatar_source=qq：QQ 邮箱走 qlogo，其余回落默认源', async () => {
		await seedComment({ post_slug: SLUG, author: 'QQ', email: '12345@qq.com' });
		await seedComment({ post_slug: SLUG, author: '普通', email: 'a@b.c' });
		await seedSettings({ avatar_source: 'qq' });
		const res = await getComments(`?post_slug=${SLUG}`);
		const byAuthor = Object.fromEntries(
			res.body.data.comments.map((comment: any) => [comment.author, comment.avatar])
		);
		expect(byAuthor['QQ']).toBe('https://q1.qlogo.cn/g?b=qq&nk=12345&s=100');
		expect(byAuthor['普通']).toBe(
			'https://open.motues.top/avatar?name=5d60d4e28066df254d5452f92c910092&mode=cravatar&variant=beam'
		);
	});

	it('avatar_enabled=false：所有评论统一下发内置默认头像（不丢已存配置）', async () => {
		await seedComment({ post_slug: SLUG, author: '张三', email: '张三@example.com' });
		await seedComment({ post_slug: SLUG, author: 'QQ', email: '12345@qq.com' });
		await seedSettings({
			avatar_enabled: 'false',
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/{hash}',
		});
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments).toHaveLength(2);
		for (const comment of res.body.data.comments) {
			expect(comment.avatar).toBe(DEFAULT_AVATAR_URL);
		}
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

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

describe('GET /api/comments —— 多管理员邮箱（doc/admin_emails.md）', () => {
	it('admin_emails 列表里的每个人都标记 isBlogger（归一化后命中）', async () => {
		await seedSettings({ admin_emails: '["a@x.com","b@y.com"]' });
		await seedComment({ post_slug: SLUG, author: 'A', email: '  A@X.com ', pub_date: 1730000003000 });
		await seedComment({ post_slug: SLUG, author: 'B', email: 'b@y.com', pub_date: 1730000002000 });
		await seedComment({ post_slug: SLUG, author: 'Guest', email: 'g@z.com', pub_date: 1730000001000 });
		const res = await getComments(`?post_slug=${SLUG}`);
		const byAuthor = Object.fromEntries(res.body.data.comments.map((c: any) => [c.author, c.isBlogger]));
		expect(byAuthor).toEqual({ A: true, B: true, Guest: false });
	});

	it('列表为空时回落旧键 admin_email（大小写/空格归一后命中）', async () => {
		await seedSettings({ admin_email: 'Admin@Example.com' });
		await seedComment({ post_slug: SLUG, author: 'Admin', email: 'admin@example.com' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].isBlogger).toBe(true);
	});

	it('密钥开启时下发 admin_email_hashes，且 admin_email_hash = 通知邮箱的哈希（旧前端兼容）', async () => {
		await seedSettings({
			admin_emails: '["a@x.com","b@y.com"]',
			notify_email: 'b@y.com',
			admin_comment_key_enabled: 'true',
		});
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.admin_email_hashes).toEqual([
			await sha256Hex('a@x.com'),
			await sha256Hex('b@y.com'),
		]);
		expect(res.body.data.admin_email_hash).toBe(await sha256Hex('b@y.com'));
	});

	it('密钥关闭时不下发哈希数组（避免离线枚举管理员邮箱）', async () => {
		await seedSettings({ admin_emails: '["a@x.com"]', notify_email: 'a@x.com' });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.admin_email_hashes).toEqual([]);
		expect(res.body.data.admin_email_hash).toBe('');
	});

	it('没有管理员时哈希数组为空、isBlogger 全为 false', async () => {
		await seedSettings({ admin_email: 'nope', admin_comment_key_enabled: 'true' });
		await seedComment({ post_slug: SLUG, email: ADMIN_EMAIL });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.admin_email_hashes).toEqual([]);
		expect(res.body.data.admin_email_hash).toBe('');
		expect(res.body.data.comments[0].isBlogger).toBe(false);
	});
});

describe('GET /api/comments —— 休眠链接 urlDormant（doc/link_security.md）', () => {
	const DORMANT_URL = 'https://sleepy.example.com';
	const SLEEPY = 'sleepy@example.com';

	it('功能关闭（默认）时恒为 false，字段始终存在（两种分支）', async () => {
		await seedComment({ post_slug: SLUG, email: SLEEPY, url: DORMANT_URL, pub_date: 1 });
		for (const query of [`?post_slug=${SLUG}`, `?post_slug=${SLUG}&nested=false`]) {
			const res = await getComments(query);
			expect(res.body.data.comments[0].urlDormant).toBe(false);
			expect('urlDormant' in res.body.data.comments[0]).toBe(true);
		}
	});

	it('开关是脏值时 fail-closed：不标记', async () => {
		await seedSettings({ link_security_enabled: 'yes' });
		await seedComment({ post_slug: SLUG, email: SLEEPY, url: DORMANT_URL, pub_date: 1 });
		const res = await getComments(`?post_slug=${SLUG}`);
		expect(res.body.data.comments[0].urlDormant).toBe(false);
	});

	it('刚好 N 天不算休眠（严格大于）', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: String(DEFAULT_LINK_DORMANT_DAYS) });
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			url: DORMANT_URL,
			pub_date: now - DEFAULT_LINK_DORMANT_DAYS * DAY_MS,
		});
		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(false);
	});

	it('N 天 + 1 毫秒就算休眠', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true' });
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			url: DORMANT_URL,
			pub_date: now - DEFAULT_LINK_DORMANT_DAYS * DAY_MS - 1,
		});
		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(true);
	});

	it('没有个人网址时不标记（即使很久没来）', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true' });
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			url: null,
			pub_date: now - 100 * DAY_MS,
		});
		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(false);
	});

	it('最后评论跨文章统计：在别的文章评论过就立刻解除休眠', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true' });
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			url: DORMANT_URL,
			pub_date: now - 100 * DAY_MS,
		});
		await seedComment({
			post_slug: '/posts/other',
			email: SLEEPY,
			pub_date: now - 1000,
		});
		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(false);
	});

	it('pending 也算「来过」，rejected / deleted 不算', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true' });
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			url: DORMANT_URL,
			pub_date: now - 100 * DAY_MS,
		});
		await seedComment({
			post_slug: '/posts/other',
			email: SLEEPY,
			status: 'pending',
			pub_date: now - 1000,
		});
		const pendingRes = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(pendingRes.body.data.comments[0].urlDormant).toBe(false);

		// 把那条 pending 改成 rejected：最后「有效」评论回到 100 天前 → 休眠
		await testEnv.MOMO_DB.prepare(
			"UPDATE Comment SET status = 'rejected' WHERE post_slug = '/posts/other'"
		).run();
		const rejectedRes = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(rejectedRes.body.data.comments[0].urlDormant).toBe(true);
	});

	it('最后评论时间无法解析时 fail-open：不标记', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true' });
		await seedComment({ post_slug: SLUG, email: SLEEPY, url: DORMANT_URL, pub_date: 'garbage' });
		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(false);
	});

	it('天数写入上限 3650：3651 天前评论 → 标记', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true', link_dormant_days: '3650' });
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			url: DORMANT_URL,
			pub_date: now - 3651 * DAY_MS,
		});
		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(true);
	});

	it('休眠判定只看「有网址」的邮箱，不会误伤其他评论', async () => {
		const now = Date.now();
		await seedSettings({ link_security_enabled: 'true' });
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			author: 'Sleepy',
			url: DORMANT_URL,
			pub_date: now - 100 * DAY_MS,
		});
		await seedComment({
			post_slug: SLUG,
			email: 'active@example.com',
			author: 'Active',
			url: 'https://active.example.com',
			pub_date: now - 1000,
		});
		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		const byAuthor = Object.fromEntries(res.body.data.comments.map((c: any) => [c.author, c.urlDormant]));
		expect(byAuthor).toEqual({ Sleepy: true, Active: false });
	});
});

/**
 * 人工确认（TrustedLink）对公开评论列表的豁免：有效确认时 `urlDormant = false`，
 * 到期（含恰好等于 now）后照常休眠，且只影响「归一化邮箱 + 逐字相等 url」那一条。
 */
describe('GET /api/comments —— 人工确认豁免休眠（TrustedLink）', () => {
	const DORMANT_URL = 'https://sleepy.example.com';
	const SLEEPY = 'sleepy@example.com';
	const OTHER = 'other@example.com';
	const OTHER_URL = 'https://other.example.com';

	const dormant = () =>
		seedSettings({ link_security_enabled: 'true', link_dormant_days: '30' });

	it('有效确认 → urlDormant false；同一页其他邮箱的链接不受影响', async () => {
		const now = Date.now();
		await dormant();
		await seedComment({
			post_slug: SLUG,
			email: SLEEPY,
			author: 'Sleepy',
			url: DORMANT_URL,
			pub_date: now - 100 * DAY_MS,
		});
		await seedComment({
			post_slug: SLUG,
			email: OTHER,
			author: 'Other',
			url: OTHER_URL,
			pub_date: now - 100 * DAY_MS,
		});
		await seedTrustedLink({
			email: SLEEPY,
			url: DORMANT_URL,
			expires_at: new Date(now + 10 * DAY_MS).toISOString(),
		});

		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		const byAuthor = Object.fromEntries(res.body.data.comments.map((c: any) => [c.author, c.urlDormant]));
		expect(byAuthor).toEqual({ Sleepy: false, Other: true });
	});

	it('过期与恰好到期（严格大于）都照常休眠', async () => {
		const now = Date.now();
		await dormant();
		await seedComment({ post_slug: SLUG, email: SLEEPY, url: DORMANT_URL, pub_date: now - 100 * DAY_MS });
		await seedTrustedLink({
			email: SLEEPY,
			url: DORMANT_URL,
			expires_at: new Date(now - 1).toISOString(),
		});

		let res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(true);

		// 恰好等于 now：仍然算过期
		await testEnv.MOMO_DB.prepare('UPDATE TrustedLink SET expires_at = ?')
			.bind(new Date(now).toISOString())
			.run();
		res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(true);
	});

	it('确认的是另一个网址时不豁免（url 逐字相等）', async () => {
		const now = Date.now();
		await dormant();
		await seedComment({ post_slug: SLUG, email: SLEEPY, url: DORMANT_URL, pub_date: now - 100 * DAY_MS });
		await seedTrustedLink({
			email: SLEEPY,
			url: OTHER_URL,
			expires_at: new Date(now + 10 * DAY_MS).toISOString(),
		});

		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(true);
	});

	it('邮箱按归一化匹配：评论邮箱大小写 / 空白不同也算同一条确认', async () => {
		const now = Date.now();
		await dormant();
		await seedComment({
			post_slug: SLUG,
			email: ' Sleepy@Example.COM ',
			url: DORMANT_URL,
			pub_date: now - 100 * DAY_MS,
		});
		await seedTrustedLink({
			email: 'sleepy@example.com',
			url: DORMANT_URL,
			expires_at: new Date(now + 10 * DAY_MS).toISOString(),
		});

		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(false);
	});

	it('功能关闭时不做任何豁免查询：urlDormant 恒为 false', async () => {
		const now = Date.now();
		await seedComment({ post_slug: SLUG, email: SLEEPY, url: DORMANT_URL, pub_date: now - 100 * DAY_MS });
		await seedTrustedLink({
			email: SLEEPY,
			url: DORMANT_URL,
			expires_at: new Date(now + 10 * DAY_MS).toISOString(),
		});

		const res = await withFrozenNow(now, () => getComments(`?post_slug=${SLUG}`));
		expect(res.body.data.comments[0].urlDormant).toBe(false);
	});
});
