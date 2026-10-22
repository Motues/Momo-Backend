/**
 * POST /api/comments —— 评论提交的完整链路（校验 → 限流 → 黑名单 → 人机验证 → 落库 → 通知）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, rawRequest } from '../helpers/http';
import {
	allLinkSyncRequests,
	createSchema,
	getComment,
	getVerification,
	lastCommentId,
	seedComment,
	seedLinkSyncRequest,
	seedSettings,
	seedVerification,
	testEnv,
} from '../helpers/db';
import { resetSentMails, sentMails } from '../stubs/nodemailer';
import { resetEmailEmojiCache } from '../../src/utils/emailEmoji';
import { createTicket, checkVerifyDomain } from '../../src/utils/verify';
import {
	MAX_AUTHOR,
	MAX_CONTENT,
	MAX_EMAIL,
	MAX_POST_SLUG,
	MAX_URL,
} from '../../src/utils/security';

const SLUG = '/posts/demo';
const CHROME_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function body(overrides: Record<string, unknown> = {}) {
	return {
		post_slug: SLUG,
		author: 'Alice',
		email: 'alice@example.com',
		content: 'hello',
		...overrides,
	};
}

async function postComment(overrides: Record<string, unknown> = {}, ip = '203.0.113.1', headers: Record<string, string> = {}) {
	return await api('/api/comments', { method: 'POST', body: body(overrides), ip, headers });
}

/** 三项齐全即视为 SMTP 可用（admin_email 只影响站长通知是否发出） */
const SMTP_ONLY = {
	smtp_host: 'smtp.example.com',
	smtp_port: '465',
	email_user: 'noreply@example.com',
	email_password: 'secret',
};
const SMTP = { ...SMTP_ONLY, admin_email: 'admin@example.com' };

/**
 * 本文件的网络替身：发信路径会按 `emoji_cdn_urls` 拉取 owo.json 做短代码水合
 * （doc/mail.md 第 4 节）。这里让所有出站请求立即失败 —— 水合按契约降级为纯文本，
 * 邮件照常「发出」；断言水合成功路径的用例见 `test/unit/email.test.ts`（那里同样
 * 在文件内部用 `vi.stubGlobal` 覆盖）。
 *
 * 刻意在**模块加载时**就装上并且不 `unstubAllGlobals()`：pending 的后台任务若落在
 * “已卸载替身、尚未装回”的窗口里，就会真的发起网络请求（测试期不该有真实网络）。
 */
const disabledFetch = async (): Promise<Response> => {
	throw new Error('network disabled in tests');
};
vi.stubGlobal('fetch', disabledFetch);

beforeEach(async () => {
	await createSchema();
	resetSentMails();
	resetEmailEmojiCache();
	vi.stubGlobal('fetch', disabledFetch);
});

afterEach(() => {
	// 不用 unstubAllGlobals：那会恢复真实的 fetch，让测试重新暴露在网络之下
	vi.stubGlobal('fetch', disabledFetch);
});

describe('POST /api/comments —— 成功路径', () => {
	it('返回 200 并把评论写入数据库', async () => {
		const res = await postComment();
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ code: 200, message: 'Comment submitted' });

		const row = await getComment((await lastCommentId()) as number);
		expect(row).not.toBeNull();
		expect(row?.post_slug).toBe(SLUG);
		expect(row?.author).toBe('Alice');
		expect(row?.email).toBe('alice@example.com');
		expect(row?.content_text).toBe('hello');
		expect(row?.content_html).toBe('<p>hello</p>\n');
	});

	it('pub_date 落库为毫秒整数（不是 ISO 字符串）', async () => {
		const before = Date.now();
		await postComment();
		const row = await getComment((await lastCommentId()) as number);
		expect(typeof row?.pub_date).toBe('number');
		expect(Number.isInteger(row?.pub_date as number)).toBe(true);
		expect(row?.pub_date as number).toBeGreaterThanOrEqual(before);
		expect(row?.pub_date as number).toBeLessThanOrEqual(Date.now());
	});

	it('默认自动通过（status = approved）', async () => {
		await postComment();
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('approved');
	});

	it('comment_auto_approve = "false" 时置为 pending', async () => {
		await seedSettings({ comment_auto_approve: 'false' });
		await postComment();
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('pending');
	});

	it('comment_auto_approve 为其它值时仍自动通过', async () => {
		await seedSettings({ comment_auto_approve: 'yes' });
		await postComment();
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('approved');
	});

	it('IP 取自 cf-connecting-ip 请求头', async () => {
		await postComment({}, '198.51.100.77');
		const row = await getComment((await lastCommentId()) as number);
		expect(row?.ip_address).toBe('198.51.100.77');
	});

	it('缺失 cf-connecting-ip 时回落到 127.0.0.1', async () => {
		await api('/api/comments', { method: 'POST', body: body() });
		expect((await getComment((await lastCommentId()) as number))?.ip_address).toBe('127.0.0.1');
	});

	it('从 User-Agent 解析 os / browser / device，并原样保存 UA', async () => {
		await postComment({}, '203.0.113.2', { 'user-agent': CHROME_UA });
		const row = await getComment((await lastCommentId()) as number);
		expect(row?.os).toBe('Windows 10');
		expect(row?.browser).toBe('Chrome 120.0.0.0');
		expect(row?.device).toBe('Desktop');
		expect(row?.user_agent).toBe(CHROME_UA);
	});

	it('无法识别的 User-Agent 回落为 Desktop 与空 os/browser', async () => {
		await postComment({}, '203.0.113.3', { 'user-agent': 'curl/8.4.0' });
		const row = await getComment((await lastCommentId()) as number);
		expect(row?.os).toBe('');
		expect(row?.browser).toBe('');
		expect(row?.device).toBe('Desktop');
	});

	it('没有 User-Agent 时同样回落为 Desktop', async () => {
		await api('/api/comments', {
			method: 'POST',
			body: body(),
			ip: '203.0.113.4',
			headers: { 'user-agent': '' },
		});
		const row = await getComment((await lastCommentId()) as number);
		expect(row?.device).toBe('Desktop');
	});

	it('content_html 由 markdown 渲染（粗体 / 链接 / 换行）', async () => {
		await postComment({ content: '**bold** [x](https://a.com)\nsecond' });
		const row = await getComment((await lastCommentId()) as number);
		expect(row?.content_html).toContain('<strong>bold</strong>');
		expect(row?.content_html).toContain('href="https://a.com"');
		expect(row?.content_html).toContain('<br>');
	});

	it('content_text 被净化：script 块被移除', async () => {
		await postComment({ content: 'safe<script>alert(1)</script>' });
		const row = await getComment((await lastCommentId()) as number);
		expect(row?.content_text).toBe('safe');
		expect(row?.content_html).not.toContain('<script>');
	});

	it('author 同样被净化', async () => {
		await postComment({ author: 'A<script>x</script>B' });
		expect((await getComment((await lastCommentId()) as number))?.author).toBe('AB');
	});

	it('url 走协议白名单：允许 https，拒绝 javascript:', async () => {
		await postComment({ url: 'https://me.example.com' }, '203.0.113.5');
		expect((await getComment((await lastCommentId()) as number))?.url).toBe('https://me.example.com');

		await postComment({ url: 'javascript:alert(1)' }, '203.0.113.6');
		expect((await getComment((await lastCommentId()) as number))?.url).toBe('');
	});

	it('url 缺失时落库为空串', async () => {
		await postComment();
		expect((await getComment((await lastCommentId()) as number))?.url).toBe('');
	});

	it('parent_id 会写入（回复评论）', async () => {
		const parentId = await seedComment({ id: undefined, post_slug: SLUG, email: 'parent@example.com' });
		await postComment({ parent_id: parentId });
		expect((await getComment((await lastCommentId()) as number))?.parent_id).toBe(parentId);
	});

	it('未提供 parent_id 时落库为 NULL', async () => {
		await postComment({ parent_id: 0 });
		expect((await getComment((await lastCommentId()) as number))?.parent_id).toBeNull();
	});

	it('非数字 parent_id 会因外键约束失败而返回 500（handler 未校验 parent_id 类型）', async () => {
		// 记录既有行为：data.parent_id || null 原样传入 SQL，'abc' 不匹配任何 Comment.id，
		// D1 外键约束报错后被 catch 成 500 Internal Server Error（而不是 400）。
		const res = await postComment({ parent_id: 'abc' });
		expect(res.status).toBe(500);
		expect(res.body).toEqual({ code: 500, message: 'Internal Server Error' });
	});

	it('不存在的 parent_id 同样因外键约束失败返回 500', async () => {
		const res = await postComment({ parent_id: 999999 });
		expect(res.status).toBe(500);
	});
});

