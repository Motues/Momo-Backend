/**
 * src/utils/email.ts —— SMTP 可用性判定、模板渲染与邮箱验证数据操作。
 *
 * nodemailer 已由测试替身替换（见 vitest.config.mts 的 alias 与 test/stubs/nodemailer.ts），
 * 因此这里可以断言「邮件确实被构造出来」以及收件人 / 主题 / 正文。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSchema, seedComment, seedSettings, seedVerification, testEnv } from '../helpers/db';
import {
	approvePendingComments,
	checkEmailVerified,
	hasUnverifiedToken,
	isEmailServiceAvailable,
	saveVerificationToken,
	sendCommentNotification,
	sendCommentReplyNotification,
	sendLinkSyncConfirmationEmail,
	sendTestEmail,
	sendVerificationEmail,
} from '../../src/utils/email';
import { resetEmailEmojiCache } from '../../src/utils/emailEmoji';
import { failNextSendMail, resetSentMails, sentMails } from '../stubs/nodemailer';

const env = testEnv;

/**
 * 文件级网络替身：发信路径的表情水合（`src/utils/emailEmoji.ts`）会拉取 owo.json。
 * 默认让所有出站请求立即失败（= 网络不可用，水合按契约降级为纯文本）；
 * 需要断言水合成功路径的用例在文件内部用 `vi.stubGlobal('fetch', ...)` 覆盖。
 *
 * 刻意在模块加载时就装上、且不用 `vi.unstubAllGlobals()`：卸载替身会恢复真实 fetch，
 * 让测试重新暴露在网络与平台端口限制之下（曾导致 isolate 拆除后的 unhandled rejection）。
 */
const disabledFetch = async (): Promise<Response> => {
	throw new Error('network disabled in tests');
};
vi.stubGlobal('fetch', disabledFetch);
const SMTP = {
	smtp_host: 'smtp.example.com',
	smtp_port: '465',
	email_user: 'noreply@example.com',
	email_password: 'secret',
	admin_email: 'admin@example.com',
};

beforeEach(async () => {
	await createSchema();
	resetSentMails();
});

describe('isEmailServiceAvailable', () => {
	it('三项齐全时可用', async () => {
		await seedSettings(SMTP);
		expect(await isEmailServiceAvailable(env)).toBe(true);
	});

	it('缺少任意一项都不可用', async () => {
		for (const missing of ['smtp_host', 'email_user', 'email_password']) {
			const settings: Record<string, string> = { ...SMTP };
			delete settings[missing];
			await testEnv.MOMO_DB.prepare('DELETE FROM Settings').run();
			await seedSettings(settings);
			expect(await isEmailServiceAvailable(env)).toBe(false);
		}
	});

	it('空字符串配置视为缺失', async () => {
		await seedSettings({ ...SMTP, email_password: '' });
		expect(await isEmailServiceAvailable(env)).toBe(false);
	});

	it('未配置任何 SMTP 时不可用', async () => {
		expect(await isEmailServiceAvailable(env)).toBe(false);
	});
});

describe('checkEmailVerified / hasUnverifiedToken', () => {
	it('没有记录时都返回 false', async () => {
		expect(await checkEmailVerified(env, 'a@example.com')).toBe(false);
		expect(await hasUnverifiedToken(env, 'a@example.com')).toBe(false);
	});

	it('verified = 1 的记录使 checkEmailVerified 为 true', async () => {
		await seedVerification({ email: 'a@example.com', verified: 1 });
		expect(await checkEmailVerified(env, 'a@example.com')).toBe(true);
	});

	it('verified = 0 的记录不算已验证', async () => {
		await seedVerification({ email: 'a@example.com', verified: 0 });
		expect(await checkEmailVerified(env, 'a@example.com')).toBe(false);
		expect(await hasUnverifiedToken(env, 'a@example.com')).toBe(true);
	});

	it('未过期且未验证的令牌使 hasUnverifiedToken 为 true', async () => {
		await seedVerification({
			email: 'a@example.com',
			verified: 0,
			expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
		});
		expect(await hasUnverifiedToken(env, 'a@example.com')).toBe(true);
	});

	it('过期日早于今天时正确返回 false', async () => {
		await seedVerification({
			email: 'a@example.com',
			verified: 0,
			expires_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
		});
		expect(await hasUnverifiedToken(env, 'a@example.com')).toBe(false);
	});

	it('只按邮箱精确匹配', async () => {
		await seedVerification({ email: 'a@example.com', verified: 1 });
		expect(await checkEmailVerified(env, 'A@example.com')).toBe(false);
	});
});

