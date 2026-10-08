/**
 * src/utils/email.ts —— SMTP 可用性判定、模板渲染与邮箱验证数据操作。
 *
 * nodemailer 已由测试替身替换（见 vitest.config.mts 的 alias 与 test/stubs/nodemailer.ts），
 * 因此这里可以断言「邮件确实被构造出来」以及收件人 / 主题 / 正文。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSchema, seedComment, seedSettings, seedVerification, testEnv } from '../helpers/db';
import {
	approvePendingComments,
	checkEmailVerified,
	hasUnverifiedToken,
	isEmailServiceAvailable,
	saveVerificationToken,
	sendCommentNotification,
	sendCommentReplyNotification,
	sendTestEmail,
	sendVerificationEmail,
} from '../../src/utils/email';
import { failNextSendMail, resetSentMails, sentMails } from '../stubs/nodemailer';

const env = testEnv;
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
		expect(sentMails[0].subject).toBe('你在 Momo Blog 上有了新评论');
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
		expect(sentMails[0].subject).toBe('你在 Momo Blog 上的评论有了新回复');
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
		expect(sentMails[0].subject).toBe('请验证你在 Momo Blog 上的评论邮箱');
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
