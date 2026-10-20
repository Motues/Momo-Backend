/**
 * src/utils/mailLog.ts + src/utils/email.ts 的邮件日志落点（任务规范 §3 / §10.4）。
 *
 * 口径：
 *  - **一次真正尝试过的发送 = 一行**（写点在最底层的 `smtpFetch`）；
 *  - SMTP 未配置 / 邮件通知关闭导致的「跳过」不记录；
 *  - 成功 → `sent`、error 为 NULL；抛错 → `failed` + 错误信息，且**照旧把错误抛给调用方**；
 *  - 保留策略：每次写日志顺手清掉 30 天以前的行。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSchema, seedMailLog, seedSettings, allMailLogs, countMailLogs, testEnv } from '../helpers/db';
import {
	sendCommentNotification,
	sendCommentReplyNotification,
	sendDormantNoticeEmail,
	sendLinkSyncConfirmationEmail,
	sendTestEmail,
	sendVerificationEmail,
} from '../../src/utils/email';
import {
	MAIL_LOG_ERROR_MAX_LENGTH,
	MAIL_LOG_RETENTION_DAYS,
	MAIL_LOG_RETENTION_ERROR,
	MAX_MAIL_LOG_RETENTION_DAYS,
	resolveMailLogRetentionDays,
	validateMailLogRetentionDays,
	writeMailLog,
} from '../../src/utils/mailLog';
import { failNextSendMail, resetSentMails, sentMails } from '../stubs/nodemailer';

const env = testEnv;

// 出站网络在测试里不可用（与 unit/email.test.ts 同一策略）
vi.stubGlobal('fetch', async (): Promise<Response> => {
	throw new Error('network disabled in tests');
});

const SMTP = {
	smtp_host: 'smtp.example.com',
	smtp_port: '465',
	email_user: 'noreply@example.com',
	email_password: 'secret',
	admin_email: 'admin@example.com',
	site_name: 'Momo Blog',
};

beforeEach(async () => {
	await createSchema();
	resetSentMails();
});

/** 六种类型各发一封（极薄，只为覆盖写入点） */
const SENDERS: { type: string; send: () => Promise<unknown> }[] = [
	{
		type: 'verify',
		send: () =>
			sendVerificationEmail(env, {
				toEmail: 'user@example.com',
				toName: 'User',
				postTitle: 'T',
				postSlug: '/p',
				verifyUrl: 'https://blog.example.com/api/verify-email/verify?token=t',
			}),
	},
	{
		type: 'link_sync',
		send: () =>
			sendLinkSyncConfirmationEmail(env, {
				toEmail: 'user@example.com',
				toName: 'User',
				oldUrl: 'https://old.example.com',
				newUrl: 'https://new.example.com',
				confirmUrl: 'https://blog.example.com/api/link-sync/confirm?token=t',
			}),
	},
	{
		type: 'dormant_notice',
		send: () =>
			sendDormantNoticeEmail(env, {
				toEmail: 'user@example.com',
				toName: 'User',
				url: 'https://user.example.com',
				noticeUrl: 'https://blog.example.com/api/link-dormant/notice?token=t',
				dormantDays: 30,
			}),
	},
	{
		type: 'comment_notify',
		send: () =>
			sendCommentNotification(env, {
				postTitle: 'T',
				postUrl: 'https://blog.example.com/p',
				commentAuthor: 'A',
				commentContent: 'hi',
			}),
	},
	{
		type: 'reply_notify',
		send: () =>
			sendCommentReplyNotification(env, {
				toEmail: 'user@example.com',
				toName: 'User',
				postTitle: 'T',
				parentComment: 'p',
				replyAuthor: 'B',
				replyContent: 'r',
				postUrl: 'https://blog.example.com/p',
			}),
	},
	{
		type: 'test',
		send: () => sendTestEmail(env, 'admin@example.com'),
	},
];

describe('MailLog —— 六种类型都在最底层发送函数里落一行 sent', () => {
	for (const sender of SENDERS) {
		it(`type = ${sender.type}`, async () => {
			await seedSettings(SMTP);
			await sender.send();

			expect(sentMails).toHaveLength(1);
			const rows = await allMailLogs();
			expect(rows).toHaveLength(1);
			expect(rows[0].type).toBe(sender.type);
			expect(rows[0].status).toBe('sent');
			expect(rows[0].error).toBeNull();
			// 收件人与「实际发出的主题」原样落库
			expect(rows[0].recipient).toBe(sentMails[0].to);
			expect(rows[0].subject).toBe(sentMails[0].subject);
			expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		});
	}
});

describe('MailLog —— 跳过不记录', () => {
	it('SMTP 未配置时返回 null 且一行都不记', async () => {
		await seedSettings({ admin_email: 'admin@example.com' });
		expect(await sendCommentNotification(env, {
			postTitle: 'T',
			postUrl: 'https://blog.example.com/p',
			commentAuthor: 'A',
			commentContent: 'hi',
		})).toBeNull();
		expect(await countMailLogs()).toBe(0);
	});

	it('email_enabled = "false" 时跳过且一行都不记', async () => {
		await seedSettings({ ...SMTP, email_enabled: 'false' });
		const result = await sendDormantNoticeEmail(env, {
			toEmail: 'user@example.com',
			toName: 'User',
			url: 'https://user.example.com',
			noticeUrl: 'https://blog.example.com/api/link-dormant/notice?token=t',
			dormantDays: 30,
		});
		expect(result).toBeNull();
		expect(await countMailLogs()).toBe(0);
	});
});