describe('POST /api/comments —— 必填字段校验', () => {
	it.each(['post_slug', 'author', 'email', 'content'])('缺少 %s 返回 400', async (field) => {
		const payload = body();
		delete (payload as Record<string, unknown>)[field];
		const res = await api('/api/comments', { method: 'POST', body: payload, ip: '203.0.113.10' });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe(400);
		expect(res.body.message).toContain('required');
	});

	it.each(['post_slug', 'author', 'email', 'content'])('字段 %s 只有空白时返回 400', async (field) => {
		const res = await postComment({ [field]: '   ' }, '203.0.113.11');
		expect(res.status).toBe(400);
	});

	it.each([
		['post_slug', 123],
		['post_slug', null],
		['author', ['a']],
		['email', { a: 1 }],
		['content', true],
	])('字段 %s 类型错误（%s）返回 400', async (field, value) => {
		const res = await postComment({ [field]: value }, '203.0.113.12');
		expect(res.status).toBe(400);
		expect(res.body.code).toBe(400);
	});

	it('空请求体导致 500（c.req.json() 无 catch，属于既有行为）', async () => {
		const res = await api('/api/comments', { method: 'POST', ip: '203.0.113.13' });
		expect(res.status).toBe(500);
	});

	it('非法 JSON 请求体导致 500（既有行为）', async () => {
		const res = await api('/api/comments', {
			method: 'POST',
			body: '{not json',
			ip: '203.0.113.14',
			headers: { 'content-type': 'application/json' },
		});
		expect(res.status).toBe(500);
	});
});

describe('POST /api/comments —— 字段长度上限', () => {
	it('超出上限返回 400 并在消息中列出限制', async () => {
		const res = await postComment({ content: 'x'.repeat(MAX_CONTENT + 1) }, '203.0.113.20');
		expect(res.status).toBe(400);
		expect(res.body.message).toContain(String(MAX_CONTENT));
	});

	it.each([
		['author', MAX_AUTHOR],
		['email', MAX_EMAIL],
		['post_slug', MAX_POST_SLUG],
		['url', MAX_URL],
	])('字段 %s 超出上限返回 400', async (field, limit) => {
		const value =
			field === 'email'
				? `${'a'.repeat(limit)}@b.c`
				: field === 'url'
					? `https://a.com/${'x'.repeat(limit)}`
					: 'x'.repeat(limit + 1);
		const res = await postComment({ [field]: value }, '203.0.113.21');
		expect(res.status).toBe(400);
	});

	it.each([
		['content', MAX_CONTENT],
		['author', MAX_AUTHOR],
		['post_slug', MAX_POST_SLUG],
	])('字段 %s 恰好等于上限时通过', async (field, limit) => {
		const res = await postComment({ [field]: 'x'.repeat(limit) }, '203.0.113.22');
		expect(res.status).toBe(200);
	});

	it('url 恰好等于上限时通过', async () => {
		const url = `https://a.com/${'x'.repeat(MAX_URL - 'https://a.com/'.length)}`;
		expect(url.length).toBe(MAX_URL);
		const res = await postComment({ url }, '203.0.113.23');
		expect(res.status).toBe(200);
	});

	it('email 恰好等于上限时通过', async () => {
		const email = `${'a'.repeat(MAX_EMAIL - 4)}@b.c`;
		expect(email.length).toBe(MAX_EMAIL);
		const res = await postComment({ email }, '203.0.113.24');
		expect(res.status).toBe(200);
	});
});

describe('POST /api/comments —— 同 IP 频率限制', () => {
	it('同一 IP 在 60 秒内的第二条评论返回 429', async () => {
		expect((await postComment({}, '198.51.100.1')).status).toBe(200);
		const second = await postComment({}, '198.51.100.1');
		expect(second.status).toBe(429);
		expect(second.body.code).toBe(429);
	});

	it('不同 IP 互不影响', async () => {
		expect((await postComment({}, '198.51.100.2')).status).toBe(200);
		expect((await postComment({}, '198.51.100.3')).status).toBe(200);
	});

	it('上一条评论已超过 60 秒时允许再次提交', async () => {
		await seedComment({
			ip_address: '198.51.100.4',
			pub_date: Date.now() - 61 * 1000,
			email: 'old@example.com',
		});
		expect((await postComment({}, '198.51.100.4')).status).toBe(200);
	});

	it('上一条评论恰好 60 秒内（59 秒）时被限流', async () => {
		await seedComment({ ip_address: '198.51.100.5', pub_date: Date.now() - 59 * 1000 });
		expect((await postComment({}, '198.51.100.5')).status).toBe(429);
	});

	it('历史 ISO 字符串 pub_date 同样被识别（toMillis 兼容）', async () => {
		await seedComment({
			ip_address: '198.51.100.6',
			pub_date: new Date(Date.now() - 10 * 1000).toISOString(),
		});
		expect((await postComment({}, '198.51.100.6')).status).toBe(429);
	});

	it('限流检查只按 IP 匹配，不区分文章', async () => {
		expect((await postComment({ post_slug: '/posts/a' }, '198.51.100.7')).status).toBe(200);
		expect((await postComment({ post_slug: '/posts/b' }, '198.51.100.7')).status).toBe(429);
	});

	it('管理员邮箱不限流：60 秒内可连续提交', async () => {
		await seedSettings({ admin_email: 'admin@example.com' });
		const ip = '198.51.100.8';

		expect((await postComment({ email: 'admin@example.com' }, ip)).status).toBe(200);
		expect((await postComment({ email: 'admin@example.com' }, ip)).status).toBe(200);
	});

	it('普通邮箱仍受限流约束（未配置 admin_email 时也不能免限流）', async () => {
		const ip = '198.51.100.9';

		expect((await postComment({ email: 'admin@example.com' }, ip)).status).toBe(200);
		expect((await postComment({ email: 'admin@example.com' }, ip)).status).toBe(429);
	});

	it('admin_emails 列表里的成员同样免 60 秒冷却（大小写/空格归一后命中）', async () => {
		await seedSettings({ admin_emails: '["a@x.com","b@y.com"]' });
		const ip = '198.51.100.10';

		expect((await postComment({ email: '  A@X.com  ' }, ip)).status).toBe(200);
		expect((await postComment({ email: 'b@y.com' }, ip)).status).toBe(200);
	});

	it('不在 admin_emails 列表里的邮箱仍受限流约束', async () => {
		await seedSettings({ admin_emails: '["a@x.com"]' });
		const ip = '198.51.100.11';

		expect((await postComment({ email: 'other@example.com' }, ip)).status).toBe(200);
		expect((await postComment({ email: 'other@example.com' }, ip)).status).toBe(429);
	});
});