/**
 * ✅ 已修复的三端漂移：
 *   - Node.js: gte(expires_at, new Date().toISOString())  → ISO 与 ISO 比较，正确
 *   - Go:      expires_at >= '2006-01-02T15:04:05.000Z'    → ISO 与 ISO 比较，正确
 *   - Worker:  expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now') → ISO 与 ISO 比较
 * 此前 Worker 用 datetime('now')（'YYYY-MM-DD HH:MM:SS'）与 ISO 串比较，
 * SQLite 按 TEXT 字典序比较时第 11 个字符 'T'(0x54) > ' '(0x20)，
 * 导致**同一 UTC 日内已过期的令牌仍被判定为未过期**。
 * 位置：worker/src/utils/email.ts 的 hasUnverifiedToken
 */
describe('hasUnverifiedToken 的过期判定', () => {
	it('根因对照：datetime(\'now\') 与 ISO 串的字典序比较结果错误', async () => {
		const row = await testEnv.MOMO_DB.prepare(
			"SELECT ('2026-01-01T11:00:00.000Z' >= datetime('2026-01-01 12:00:00')) AS datetime_cmp, " +
				"('2026-01-01T11:00:00.000Z' >= strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01 12:00:00')) AS iso_cmp"
		).first<{ datetime_cmp: number; iso_cmp: number }>();
		// datetime() 格式下：11:00 早于 12:00，本应为 0（已过期），实际因 'T' > ' ' 得到 1
		expect(row?.datetime_cmp).toBe(1);
		// strftime 的 ISO 格式下，字典序与时间序一致
		expect(row?.iso_cmp).toBe(0);
	});

	it('同一 UTC 日内已过期的 ISO 令牌返回 false', async () => {
		const nowMs = Date.now();
		const date = new Date(nowMs);
		const dayStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
		// 取「同一 UTC 日内的过去时刻」；刚过零点时退回当日第一秒
		const pastMs = Math.max(nowMs - 3600 * 1000, dayStartMs + 1);
		await seedVerification({
			email: 'a@example.com',
			verified: 0,
			expires_at: new Date(pastMs).toISOString(),
		});
		expect(await hasUnverifiedToken(env, 'a@example.com')).toBe(false);
	});

	it('SQLite datetime 格式的过期时间同样被正确识别为已过期', async () => {
		const pastMs = Date.now() - 3600 * 1000;
		await seedVerification({
			email: 'a@example.com',
			verified: 0,
			expires_at: new Date(pastMs).toISOString().slice(0, 19).replace('T', ' '),
		});
		expect(await hasUnverifiedToken(env, 'a@example.com')).toBe(false);
	});
});