describe('MailLog —— 失败分支', () => {
	it('底层发送抛错 → 一行 failed（error 非空），调用方仍然看到原来的错误', async () => {
		await seedSettings(SMTP);
		failNextSendMail();

		await expect(
			sendVerificationEmail(env, {
				toEmail: 'user@example.com',
				toName: 'User',
				postTitle: 'T',
				postSlug: '/p',
				verifyUrl: 'https://blog.example.com/api/verify-email/verify?token=t',
			})
		).rejects.toThrow('邮件发送失败: stubbed smtp failure');

		const rows = await allMailLogs();
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('failed');
		expect(rows[0].type).toBe('verify');
		expect(rows[0].error).toContain('stubbed smtp failure');
		expect(rows[0].error).not.toBe('');
	});

	it('失败原因截断到 500 字符', async () => {
		await writeMailLog(env, {
			type: 'test',
			recipient: 'a@x.com',
			subject: 'S',
			status: 'failed',
			error: 'x'.repeat(MAIL_LOG_ERROR_MAX_LENGTH + 50),
		});
		const rows = await allMailLogs();
		expect(rows[0].error).toHaveLength(MAIL_LOG_ERROR_MAX_LENGTH);
	});
});

describe('MailLog —— 保留策略（30 天）', () => {
	it('写日志时顺手清掉 30 天以前的行', async () => {
		await seedSettings(SMTP);
		await seedMailLog({
			subject: 'old',
			created_at: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString(),
		});
		expect(await countMailLogs()).toBe(1);

		await sendTestEmail(env, 'admin@example.com');

		const rows = await allMailLogs();
		expect(rows).toHaveLength(1);
		expect(rows[0].subject).toBe('SMTP 配置验证');
	});

	it('正好 30 天前的行仍在窗口内（不被清理）', async () => {
		await seedSettings(SMTP);
		await seedMailLog({
			subject: 'boundary',
			// 略晚于 cutoff（cutoff = now - 30 天），保证在窗口内
			created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000 + 60000).toISOString(),
		});

		await sendTestEmail(env, 'admin@example.com');

		const subjects = (await allMailLogs()).map((row) => row.subject);
		expect(subjects).toContain('boundary');
	});

	it('自定义 7 天：写日志时清掉 7 天以前的行', async () => {
		await seedSettings({ ...SMTP, mail_log_retention_days: '7' });
		await seedMailLog({
			subject: 'eight-days',
			created_at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
		});
		await seedMailLog({
			subject: 'six-days',
			created_at: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
		});

		await sendTestEmail(env, 'admin@example.com');

		const subjects = (await allMailLogs()).map((row) => row.subject);
		expect(subjects).not.toContain('eight-days');
		expect(subjects).toContain('six-days');
	});

	it('自定义 0（永久保留）：不清理任何历史行', async () => {
		await seedSettings({ ...SMTP, mail_log_retention_days: '0' });
		await seedMailLog({
			subject: 'ancient',
			created_at: new Date(Date.now() - 3000 * 24 * 3600 * 1000).toISOString(),
		});

		await sendTestEmail(env, 'admin@example.com');

		const subjects = (await allMailLogs()).map((row) => row.subject);
		expect(subjects).toContain('ancient');
	});

	it('读取归一化与写入校验', () => {
		expect(resolveMailLogRetentionDays(undefined)).toBe(MAIL_LOG_RETENTION_DAYS);
		expect(resolveMailLogRetentionDays('abc')).toBe(MAIL_LOG_RETENTION_DAYS);
		expect(resolveMailLogRetentionDays('1.5')).toBe(MAIL_LOG_RETENTION_DAYS);
		expect(resolveMailLogRetentionDays('-5')).toBe(0);
		expect(resolveMailLogRetentionDays('0')).toBe(0);
		expect(resolveMailLogRetentionDays('99999')).toBe(MAX_MAIL_LOG_RETENTION_DAYS);

		expect(validateMailLogRetentionDays(' 030 ')).toBeNull();
		for (const bad of ['', '   ', '-1', '1.5', '3651', 'abc', '30d']) {
			expect(validateMailLogRetentionDays(bad), bad).toBe(MAIL_LOG_RETENTION_ERROR);
		}
	});
});

describe('MailLog —— 写日志失败绝不影响发信', () => {
	it('MailLog 表不存在时发送照常成功', async () => {
		await seedSettings(SMTP);
		// 模拟尚未迁移的旧库：表还没建出来
		await testEnv.MOMO_DB.prepare('DROP TABLE MailLog').run();

		await expect(sendTestEmail(env, 'admin@example.com')).resolves.toBeUndefined();
		expect(sentMails).toHaveLength(1);
	});
});