describe('POST /api/comments —— IP 黑名单', () => {
	it('精确命中黑名单返回 403', async () => {
		await seedSettings({ ip_blacklist: JSON.stringify(['203.0.113.30']) });
		const res = await postComment({}, '203.0.113.30');
		expect(res.status).toBe(403);
		expect(res.body.message).toBe('Your IP has been blocked');
	});

	it('CIDR 命中黑名单返回 403', async () => {
		await seedSettings({ ip_blacklist: JSON.stringify(['203.0.113.0/24']) });
		expect((await postComment({}, '203.0.113.99')).status).toBe(403);
	});

	it('IPv4-mapped IPv6 与 IPv4 条目互相命中', async () => {
		await seedSettings({ ip_blacklist: JSON.stringify(['203.0.113.31']) });
		expect((await postComment({}, '::ffff:203.0.113.31')).status).toBe(403);
	});

	it('不在黑名单中的 IP 正常提交', async () => {
		await seedSettings({ ip_blacklist: JSON.stringify(['10.0.0.0/8']) });
		expect((await postComment({}, '203.0.113.32')).status).toBe(200);
	});

	it('黑名单为非法 JSON 时 fail-open（不阻断评论）', async () => {
		await seedSettings({ ip_blacklist: 'not-json' });
		expect((await postComment({}, '203.0.113.33')).status).toBe(200);
	});

	it('黑名单不是数组时 fail-open', async () => {
		await seedSettings({ ip_blacklist: '{"a":1}' });
		expect((await postComment({}, '203.0.113.34')).status).toBe(200);
	});

	it('黑名单为空字符串时视为未配置', async () => {
		await seedSettings({ ip_blacklist: '' });
		expect((await postComment({}, '203.0.113.35')).status).toBe(200);
	});
});

describe('POST /api/comments —— 邮箱黑名单', () => {
	it('命中邮箱黑名单返回 403', async () => {
		await seedSettings({ email_blacklist: JSON.stringify(['spam@example.com']) });
		const res = await postComment({ email: 'spam@example.com' }, '203.0.113.40');
		expect(res.status).toBe(403);
		expect(res.body.message).toBe('Your email has been blocked');
	});

	it('邮箱匹配不区分大小写', async () => {
		await seedSettings({ email_blacklist: JSON.stringify(['spam@example.com']) });
		expect((await postComment({ email: 'SPAM@Example.COM' }, '203.0.113.41')).status).toBe(403);
	});

	it('非黑名单邮箱正常提交', async () => {
		await seedSettings({ email_blacklist: JSON.stringify(['spam@example.com']) });
		expect((await postComment({ email: 'ok@example.com' }, '203.0.113.42')).status).toBe(200);
	});

	it('邮箱黑名单为非法 JSON 时 fail-open', async () => {
		await seedSettings({ email_blacklist: 'not-json' });
		expect((await postComment({}, '203.0.113.43')).status).toBe(200);
	});

	it('邮箱黑名单不是数组时 fail-open', async () => {
		await seedSettings({ email_blacklist: '"spam@example.com"' });
		expect((await postComment({}, '203.0.113.44')).status).toBe(200);
	});

	it('空字符串条目不会误伤', async () => {
		await seedSettings({ email_blacklist: '[""]' });
		expect((await postComment({ email: 'ok@example.com' }, '203.0.113.45')).status).toBe(200);
	});
});

describe('POST /api/comments —— 博主密钥', () => {
	const ADMIN_EMAIL = 'admin@example.com';

	it('邮箱匹配且密钥正确时直接通过审核（即使关闭自动通过）', async () => {
		await seedSettings({
			admin_email: ADMIN_EMAIL,
			admin_comment_key: 'super-key',
			admin_comment_key_enabled: 'true',
			comment_auto_approve: 'false',
		});
		const res = await postComment({ email: ADMIN_EMAIL, admin_key: 'super-key' }, '203.0.113.50');
		expect(res.status).toBe(200);
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('approved');
	});

	it('邮箱匹配但密钥错误时返回 403', async () => {
		await seedSettings({
			admin_email: ADMIN_EMAIL,
			admin_comment_key: 'super-key',
			admin_comment_key_enabled: 'true',
		});
		const res = await postComment({ email: ADMIN_EMAIL, admin_key: 'wrong' }, '203.0.113.51');
		expect(res.status).toBe(403);
		expect(res.body.message).toBe('Invalid admin key');
	});

	it('邮箱不匹配时密钥不生效，也不会因密钥错误被拒', async () => {
		await seedSettings({
			admin_email: ADMIN_EMAIL,
			admin_comment_key: 'super-key',
			admin_comment_key_enabled: 'true',
		});
		const res = await postComment({ email: 'other@example.com', admin_key: 'wrong' }, '203.0.113.52');
		expect(res.status).toBe(200);
	});

	it('密钥功能未开启时即使密钥错误也走正常流程', async () => {
		await seedSettings({ admin_email: ADMIN_EMAIL, admin_comment_key: 'super-key' });
		const res = await postComment({ email: ADMIN_EMAIL, admin_key: 'wrong' }, '203.0.113.53');
		expect(res.status).toBe(200);
	});

	it('已配置密钥但请求未带 admin_key 时返回 403', async () => {
		await seedSettings({
			admin_email: ADMIN_EMAIL,
			admin_comment_key: 'super-key',
			admin_comment_key_enabled: 'true',
		});
		expect((await postComment({ email: ADMIN_EMAIL }, '203.0.113.54')).status).toBe(403);
	});

	it('admin_emails 列表里的任一成员都能用密钥直接通过审核（旧键不再必需）', async () => {
		await seedSettings({
			admin_emails: '["a@x.com","b@y.com"]',
			admin_comment_key: 'super-key',
			admin_comment_key_enabled: 'true',
			comment_auto_approve: 'false',
		});
		const res = await postComment({ email: '  B@Y.com ', admin_key: 'super-key' }, '203.0.113.55');
		expect(res.status).toBe(200);
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('approved');
	});

	it('列表外的邮箱即使带正确密钥也不会被当成博主（密钥不生效）', async () => {
		await seedSettings({
			admin_emails: '["a@x.com"]',
			admin_comment_key: 'super-key',
			admin_comment_key_enabled: 'true',
			comment_auto_approve: 'false',
		});
		const res = await postComment({ email: 'other@example.com', admin_key: 'super-key' }, '203.0.113.56');
		expect(res.status).toBe(200);
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('pending');
	});
});