describe('saveVerificationToken', () => {
	it('写入邮箱、令牌、过期时间与文章信息', async () => {
		const expiresAt = new Date(Date.now() + 86400000).toISOString();
		await saveVerificationToken(env, 'a@example.com', 'tok-1', expiresAt, '/posts/x', 'Title');

		const row = await testEnv.MOMO_DB.prepare('SELECT * FROM EmailVerification WHERE token = ?')
			.bind('tok-1')
			.first<{
				email: string;
				expires_at: string;
				verified: number;
				post_slug: string;
				post_title: string;
				created_at: string;
			}>();
		expect(row).toMatchObject({
			email: 'a@example.com',
			expires_at: expiresAt,
			verified: 0,
			post_slug: '/posts/x',
			post_title: 'Title',
		});
		expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('未提供文章信息时落库为 NULL', async () => {
		await saveVerificationToken(env, 'a@example.com', 'tok-2', new Date().toISOString());
		const row = await testEnv.MOMO_DB.prepare('SELECT post_slug, post_title FROM EmailVerification WHERE token = ?')
			.bind('tok-2')
			.first<{ post_slug: string | null; post_title: string | null }>();
		expect(row).toEqual({ post_slug: null, post_title: null });
	});

	it('令牌唯一：重复写入相同令牌触发约束错误', async () => {
		await seedVerification({ email: 'a@example.com', token: 'dup' });
		await expect(saveVerificationToken(env, 'b@example.com', 'dup', new Date().toISOString())).rejects.toThrow();
	});
});

describe('approvePendingComments', () => {
	it('只把该邮箱的 pending 评论改为 approved，并返回影响行数', async () => {
		await seedComment({ email: 'a@example.com', status: 'pending' });
		await seedComment({ email: 'a@example.com', status: 'pending' });
		await seedComment({ email: 'a@example.com', status: 'rejected' });
		await seedComment({ email: 'b@example.com', status: 'pending' });

		expect(await approvePendingComments(env, 'a@example.com')).toBe(2);

		const { results } = await testEnv.MOMO_DB.prepare(
			'SELECT email, status, COUNT(*) as c FROM Comment GROUP BY email, status ORDER BY email, status'
		).all<{ email: string; status: string; c: number }>();
		expect(results).toEqual([
			{ email: 'a@example.com', status: 'approved', c: 2 },
			{ email: 'a@example.com', status: 'rejected', c: 1 },
			{ email: 'b@example.com', status: 'pending', c: 1 },
		]);
	});

	it('没有待审核评论时返回 0', async () => {
		await seedComment({ email: 'a@example.com', status: 'approved' });
		expect(await approvePendingComments(env, 'a@example.com')).toBe(0);
	});
});

describe('sendCommentNotification（站长通知）', () => {
	const params = {
		postTitle: '文章标题',
		postUrl: 'https://blog.example.com/post',
		commentAuthor: 'Alice',
		commentContent: '评论内容',
	};

	it('email_enabled = "false" 时跳过且不发信', async () => {
		await seedSettings({ ...SMTP, email_enabled: 'false' });
		expect(await sendCommentNotification(env, params)).toBeNull();
		expect(sentMails).toHaveLength(0);
	});

	it('未配置 admin_email 时跳过且不发信', async () => {
		const settings: Record<string, string> = { ...SMTP };
		delete settings.admin_email;
		await seedSettings(settings);
		expect(await sendCommentNotification(env, params)).toBeNull();
		expect(sentMails).toHaveLength(0);
	});

	it('未配置 SMTP 时返回 null 且不发信', async () => {
		await seedSettings({ admin_email: 'admin@example.com' });
		expect(await sendCommentNotification(env, params)).toBeNull();
		expect(sentMails).toHaveLength(0);
	});

	it('配置齐全时发信给站长，主题包含站点名', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		await sendCommentNotification(env, params);

		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('admin@example.com');
		expect(sentMails[0].from).toBe('Momo Blog 评论通知 <noreply@example.com>');
		expect(sentMails[0].subject).toBe('您在 Momo Blog 上有了新评论');
		expect(sentMails[0].html).toContain('Alice');
		expect(sentMails[0].html).toContain('评论内容');
		expect(sentMails[0].html).toContain('文章标题');
	});

	it('自定义模板：四个占位符都被替换且做 HTML 转义', async () => {
		await seedSettings({
			...SMTP,
			notification_template: '<p>{{postTitle}}|{{commentAuthor}}|{{commentContent}}|{{postUrl}}</p>',
		});
		await sendCommentNotification(env, {
			postTitle: '<b>T</b>',
			postUrl: 'https://a.com/?x=1&y=2',
			commentAuthor: 'A&B',
			commentContent: '"quoted"',
		});
		expect(sentMails[0].html).toBe(
			'<p>&lt;b&gt;T&lt;/b&gt;|A&amp;B|&quot;quoted&quot;|https://a.com/?x=1&amp;y=2</p>'
		);
	});

	it('SMTP 抛错时向上抛出（调用方决定如何降级）', async () => {
		await seedSettings(SMTP);
		failNextSendMail();
		await expect(sendCommentNotification(env, params)).rejects.toThrow('邮件发送失败');
	});
});

describe('sendCommentReplyNotification（回复通知）', () => {
	const params = {
		toEmail: 'parent@example.com',
		toName: 'Parent',
		postTitle: '文章',
		parentComment: '父评论',
		replyAuthor: 'Child',
		replyContent: '回复内容',
		postUrl: 'https://blog.example.com/post',
	};

	it('配置齐全时发信给父评论作者', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		await sendCommentReplyNotification(env, params);
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('parent@example.com');
		expect(sentMails[0].subject).toBe('您在 Momo Blog 上的评论有了新回复');
		expect(sentMails[0].html).toContain('父评论');
		expect(sentMails[0].html).toContain('回复内容');
	});

	it('自定义模板：六个占位符都被替换', async () => {
		await seedSettings({
			...SMTP,
			reply_template:
				'{{toName}}|{{replyAuthor}}|{{postTitle}}|{{parentComment}}|{{replyContent}}|{{postUrl}}',
		});
		await sendCommentReplyNotification(env, params);
		expect(sentMails[0].html).toBe(
			'Parent|Child|文章|父评论|回复内容|https://blog.example.com/post'
		);
	});

	it('email_enabled = "false" 时跳过', async () => {
		await seedSettings({ ...SMTP, email_enabled: 'false' });
		expect(await sendCommentReplyNotification(env, params)).toBeNull();
		expect(sentMails).toHaveLength(0);
	});
});

