/**
 * POST /api/comments —— 评论提交的完整链路（校验 → 限流 → 黑名单 → 人机验证 → 落库 → 通知）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { api } from '../helpers/http';
import { createSchema, getComment, getVerification, lastCommentId, seedComment, seedSettings, testEnv } from '../helpers/db';
import { resetSentMails, sentMails } from '../stubs/nodemailer';
import { createTicket } from '../../src/utils/verify';
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

beforeEach(async () => {
	await createSchema();
	resetSentMails();
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

	it('回复评论时给父评论作者发送回复通知', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		const parentId = await seedComment({
			email: 'parent@example.com',
			author: 'Parent',
			content_text: 'parent says hi',
		});
		expect((await postComment({ parent_id: parentId, email: 'child@example.com' }, '203.0.113.73')).status).toBe(200);

		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('parent@example.com');
		expect(sentMails[0].subject).toContain('回复');
		expect(sentMails[0].html).toContain('parent says hi');
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