describe('POST /api/comments —— 无感验证票据', () => {
	const IP = '203.0.113.60';

	it('开启验证但未带票据时返回 403 且 reason = VERIFY_REQUIRED', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		const res = await postComment({}, IP);
		expect(res.status).toBe(403);
		expect(res.body).toEqual({
			code: 403,
			message: 'Human verification failed or expired',
			reason: 'VERIFY_REQUIRED',
		});
	});

	it('开启验证且携带有效票据时通过', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		const ticket = await createTicket(testEnv, IP, SLUG);
		expect((await postComment({ verify_ticket: ticket }, IP)).status).toBe(200);
	});

	it('票据与文章不匹配时被拒', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		const ticket = await createTicket(testEnv, IP, '/posts/other');
		expect((await postComment({ verify_ticket: ticket }, IP)).status).toBe(403);
	});

	it('票据与 IP 不匹配时被拒', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		const ticket = await createTicket(testEnv, '10.0.0.1', SLUG);
		expect((await postComment({ verify_ticket: ticket }, IP)).status).toBe(403);
	});

	it('票据被篡改时被拒', async () => {
		await seedSettings({ comment_verify_enabled: 'true' });
		const ticket = await createTicket(testEnv, IP, SLUG);
		expect((await postComment({ verify_ticket: `${ticket}x` }, IP)).status).toBe(403);
	});

	it('验证关闭时无需票据', async () => {
		expect((await postComment({}, IP)).status).toBe(200);
	});

	it('博主密钥已通过时不要求票据', async () => {
		await seedSettings({
			comment_verify_enabled: 'true',
			admin_email: 'admin@example.com',
			admin_comment_key: 'k',
			admin_comment_key_enabled: 'true',
		});
		const res = await postComment({ email: 'admin@example.com', admin_key: 'k' }, IP);
		expect(res.status).toBe(200);
	});
});

describe('POST /api/comments —— 邮件通知', () => {
	it('配置了 SMTP 时向站长发送新评论通知', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		expect((await postComment({}, '203.0.113.70')).status).toBe(200);

		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('admin@example.com');
		expect(sentMails[0].subject).toContain('Momo Blog');
		expect(sentMails[0].html).toContain('hello');
	});

	it('未配置 admin_email 时不发送通知邮件', async () => {
		await seedSettings(SMTP);
		await testEnv.MOMO_DB.prepare("DELETE FROM Settings WHERE key = 'admin_email'").run();
		expect((await postComment({}, '203.0.113.71')).status).toBe(200);
		expect(sentMails).toHaveLength(0);
	});

	it('email_enabled = "false" 时不发送通知邮件', async () => {
		await seedSettings({ ...SMTP, email_enabled: 'false' });
		expect((await postComment({}, '203.0.113.72')).status).toBe(200);
		expect(sentMails).toHaveLength(0);
	});

	it('回复评论时给父评论作者发送回复通知（正文用父评论渲染后的 HTML）', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		const parentId = await seedComment({
			email: 'parent@example.com',
			author: 'Parent',
			content_text: 'parent says hi',
			content_html: '<p>parent says hi</p>',
		});
		expect((await postComment({ parent_id: parentId, email: 'child@example.com' }, '203.0.113.73')).status).toBe(200);

		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('parent@example.com');
		expect(sentMails[0].subject).toContain('回复');
		// {{parentCommentHtml}} 原样插入（不转义）
		expect(sentMails[0].html).toContain('<p>parent says hi</p>');
	});

	it('回复自己的评论时不发回复通知', async () => {
		await seedSettings(SMTP);
		const parentId = await seedComment({ email: 'same@example.com', content_text: 'mine' });
		await postComment({ parent_id: parentId, email: 'same@example.com' }, '203.0.113.74');
		expect(sentMails).toHaveLength(0);
	});

	it('使用自定义通知模板并转义变量', async () => {
		await seedSettings({
			...SMTP,
			notification_template: '<p>{{postTitle}}|{{commentAuthor}}|{{commentContent}}</p>',
		});
		await postComment({ post_title: '<b>T</b>', author: 'A&B' }, '203.0.113.75');
		expect(sentMails[0].html).toBe('<p>&lt;b&gt;T&lt;/b&gt;|A&amp;B|hello</p>');
	});

	it('通知收件人是解析后的 notify_email（不是列表第一个）', async () => {
		await seedSettings({
			...SMTP_ONLY,
			admin_emails: '["a@x.com","b@y.com"]',
			notify_email: 'b@y.com',
			site_name: 'Momo Blog',
		});
		await postComment({}, '203.0.113.76');
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('b@y.com');
	});

	it('通知邮件正文用渲染后的 HTML（*Html 占位符原样插入）', async () => {
		await seedSettings({
			...SMTP,
			notification_template: '<div>{{commentContent}}|{{commentContentHtml}}</div>',
		});
		await postComment({ content: '**hi**' }, '203.0.113.77');
		// content_html 由 marked 渲染；emoji 水合在测试环境断网，按契约降级为纯文本
		expect(sentMails[0].html).toBe('<div>**hi**|<p><strong>hi</strong></p>\n</div>');
	});
});