describe('sendVerificationEmail', () => {
	const params = {
		toEmail: 'newbie@example.com',
		toName: 'Newbie',
		postTitle: '文章',
		postSlug: '/posts/x',
		verifyUrl: 'https://blog.example.com/api/verify-email/verify?token=abc&email=x',
	};

	it('配置齐全时把验证链接写进邮件正文', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		await sendVerificationEmail(env, params);
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('newbie@example.com');
		expect(sentMails[0].subject).toBe('请验证您在 Momo Blog 上的评论邮箱');
		expect(sentMails[0].html).toContain('token=abc&amp;email=x');
		expect(sentMails[0].html).toContain('24 小时内有效');
	});

	it('email_enabled = "false" 时跳过', async () => {
		await seedSettings({ ...SMTP, email_enabled: 'false' });
		expect(await sendVerificationEmail(env, params)).toBeNull();
		expect(sentMails).toHaveLength(0);
	});
});

describe('sendTestEmail', () => {
	it('email_enabled = "false" 时抛错', async () => {
		await seedSettings({ ...SMTP, email_enabled: 'false' });
		await expect(sendTestEmail(env, 'admin@example.com')).rejects.toThrow('disabled');
	});

	it('未配置 SMTP 时抛错', async () => {
		await expect(sendTestEmail(env, 'admin@example.com')).rejects.toThrow('SMTP is not configured');
	});

	it('配置齐全时发送测试邮件', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		await sendTestEmail(env, 'admin@example.com');
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].subject).toBe('SMTP 配置验证');
		expect(sentMails[0].html).toContain('Momo Blog');
	});

	it('SMTP 发送失败时抛出带原因的错误', async () => {
		await seedSettings(SMTP);
		failNextSendMail();
		await expect(sendTestEmail(env, 'admin@example.com')).rejects.toThrow('stubbed smtp failure');
	});
});

describe('SMTP 传输参数', () => {
	it('默认端口 465、secure = false 时按配置透传', async () => {
		await seedSettings({ ...SMTP, smtp_port: '', email_secure: 'false' });
		await sendTestEmail(env, 'admin@example.com');
		// 替身把 createTransport 的参数挂在返回对象上，但 sendMail 只记录邮件本身；
		// 这里通过「邮件能发出去」证明配置解析未抛错。
		expect(sentMails).toHaveLength(1);
	});

	it('email_secure = "true" 时同样可用', async () => {
		await seedSettings({ ...SMTP, email_secure: 'true' });
		await sendTestEmail(env, 'admin@example.com');
		expect(sentMails).toHaveLength(1);
	});
});

/**
 * 契约 1.8.0（doc/mail.md）：通知邮件正文是**渲染后的 HTML**。
 * `*Html` 占位符原样插入（不二次转义），旧的纯文本占位符保留且语义不变（HTML 转义）。
 */