describe('POST /api/comments —— 邮箱验证流程', () => {
	it('开启邮箱验证且 SMTP 齐全时置 pending 并发验证邮件', async () => {
		await seedSettings({ ...SMTP_ONLY, email_verify_enabled: 'true', site_name: 'Momo Blog' });
		const res = await api('/api/comments', {
			method: 'POST',
			ip: '203.0.113.80',
			headers: { origin: 'https://blog.example.com' },
			body: body({ email: 'newbie@example.com' }),
		});

		expect(res.status).toBe(200);
		expect(res.body.message).toContain('Verification email sent');

		const row = await getComment((await lastCommentId()) as number);
		expect(row?.status).toBe('pending');

		// 验证令牌落库
		const tokenRow = await testEnv.MOMO_DB.prepare(
			'SELECT * FROM EmailVerification WHERE email = ?'
		)
			.bind('newbie@example.com')
			.first<{ token: string; post_slug: string; verified: number }>();
		expect(tokenRow).not.toBeNull();
		expect(tokenRow?.verified).toBe(0);
		expect(tokenRow?.post_slug).toBe(SLUG);

		// 只发出验证邮件（admin_email 未配置 → 站长通知被跳过）
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('newbie@example.com');
		expect(sentMails[0].subject).toContain('验证');
		expect(sentMails[0].html).toContain(tokenRow?.token as string);
		expect(sentMails[0].html).toContain('https://blog.example.com/api/verify-email/verify');
	});

	it('verification_base_url 优先于请求头推断', async () => {
		await seedSettings({
			...SMTP_ONLY,
			email_verify_enabled: 'true',
			verify_base_url: 'https://custom.example.com/',
		});
		await api('/api/comments', {
			method: 'POST',
			ip: '203.0.113.81',
			headers: { origin: 'https://ignored.example.com' },
			body: body(),
		});
		expect(sentMails[0].html).toContain('https://custom.example.com/api/verify-email/verify');
	});

	it('已存在未过期令牌时不重复发送验证邮件', async () => {
		await seedSettings({ ...SMTP_ONLY, email_verify_enabled: 'true' });
		const { seedVerification } = await import('../helpers/db');
		await seedVerification({
			email: 'alice@example.com',
			token: 'existing-token',
			expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
		});

		const res = await postComment({}, '203.0.113.82');
		expect(res.status).toBe(200);
		expect(res.body.message).toContain('Verification email sent');
		expect(sentMails).toHaveLength(0);
		expect((await getVerification('existing-token'))?.verified).toBe(0);
	});

	it('邮箱已验证时不再置 pending，也不发验证邮件', async () => {
		await seedSettings({ ...SMTP_ONLY, email_verify_enabled: 'true' });
		const { seedVerification } = await import('../helpers/db');
		await seedVerification({ email: 'alice@example.com', verified: 1 });

		const res = await postComment({}, '203.0.113.83');
		expect(res.status).toBe(200);
		expect(res.body.message).toBe('Comment submitted');
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('approved');
		expect(sentMails).toHaveLength(0);
	});

	it('SMTP 配置不齐全时不置 pending（避免卡在待审核却发不出邮件）', async () => {
		await seedSettings({
			email_verify_enabled: 'true',
			smtp_host: 'smtp.example.com',
			admin_email: 'admin@example.com',
		});
		const res = await postComment({}, '203.0.113.84');
		expect(res.status).toBe(200);
		expect(res.body.message).toBe('Comment submitted');
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('approved');
		expect(sentMails).toHaveLength(0);
	});

	it('未开启邮箱验证时不置 pending', async () => {
		await seedSettings(SMTP);
		await postComment({}, '203.0.113.85');
		expect((await getComment((await lastCommentId()) as number))?.status).toBe('approved');
	});
});

/**
 * 审核自动化：与「评论自动通过」合并为一个开关 ——
 * 开启时命中垃圾规则转待审核、未命中直接通过；关闭时全部待审核。
 */
describe('POST /api/comments —— 审核自动化（垃圾规则）', () => {
	/** 9 个码点，便于隔离「太短」规则（该规则默认关闭） */
	const NORMAL = '这是一条正常的评论';

	const statusOfLatest = async () => (await getComment((await lastCommentId()) as number))?.status;

	it('默认不启用任何规则：短评论与多链接都直接通过', async () => {
		await postComment({ content: NORMAL }, '203.0.113.101');
		expect(await statusOfLatest()).toBe('approved');

		await postComment({ content: '好文' }, '203.0.113.118');
		expect(await statusOfLatest()).toBe('approved');

		await postComment(
			{ content: '看这里 https://a.com https://b.com https://c.com https://d.com' },
			'203.0.113.119'
		);
		expect(await statusOfLatest()).toBe('approved');
	});

	it('开启最短长度规则后，正文短于阈值进入待审核', async () => {
		await seedSettings({ comment_spam_min_length: '5' });
		await postComment({ content: '好文' }, '203.0.113.102');
		expect(await statusOfLatest()).toBe('pending');
	});

	it('命中敏感关键词进入待审核', async () => {
		await seedSettings({ comment_spam_keywords: '["加微信"]' });
		await postComment({ content: '快来加微信看更多' }, '203.0.113.103');
		expect(await statusOfLatest()).toBe('pending');
	});

	it('昵称命中关键词同样进入待审核', async () => {
		await seedSettings({ comment_spam_keywords: '["casino"]' });
		await postComment({ author: 'Casino 代理', content: NORMAL }, '203.0.113.104');
		expect(await statusOfLatest()).toBe('pending');
	});

	it('个人网址字段命中关键词进入待审核', async () => {
		await seedSettings({ comment_spam_keywords: '["casino"]' });
		await postComment({ content: NORMAL, url: 'https://casino.example.com' }, '203.0.113.105');
		expect(await statusOfLatest()).toBe('pending');
	});

	it('未命中关键词时正常通过', async () => {
		await seedSettings({ comment_spam_keywords: '["加微信","casino"]' });
		await postComment({ content: NORMAL }, '203.0.113.106');
		expect(await statusOfLatest()).toBe('approved');
	});

	it('关键词配置损坏时放行（fail-open）', async () => {
		await seedSettings({ comment_spam_keywords: '{oops' });
		await postComment({ content: NORMAL }, '203.0.113.107');
		expect(await statusOfLatest()).toBe('approved');
	});

	it('链接数超过阈值进入待审核', async () => {
		await seedSettings({ comment_spam_max_links: '3' });
		await postComment(
			{ content: '看这里 https://a.com https://b.com https://c.com https://d.com' },
			'203.0.113.108'
		);
		expect(await statusOfLatest()).toBe('pending');
	});

	it('链接数等于阈值时放行', async () => {
		await seedSettings({ comment_spam_max_links: '3' });
		await postComment({ content: '看这里 https://a.com https://b.com https://c.com' }, '203.0.113.109');
		expect(await statusOfLatest()).toBe('approved');
	});

	it('个人网址字段计入链接数', async () => {
		await seedSettings({ comment_spam_max_links: '3' });
		await postComment(
			{ content: '看这里 https://a.com https://b.com https://c.com', url: 'https://me.example.com' },
			'203.0.113.110'
		);
		expect(await statusOfLatest()).toBe('pending');
	});

	it('阈值为 0 时该条规则不生效', async () => {
		await seedSettings({ comment_spam_max_links: '0', comment_spam_min_length: '0' });
		await postComment(
			{ content: '看这里 https://a.com https://b.com https://c.com https://d.com https://e.com' },
			'203.0.113.111'
		);
		expect(await statusOfLatest()).toBe('approved');
	});

	it('同一 IP 在时间窗内提交相同正文进入待审核', async () => {
		await seedSettings({ comment_spam_duplicate_window: '10' });
		const ip = '203.0.113.112';
		await seedComment({
			post_slug: SLUG,
			content_text: NORMAL,
			ip_address: ip,
			status: 'approved',
			// 60 秒冷却之外、10 分钟窗口之内的历史评论
			pub_date: Date.now() - 120_000,
		});

		await postComment({ content: NORMAL }, ip);
		expect(await statusOfLatest()).toBe('pending');
	});

	it('时间窗外的相同正文不算重复', async () => {
		await seedSettings({ comment_spam_duplicate_window: '10' });
		const ip = '203.0.113.113';
		await seedComment({
			post_slug: SLUG,
			content_text: NORMAL,
			ip_address: ip,
			status: 'approved',
			pub_date: Date.now() - 11 * 60_000,
		});

		await postComment({ content: NORMAL }, ip);
		expect(await statusOfLatest()).toBe('approved');
	});

	it('其他 IP 的相同正文不算重复', async () => {
		await seedSettings({ comment_spam_duplicate_window: '10' });
		await seedComment({
			post_slug: SLUG,
			content_text: NORMAL,
			ip_address: '203.0.113.200',
			status: 'approved',
			pub_date: Date.now() - 120_000,
		});

		await postComment({ content: NORMAL }, '203.0.113.114');
		expect(await statusOfLatest()).toBe('approved');
	});

	it('重复窗口为 0（默认）时关闭重复检测', async () => {
		await seedSettings({ comment_spam_duplicate_window: '0' });
		const ip = '203.0.113.115';
		await seedComment({
			post_slug: SLUG,
			content_text: NORMAL,
			ip_address: ip,
			status: 'approved',
			pub_date: Date.now() - 120_000,
		});

		await postComment({ content: NORMAL }, ip);
		expect(await statusOfLatest()).toBe('approved');
	});

	it('关闭自动通过时规则不参与判定（全部待审核）', async () => {
		await seedSettings({ comment_auto_approve: 'false' });
		await postComment({ content: NORMAL }, '203.0.113.116');
		expect(await statusOfLatest()).toBe('pending');
	});

	it('管理员密钥验证后的博主评论不受规则影响', async () => {
		await seedSettings({
			admin_email: 'alice@example.com',
			admin_comment_key: 'secret-key',
			admin_comment_key_enabled: 'true',
			comment_spam_keywords: '["加微信"]',
		});

		// 正文同时命中关键词且被长度规则命中，博主仍应直接通过
		const res = await postComment({ content: '加微信', admin_key: 'secret-key' }, '203.0.113.117');
		expect(res.status).toBe(200);
		expect(await statusOfLatest()).toBe('approved');
	});
});

/**
 * 服务端来源校验：allow_origin 配置成白名单后，写接口必须自己拦下白名单外的提交。
 *
 * 这里刻意带上 SMTP 配置：CORS 时代对方站点即使被浏览器拦下响应，请求照样会落库并发信，
 * 所以「被拒的请求不得落库、不得发信」是这道闸门的核心断言。
 */
describe('POST /api/comments —— 服务端来源校验', () => {
	it('Origin 在白名单内时正常提交', async () => {
		await seedSettings({ ...SMTP, allow_origin: 'https://blog.example.com' });

		const res = await postComment({ post_url: 'https://blog.example.com/posts/demo' }, '203.0.113.130', {
			Origin: 'https://blog.example.com',
		});

		expect(res.status).toBe(200);
		expect(await lastCommentId()).not.toBeNull();
	});

	it('Origin 不在白名单内时返回 403，且不落库、不发信', async () => {
		await seedSettings({ ...SMTP, allow_origin: 'https://blog.example.com' });

		const res = await postComment({ post_url: 'https://luoxuedev.top/blog/aosp' }, '203.0.113.131', {
			Origin: 'https://luoxuedev.top',
			Referer: 'https://luoxuedev.top/blog/aosp',
		});

		expect(res.status).toBe(403);
		expect(res.body.code).toBe(403);
		expect(res.body.reason).toBe('ORIGIN_NOT_ALLOWED');
		expect(await lastCommentId()).toBeNull();
		expect(sentMails).toHaveLength(0);
	});

	it('服务端转发（无 Origin/Referer，post_url 指向白名单站点）仍然放行', async () => {
		await seedSettings({ ...SMTP, allow_origin: 'https://blog.example.com' });

		const res = await postComment({ post_url: 'https://blog.example.com/posts/demo' }, '203.0.113.132');

		expect(res.status).toBe(200);
		expect(sentMails).toHaveLength(1);
	});

	it('服务端转发但 post_url 指向未授权站点时拒绝（本次事件形态）', async () => {
		await seedSettings({ ...SMTP, allow_origin: 'https://blog.example.com' });

		const res = await postComment({ post_url: 'https://luoxuedev.top/blog/aosp' }, '203.0.113.133');

		expect(res.status).toBe(403);
		expect(await lastCommentId()).toBeNull();
		expect(sentMails).toHaveLength(0);
	});

	it('三个来源都没有时拒绝', async () => {
		await seedSettings({ ...SMTP, allow_origin: 'https://blog.example.com' });

		const res = await postComment({}, '203.0.113.134');

		expect(res.status).toBe(403);
		expect(await lastCommentId()).toBeNull();
	});

	it('Origin 命中但 post_url 指向别处时拒绝', async () => {
		await seedSettings({ ...SMTP, allow_origin: 'https://blog.example.com' });

		const res = await postComment({ post_url: 'https://evil.example/x' }, '203.0.113.135', {
			Origin: 'https://blog.example.com',
		});

		expect(res.status).toBe(403);
		expect(await lastCommentId()).toBeNull();
	});

	it('被拒的请求不会触发邮箱验证邮件', async () => {
		await seedSettings({
			...SMTP_ONLY,
			allow_origin: 'https://blog.example.com',
			email_verify_enabled: 'true',
		});

		const res = await postComment({ post_url: 'https://luoxuedev.top/blog/aosp' }, '203.0.113.136');

		expect(res.status).toBe(403);
		expect(sentMails).toHaveLength(0);
	});

	it('allow_origin 未配置时不启用服务端校验（行为与旧版本一致）', async () => {
		await seedSettings({ ...SMTP });

		const res = await postComment({}, '203.0.113.137', { Origin: 'https://anywhere.example' });

		expect(res.status).toBe(200);
		expect(await lastCommentId()).not.toBeNull();
	});

	it('allow_origin 为 * 时不启用服务端校验', async () => {
		await seedSettings({ ...SMTP, allow_origin: '*' });

		const res = await postComment({}, '203.0.113.138', { Origin: 'https://anywhere.example' });

		expect(res.status).toBe(200);
	});

	it('不带 scheme 的白名单条目按主机名匹配', async () => {
		await seedSettings({ ...SMTP, allow_origin: 'blog.example.com' });

		const res = await postComment({}, '203.0.113.139', { Origin: 'https://blog.example.com' });

		expect(res.status).toBe(200);
	});

	it('来源校验早于限流与人机验证', async () => {
		await seedSettings({
			...SMTP,
			allow_origin: 'https://blog.example.com',
			comment_verify_enabled: 'true',
		});

		const ip = '203.0.113.140';
		// 造一条刚写入的评论，让该 IP 处于 60 秒冷却内
		await seedComment({ ip_address: ip, pub_date: Date.now() });

		// 白名单外来源：应当先被判 403 ORIGIN_NOT_ALLOWED，而不是 429 或 VERIFY_REQUIRED
		const denied = await postComment({}, ip, { Origin: 'https://evil.example' });
		expect(denied.status).toBe(403);
		expect(denied.body.reason).toBe('ORIGIN_NOT_ALLOWED');

		// 白名单内来源：此时才会走到限流，应命中 60 秒冷却
		const throttled = await postComment({}, ip, { Origin: 'https://blog.example.com' });
		expect(throttled.status).toBe(429);
	});
});