describe('通知 / 回复模板的 *Html 占位符', () => {
	beforeEach(async () => {
		await createSchema();
		resetSentMails();
		resetEmailEmojiCache();
	});

	it('{{commentContentHtml}} 原样插入，不做二次转义', async () => {
		await seedSettings({
			...SMTP,
			emoji_enabled: 'false',
			notification_template: '<div>{{commentContentHtml}}</div>',
		});
		await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://a.com/p',
			commentAuthor: 'A',
			commentContent: '<b>x</b>',
			commentContentHtml: '<p><b>x</b></p>',
		});
		expect(sentMails[0].html).toBe('<div><p><b>x</b></p></div>');
	});

	it('{{commentContent}} 继续 HTML 转义（旧模板语义不变）', async () => {
		await seedSettings({
			...SMTP,
			emoji_enabled: 'false',
			notification_template: '<div>{{commentContent}}</div>',
		});
		await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://a.com/p',
			commentAuthor: 'A',
			commentContent: '<b>x</b>',
		});
		expect(sentMails[0].html).toBe('<div>&lt;b&gt;x&lt;/b&gt;</div>');
	});

	it('默认通知模板已改用 {{commentContentHtml}}', async () => {
		await seedSettings({ ...SMTP, emoji_enabled: 'false' });
		await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://a.com/p',
			commentAuthor: 'A',
			commentContent: 'plain',
			commentContentHtml: '<p>RENDERED</p>',
		});
		expect(sentMails[0].html).toContain('<p>RENDERED</p>');
	});

	it('{{parentCommentHtml}} / {{replyContentHtml}} 原样插入，纯文本占位符仍转义', async () => {
		await seedSettings({
			...SMTP,
			emoji_enabled: 'false',
			reply_template:
				'<p>{{parentCommentHtml}}|{{replyContentHtml}}|{{parentComment}}|{{replyContent}}</p>',
		});
		await sendCommentReplyNotification(env, {
			toEmail: 'parent@example.com',
			toName: 'Parent',
			postTitle: '文章',
			parentComment: '<i>p</i>',
			parentCommentHtml: '<p>P</p>',
			replyAuthor: 'Child',
			replyContent: '<i>r</i>',
			replyContentHtml: '<p>R</p>',
			postUrl: 'https://blog.example.com/post',
		});
		expect(sentMails[0].html).toBe('<p><p>P</p>|<p>R</p>|&lt;i&gt;p&lt;/i&gt;|&lt;i&gt;r&lt;/i&gt;</p>');
	});

	it('未提供 *Html 时回落为转义后的纯文本（旧调用方不受影响）', async () => {
		await seedSettings({ ...SMTP, emoji_enabled: 'false' });
		await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://a.com/p',
			commentAuthor: 'A',
			commentContent: '<b>fallback</b>',
		});
		expect(sentMails[0].html).toContain('&lt;b&gt;fallback&lt;/b&gt;');
	});
});

describe('通知收件人 —— notify_email（doc/admin_emails.md 第 6 节）', () => {
	beforeEach(async () => {
		await createSchema();
		resetSentMails();
	});

	const params = {
		postTitle: '文章',
		postUrl: 'https://blog.example.com/post',
		commentAuthor: 'Alice',
		commentContent: 'hello',
	};

	it('发给 notify_email（而不是列表第一个）', async () => {
		await seedSettings({
			...SMTP,
			emoji_enabled: 'false',
			admin_emails: '["a@x.com","b@y.com"]',
			notify_email: 'b@y.com',
		});
		await sendCommentNotification(env, params);
		expect(sentMails[0].to).toBe('b@y.com');
	});

	it('notify_email 不在列表里时回落到列表第一个', async () => {
		await seedSettings({
			...SMTP,
			emoji_enabled: 'false',
			admin_emails: '["a@x.com","b@y.com"]',
			notify_email: 'c@z.com',
		});
		await sendCommentNotification(env, params);
		expect(sentMails[0].to).toBe('a@x.com');
	});

	it('未配置 notify_email 时回落到列表第一个', async () => {
		await seedSettings({ ...SMTP, emoji_enabled: 'false', admin_emails: '["a@x.com","b@y.com"]' });
		await sendCommentNotification(env, params);
		expect(sentMails[0].to).toBe('a@x.com');
	});

	it('只配旧键 admin_email 时行为与旧版一致', async () => {
		await seedSettings({ ...SMTP, emoji_enabled: 'false' });
		await sendCommentNotification(env, params);
		expect(sentMails[0].to).toBe('admin@example.com');
	});

	it('没有任何管理员邮箱时返回 null 且不发信', async () => {
		await seedSettings({ ...SMTP, emoji_enabled: 'false', admin_emails: '[]', notify_email: 'c@z.com' });
		await testEnv.MOMO_DB.prepare("DELETE FROM Settings WHERE key = 'admin_email'").run();
		expect(await sendCommentNotification(env, params)).toBeNull();
		expect(sentMails).toHaveLength(0);
	});
});

/**
 * 服务端短代码水合（doc/mail.md 第 4 节）。
 * 用 stub 的全局 fetch 模拟 ow o.json 来源，避免测试依赖网络。
 */
describe('邮件短代码水合（服务端）', () => {
	const OWO_URL = 'https://cdn.example.com/owo.json';
	const OWO = {
		图片: {
			type: 'image',
			container: [
				{ icon: '<img src="https://cdn.example.com/doge.png">', text: 'doge' },
				{ icon: '<img src="https://cdn.example.com/hi.png">', text: '' },
			],
		},
	};
	const IMG_DOGE =
		'<img src="https://cdn.example.com/doge.png" alt=":doge:" title=":doge:" style="max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;">';

	function stubJson(payload: unknown, status = 200) {
		const mock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
		vi.stubGlobal('fetch', mock);
		return mock;
	}

	beforeEach(async () => {
		await createSchema();
		resetSentMails();
		resetEmailEmojiCache();
	});

	afterEach(() => {
		// 装回文件级断网替身（而不是 unstubAllGlobals：那会恢复真实的 fetch）
		vi.stubGlobal('fetch', disabledFetch);
	});

	async function sendWithHtml(commentContentHtml: string) {
		await seedSettings({
			...SMTP,
			emoji_enabled: 'true',
			emoji_cdn_urls: JSON.stringify([OWO_URL]),
			notification_template: '<div>{{commentContentHtml}}</div>',
		});
		await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://a.com/p',
			commentAuthor: 'A',
			commentContent: 'plain',
			commentContentHtml,
		});
		return sentMails[0].html as string;
	}

	it('命中短代码时注入内联小图（alt/title/style 与契约一致）', async () => {
		const mock = stubJson(OWO);
		const html = await sendWithHtml('<p>hi :doge: and 12:30:45</p>');
		expect(mock).toHaveBeenCalledTimes(1);
		expect(html).toBe(`<div><p>hi ${IMG_DOGE} and 12:30:45</p></div>`);
	});

	it('text 为空时用 FNV-1a 短代码（e-<8hex>）', async () => {
		stubJson(OWO);
		const html = await sendWithHtml('<p>:e-ebc4e309:</p>');
		expect(html).toBe(
			'<div><p><img src="https://cdn.example.com/hi.png" alt=":e-ebc4e309:" title=":e-ebc4e309:" style="max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;"></p></div>'
		);
	});

	it('fetch 失败时降级为纯文本，邮件照常发出', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new Error('network down');
		}));
		const html = await sendWithHtml('<p>hi :doge:</p>');
		expect(html).toBe('<div><p>hi :doge:</p></div>');
		expect(sentMails).toHaveLength(1);
	});

	it('非 2xx / 非 JSON 同样只丢该来源', async () => {
		stubJson({}, 500);
		expect(await sendWithHtml('<p>:doge:</p>')).toBe('<div><p>:doge:</p></div>');
		resetSentMails();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
		expect(await sendWithHtml('<p>:doge:</p>')).toBe('<div><p>:doge:</p></div>');
	});

	it('emoji_enabled = "false" 时不水合，也不发请求', async () => {
		const mock = stubJson(OWO);
		await seedSettings({
			...SMTP,
			emoji_enabled: 'false',
			emoji_cdn_urls: JSON.stringify([OWO_URL]),
			notification_template: '<div>{{commentContentHtml}}</div>',
		});
		await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://a.com/p',
			commentAuthor: 'A',
			commentContent: 'plain',
			commentContentHtml: '<p>:doge:</p>',
		});
		expect(sentMails[0].html).toBe('<div><p>:doge:</p></div>');
		expect(mock).not.toHaveBeenCalled();
	});

	it('code / pre / script 内部不替换（只处理文本节点）', async () => {
		stubJson(OWO);
		const html = await sendWithHtml(
			'<p title=":doge:">a :doge:</p><code>:doge:</code><pre>:doge:</pre><script>:doge:</script>'
		);
		expect(html).toBe(
			`<div><p title=":doge:">a ${IMG_DOGE}</p><code>:doge:</code><pre>:doge:</pre><script>:doge:</script></div>`
		);
	});

	it('边界：名称前是字母/数字或后是数字时不替换', async () => {
		stubJson(OWO);
		const html = await sendWithHtml('<p>a:doge: :doge:1 x:doge:</p>');
		// `a:doge:` 前一个字符是字母 → 不替换；`:doge:1` 后一个字符是数字 → 不替换
		expect(html).toBe('<div><p>a:doge: :doge:1 x:doge:</p></div>');
	});

	it('多来源按顺序合并，跨来源重名追加 -2（每项水合回自己的图）', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string) => {
				if (input === 'https://a.example.com/owo.json') {
					return new Response(
						JSON.stringify({
							Pack: { type: 'image', container: [{ icon: '<img src="https://a.example.com/doge.png">', text: 'doge' }] },
						}),
						{ status: 200 }
					);
				}
				return new Response(
					JSON.stringify({
						Pack: { type: 'image', container: [{ icon: '<img src="https://b.example.com/doge.gif">', text: 'doge' }] },
					}),
					{ status: 200 }
				);
			})
		);
		await seedSettings({
			...SMTP,
			emoji_enabled: 'true',
			emoji_cdn_urls: JSON.stringify(['https://a.example.com/owo.json', 'https://b.example.com/owo.json']),
			notification_template: '<div>{{commentContentHtml}}</div>',
		});
		await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://a.com/p',
			commentAuthor: 'A',
			commentContent: 'plain',
			commentContentHtml: '<p>:doge: :doge-2:</p>',
		});
		expect(sentMails[0].html).toContain('src="https://a.example.com/doge.png"');
		expect(sentMails[0].html).toContain('src="https://b.example.com/doge.gif"');
	});

	it('10 分钟模块级缓存：同一地址列表第二次发信不再请求', async () => {
		const mock = stubJson(OWO);
		await sendWithHtml('<p>:doge:</p>');
		resetSentMails();
		await sendWithHtml('<p>:doge:</p>');
		expect(mock).toHaveBeenCalledTimes(1);
	});
});