/**
 * 来源域名绑定（comment_verify_domain_enabled）：挑战 → 票据 → 评论提交 是同一条域名链。
 *
 * 与上面的普通来源校验的区别：
 *  - `allow_origin` 未配置或为 `*` 时 **不跳过**，而是 fail-closed；
 *  - 票据里的 org 必须与本次请求的来源一致，否则即使票据本身有效也要拒绝。
 */
describe('POST /api/comments —— 来源域名绑定', () => {
	const ORIGIN_A = 'https://blog.example.com';
	const ORIGIN_B = 'https://www.example.com';
	const EVIL = 'https://luoxuedev.top';

	/** 用应用自己的口径算出某个来源的 orgHash（密钥是模块级缓存，测试里无法自行复算） */
	async function orgHashOf(origin: string): Promise<string> {
		return (await checkVerifyDomain(testEnv, { origin })).orgHash;
	}

	it('关闭域名绑定时不看来源（与旧行为一致）', async () => {
		await seedSettings({ ...SMTP, comment_verify_enabled: 'false', allow_origin: '' });

		const res = await postComment({}, '203.0.113.150', { Origin: 'https://anywhere.example' });
		expect(res.status).toBe(200);
		expect(await lastCommentId()).not.toBeNull();
	});

	it('开启但白名单未配置：403 DOMAIN_NOT_ALLOWED，不落库、不发信', async () => {
		await seedSettings({
			...SMTP,
			comment_verify_domain_enabled: 'true',
			comment_verify_enabled: 'true',
		});

		const res = await postComment({}, '203.0.113.151', { Origin: ORIGIN_A });

		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('DOMAIN_NOT_ALLOWED');
		expect(await lastCommentId()).toBeNull();
		expect(sentMails).toHaveLength(0);
	});

	it('开启且 allow_origin=* ：同样 fail-closed（普通来源校验在这里会放行）', async () => {
		await seedSettings({
			...SMTP,
			comment_verify_domain_enabled: 'true',
			allow_origin: '*',
		});

		const res = await postComment({}, '203.0.113.152', { Origin: ORIGIN_A });

		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('DOMAIN_NOT_ALLOWED');
		expect(await lastCommentId()).toBeNull();
	});

	it('同域票据 + 同域请求：正常落库', async () => {
		await seedSettings({
			...SMTP,
			comment_verify_enabled: 'true',
			comment_verify_domain_enabled: 'true',
			allow_origin: `${ORIGIN_A},${ORIGIN_B}`,
		});

		const ip = '203.0.113.153';
		const ticket = await createTicket(testEnv, ip, SLUG, await orgHashOf(ORIGIN_A));
		const res = await postComment({ verify_ticket: ticket }, ip, { Origin: ORIGIN_A });

		expect(res.status).toBe(200);
		expect(await lastCommentId()).not.toBeNull();
	});

	it('票据来自另一个（同样在白名单内的）域名时拒绝为 VERIFY_REQUIRED', async () => {
		await seedSettings({
			...SMTP,
			comment_verify_enabled: 'true',
			comment_verify_domain_enabled: 'true',
			allow_origin: `${ORIGIN_A},${ORIGIN_B}`,
		});

		const ip = '203.0.113.154';
		const ticket = await createTicket(testEnv, ip, SLUG, await orgHashOf(ORIGIN_B));
		const res = await postComment({ verify_ticket: ticket }, ip, { Origin: ORIGIN_A });

		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('VERIFY_REQUIRED');
		expect(await lastCommentId()).toBeNull();
	});

	it('白名单外的域名即使带有效票据也被拒（连票据都不该用）', async () => {
		await seedSettings({
			...SMTP,
			comment_verify_enabled: 'true',
			comment_verify_domain_enabled: 'true',
			allow_origin: ORIGIN_A,
		});

		const ip = '203.0.113.155';
		const ticket = await createTicket(testEnv, ip, SLUG, await orgHashOf(EVIL));
		const res = await postComment({ verify_ticket: ticket }, ip, {
			Origin: EVIL,
			Referer: `${EVIL}/blog/aosp`,
		});

		expect(res.status).toBe(403);
		expect(res.body.reason).toBe('DOMAIN_NOT_ALLOWED');
		expect(await lastCommentId()).toBeNull();
		expect(sentMails).toHaveLength(0);
	});

	it('域名校验早于限流：冷却期内的白名单外请求返回 403 而不是 429', async () => {
		await seedSettings({
			...SMTP,
			comment_verify_enabled: 'true',
			comment_verify_domain_enabled: 'true',
			allow_origin: ORIGIN_A,
		});

		const ip = '203.0.113.156';
		await seedComment({ ip_address: ip, pub_date: Date.now() });

		const denied = await postComment({}, ip, { Origin: 'https://evil.example' });
		expect(denied.status).toBe(403);
		expect(denied.body.reason).toBe('DOMAIN_NOT_ALLOWED');

		// 白名单内来源才会走到限流，命中 60 秒冷却
		const throttled = await postComment({}, ip, { Origin: ORIGIN_A });
		expect(throttled.status).toBe(429);
	});
});

/**
 * 历史链接批量更新（doc/link_security.md 第 3 节）：触发条件 + 确认端点端到端。
 *
 * 注意这里刻意只用 SMTP_ONLY（不配 admin_email）：新评论通知被跳过，
 * `sentMails` 里只会有链接同步的确认邮件，断言更干净。
 */
describe('POST /api/comments —— 历史链接同步', () => {
	const EMAIL = 'alice@example.com';
	const OLD_URL = 'https://old.example.com';
	const NEW_URL = 'https://new.example.com';
	const NEWER_URL = 'https://newer.example.com';

	async function linkSyncReady(overrides: Record<string, string> = {}) {
		await seedSettings({
			...SMTP_ONLY,
			verify_base_url: 'https://blog.example.com',
			link_sync_enabled: 'true',
			site_name: 'Momo Blog',
			...overrides,
		});
		await seedVerification({ email: EMAIL, verified: 1 });
		await seedComment({
			post_slug: SLUG,
			email: EMAIL,
			author: 'Alice',
			url: OLD_URL,
			pub_date: 1730000000000,
		});
	}

	async function commentUrls(): Promise<string[]> {
		const { results } = await testEnv.MOMO_DB.prepare(
			'SELECT url FROM Comment WHERE lower(trim(email)) = ? ORDER BY id'
		)
			.bind(EMAIL)
			.all<{ url: string | null }>();
		return (results ?? []).map((row) => row.url ?? '');
	}

	it('满足全部条件：写一条待确认记录 + 异步发确认邮件，历史评论暂不改动', async () => {
		await linkSyncReady();
		const res = await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.90');
		expect(res.status).toBe(200);

		const rows = await allLinkSyncRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ email: EMAIL, new_url: NEW_URL, confirmed: 0 });
		expect(rows[0].token).toMatch(/^[0-9a-f-]{36}$/);
		// 24 小时有效
		expect(Date.parse(rows[0].expires_at) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);

		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe(EMAIL);
		expect(sentMails[0].subject).toBe('确认更新您在 Momo Blog 上的历史评论链接');
		expect(sentMails[0].html).toContain(OLD_URL);
		expect(sentMails[0].html).toContain(NEW_URL);
		expect(sentMails[0].html).toContain(`token=${encodeURIComponent(rows[0].token)}`);
		expect(sentMails[0].html).toContain('24 小时内有效');

		// 确认前历史评论的 url 保持旧值
		expect(await commentUrls()).toEqual([OLD_URL, NEW_URL]);
	});

	it('确认端点：批量更新该邮箱所有历史评论并标记已确认（幂等重放）', async () => {
		await linkSyncReady();
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.91');
		const row = (await allLinkSyncRequests())[0];

		const confirmPath = `/api/link-sync/confirm?token=${encodeURIComponent(row.token)}&email=${encodeURIComponent(EMAIL)}`;
		const page = await rawRequest(confirmPath);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('链接同步完成！共 1 条历史评论的网址已更新');

		expect(await commentUrls()).toEqual([NEW_URL, NEW_URL]);
		expect((await allLinkSyncRequests())[0].confirmed).toBe(1);

		// 重放：一次性令牌（已确认）返回「该链接同步已完成」，不再产生写入
		const replay = await rawRequest(confirmPath);
		expect(await replay.text()).toContain('该链接同步已完成');
		expect(await commentUrls()).toEqual([NEW_URL, NEW_URL]);
	});

	it('缺少 token / email → 缺少确认参数', async () => {
		const missingToken = await rawRequest(`/api/link-sync/confirm?email=${encodeURIComponent(EMAIL)}`);
		expect(await missingToken.text()).toContain('缺少确认参数');
		const missingEmail = await rawRequest('/api/link-sync/confirm?token=t1');
		expect(await missingEmail.text()).toContain('缺少确认参数');
	});

	it('token / email 不匹配 → 确认链接无效', async () => {
		await seedLinkSyncRequest({ email: EMAIL, token: 'tok-1', new_url: NEW_URL });
		const page = await rawRequest(`/api/link-sync/confirm?token=tok-1&email=${encodeURIComponent('other@example.com')}`);
		expect(await page.text()).toContain('确认链接无效');
	});

	it('已过期 → 固定文案，且不做任何写入', async () => {
		await seedComment({ post_slug: SLUG, email: EMAIL, url: OLD_URL });
		await seedLinkSyncRequest({
			email: EMAIL,
			token: 'tok-expired',
			new_url: NEW_URL,
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		const page = await rawRequest(
			`/api/link-sync/confirm?token=tok-expired&email=${encodeURIComponent(EMAIL)}`
		);
		expect(await page.text()).toContain('确认链接已过期，请重新提交评论以获取新的确认邮件');
		expect(await commentUrls()).toEqual([OLD_URL]);
	});

	it('去重：同一邮箱 + 同一新网址不重复发信', async () => {
		await linkSyncReady();
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.92');
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.93');

		expect(await allLinkSyncRequests()).toHaveLength(1);
		expect(sentMails).toHaveLength(1);
	});

	it('换了新网址：作废旧记录并重新发信（旧链接立刻失效）', async () => {
		await linkSyncReady();
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.94');
		await postComment({ email: EMAIL, url: NEWER_URL }, '203.0.113.95');

		const rows = await allLinkSyncRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0].new_url).toBe(NEWER_URL);
		expect(sentMails).toHaveLength(2);
	});

	it('link_sync_enabled 关闭（默认）时不触发', async () => {
		await linkSyncReady({ link_sync_enabled: 'false' });
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.96');
		expect(await allLinkSyncRequests()).toHaveLength(0);
		expect(sentMails).toHaveLength(0);
	});

	it('verify_base_url 为空时不触发（依赖 API 地址，不再依赖邮箱验证）', async () => {
		await linkSyncReady({ verify_base_url: '' });
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.97');
		expect(await allLinkSyncRequests()).toHaveLength(0);
		expect(sentMails).toHaveLength(0);
	});

	it('只开 API 地址、不开启全局邮箱验证也能触发', async () => {
		await linkSyncReady({ email_verify_enabled: 'false' });
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.97');
		expect(await allLinkSyncRequests()).toHaveLength(1);
		expect(sentMails).toHaveLength(1);
	});

	it('邮箱未通过验证时不触发', async () => {
		await seedSettings({ ...SMTP_ONLY, verify_base_url: 'https://blog.example.com', link_sync_enabled: 'true' });
		await seedVerification({ email: EMAIL, verified: 0 });
		await seedComment({ post_slug: SLUG, email: EMAIL, url: OLD_URL });
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.98');
		expect(await allLinkSyncRequests()).toHaveLength(0);
	});

	it('提交的 url 为空时不触发', async () => {
		await linkSyncReady();
		await postComment({ email: EMAIL }, '203.0.113.99');
		expect(await allLinkSyncRequests()).toHaveLength(0);
		expect(sentMails).toHaveLength(0);
	});

	it('没有「url 非空且与本次不同」的历史评论时不触发', async () => {
		await seedSettings({ ...SMTP_ONLY, verify_base_url: 'https://blog.example.com', link_sync_enabled: 'true' });
		await seedVerification({ email: EMAIL, verified: 1 });
		await seedComment({ post_slug: SLUG, email: EMAIL, url: NEW_URL, pub_date: 1730000000000 });
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.100');
		expect(await allLinkSyncRequests()).toHaveLength(0);
		expect(sentMails).toHaveLength(0);
	});

	it('历史评论只有 rejected / deleted 时不算「历史评论」', async () => {
		await seedSettings({ ...SMTP_ONLY, verify_base_url: 'https://blog.example.com', link_sync_enabled: 'true' });
		await seedVerification({ email: EMAIL, verified: 1 });
		await seedComment({ post_slug: SLUG, email: EMAIL, url: OLD_URL, status: 'rejected' });
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.101');
		expect(await allLinkSyncRequests()).toHaveLength(0);
	});

	it('SMTP 不可用时不触发', async () => {
		await seedSettings({ verify_base_url: 'https://blog.example.com', link_sync_enabled: 'true' });
		await seedVerification({ email: EMAIL, verified: 1 });
		await seedComment({ post_slug: SLUG, email: EMAIL, url: OLD_URL });
		await postComment({ email: EMAIL, url: NEW_URL }, '203.0.113.102');
		expect(await allLinkSyncRequests()).toHaveLength(0);
	});

	it('确认端点按归一化邮箱匹配（大小写/空格无关）', async () => {
		await linkSyncReady();
		await postComment({ email: '  ALICE@Example.com  ', url: NEW_URL }, '203.0.113.103');
		const row = (await allLinkSyncRequests())[0];
		expect(row.email).toBe(EMAIL);

		const page = await rawRequest(
			`/api/link-sync/confirm?token=${encodeURIComponent(row.token)}&email=${encodeURIComponent(' Alice@Example.com ')}`
		);
		expect(await page.text()).toContain('链接同步完成！共 1 条历史评论的网址已更新');
	});
});