describe('sendLinkSyncConfirmationEmail（历史链接同步确认邮件）', () => {
	beforeEach(async () => {
		await createSchema();
		resetSentMails();
	});

	it('主题固定，正文包含旧/新网址、页面地址与 24 小时说明', async () => {
		await seedSettings({ ...SMTP, site_name: 'Momo Blog' });
		await sendLinkSyncConfirmationEmail(env, {
			toEmail: 'alice@example.com',
			toName: 'Alice',
			oldUrl: 'https://old.example.com',
			newUrl: 'https://new.example.com',
			confirmUrl: 'https://blog.example.com/api/link-sync/confirm?token=t1&email=a%40x.com',
			postTitle: '文章标题',
			postUrl: 'https://blog.example.com/post',
		});

		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('alice@example.com');
		expect(sentMails[0].subject).toBe('确认更新您在 Momo Blog 上的历史评论链接');
		expect(sentMails[0].html).toContain('https://old.example.com');
		expect(sentMails[0].html).toContain('https://new.example.com');
		expect(sentMails[0].html).toContain('文章标题');
		expect(sentMails[0].html).toContain('token=t1&amp;email=a%40x.com');
		expect(sentMails[0].html).toContain('24 小时内有效');
	});

	it('email_enabled = "false" 时跳过', async () => {
		await seedSettings({ ...SMTP, email_enabled: 'false' });
		expect(
			await sendLinkSyncConfirmationEmail(env, {
				toEmail: 'alice@example.com',
				toName: 'Alice',
				oldUrl: 'https://old.example.com',
				newUrl: 'https://new.example.com',
				confirmUrl: 'https://blog.example.com/api/link-sync/confirm?token=t1&email=a%40x.com',
			})
		).toBeNull();
		expect(sentMails).toHaveLength(0);
	});
});
