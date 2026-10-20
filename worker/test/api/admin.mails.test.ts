/**
 * GET /admin/mails —— 邮件发送日志列表（任务规范 §9 / §10.5）。
 *
 * 覆盖：分页与排序（created_at DESC, id DESC）、status / type / search 筛选、
 * 无法识别的取值按 all、缺 token 401、retentionDays 字段、只返回保留窗口内的行
 * （保留天数可配置：`mail_log_retention_days`，0 = 永久保留）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import { createSchema, seedMailLog, seedSettings } from '../helpers/db';

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

const authed = () => bearer(token);

const DAY = 24 * 3600 * 1000;

async function seedFixture() {
	// 同一时刻的两行：排序必须用 id DESC 兜底
	const sameMoment = new Date().toISOString();
	await seedMailLog({
		type: 'verify',
		recipient: 'a@x.com',
		subject: '请验证您的邮箱',
		status: 'sent',
		created_at: sameMoment,
	});
	await seedMailLog({
		type: 'dormant_notice',
		recipient: 'b@x.com',
		subject: '您在 Momo Blog 的个人网站链接已进入休眠',
		status: 'failed',
		error: 'smtp timeout',
		created_at: sameMoment,
	});
	await seedMailLog({
		type: 'comment_notify',
		recipient: 'admin@x.com',
		subject: '您在 Momo Blog 上有了新评论',
		status: 'sent',
		created_at: new Date(Date.now() - DAY).toISOString(),
	});
	// 窗口外（31 天前）：列表接口不应返回
	await seedMailLog({
		type: 'test',
		recipient: 'old@x.com',
		subject: 'SMTP 配置验证',
		status: 'sent',
		created_at: new Date(Date.now() - 31 * DAY).toISOString(),
	});
}

describe('GET /admin/mails —— 鉴权', () => {
	it('缺少 token 返回 401', async () => {
		await seedFixture();
		const res = await api('/admin/mails', { headers: {} });
		expect(res.status).toBe(401);
		expect(res.body.code).toBe(401);
	});
});

describe('GET /admin/mails —— 列表与分页', () => {
	it('返回 30 天窗口内的行，按 created_at DESC、id DESC 排序，error 无值为空串', async () => {
		await seedFixture();
		const res = await api('/admin/mails', { headers: authed() });
		expect(res.status).toBe(200);
		expect(res.body.code).toBe(200);
		expect(res.body.message).toBe('Mails fetched successfully');
		expect(res.body.data.retentionDays).toBe(30);
		expect(res.body.data).toMatchObject({ page: 1, pageSize: 20, total: 3 });

		const list = res.body.data.list;
		expect(list).toHaveLength(3);
		// 同一时刻的两行：id 大的在前
		expect(list[0].type).toBe('dormant_notice');
		expect(list[0].error).toBe('smtp timeout');
		expect(list[1].type).toBe('verify');
		expect(list[1].error).toBe('');
		expect(list[2].type).toBe('comment_notify');
		// createdAt 就是落库的 ISO 串
		expect(list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Object.keys(list[0]).sort()).toEqual(
			['createdAt', 'error', 'id', 'recipient', 'status', 'subject', 'type'].sort()
		);
	});

	it('分页：page / pageSize 生效，pageSize 上限 100、下限 1', async () => {
		await seedFixture();
		const res = await api('/admin/mails?page=2&pageSize=1', { headers: authed() });
		expect(res.body.data).toMatchObject({ page: 2, pageSize: 1, total: 3 });
		expect(res.body.data.list).toHaveLength(1);
		// 第二页 = 排序里的第二条（verify）
		expect(res.body.data.list[0].type).toBe('verify');

		const clampedHigh = await api('/admin/mails?pageSize=1000', { headers: authed() });
		expect(clampedHigh.body.data.pageSize).toBe(100);

		const clampedLow = await api('/admin/mails?pageSize=-5&page=', { headers: authed() });
		expect(clampedLow.body.data.pageSize).toBe(1);
		expect(clampedLow.body.data.page).toBe(1);

		const clampedPage = await api('/admin/mails?page=-3', { headers: authed() });
		expect(clampedPage.body.data.page).toBe(1);
	});
});

describe('GET /admin/mails —— 筛选', () => {
	it('status=sent / failed 精确筛选', async () => {
		await seedFixture();
		const sent = await api('/admin/mails?status=sent', { headers: authed() });
		expect(sent.body.data.total).toBe(2);
		expect(sent.body.data.list.every((row: any) => row.status === 'sent')).toBe(true);

		const failed = await api('/admin/mails?status=failed', { headers: authed() });
		expect(failed.body.data.total).toBe(1);
		expect(failed.body.data.list[0].type).toBe('dormant_notice');
	});

	it('type 精确筛选（六种取值之一）', async () => {
		await seedFixture();
		const res = await api('/admin/mails?type=verify', { headers: authed() });
		expect(res.body.data.total).toBe(1);
		expect(res.body.data.list[0].recipient).toBe('a@x.com');

		const none = await api('/admin/mails?type=reply_notify', { headers: authed() });
		expect(none.body.data.total).toBe(0);
		expect(none.body.data.list).toEqual([]);
	});

	it('search 对 recipient / subject 做不区分大小写的模糊匹配', async () => {
		await seedFixture();
		const byRecipient = await api('/admin/mails?search=A@X.COM', { headers: authed() });
		expect(byRecipient.body.data.total).toBe(1);
		expect(byRecipient.body.data.list[0].type).toBe('verify');

		const bySubject = await api('/admin/mails?search=休眠', { headers: authed() });
		expect(bySubject.body.data.total).toBe(1);
		expect(bySubject.body.data.list[0].type).toBe('dormant_notice');

		// trim 后为空 = 不筛选
		const blank = await api('/admin/mails?search=%20%20', { headers: authed() });
		expect(blank.body.data.total).toBe(3);
	});

	it('无法识别的 status / type 按 all 处理', async () => {
		await seedFixture();
		for (const query of ['status=maybe', 'status=', 'status=SENT2', 'type=unknown', 'type=', 'type=MAIL']) {
			const res = await api(`/admin/mails?${query}`, { headers: authed() });
			expect(res.body.data.total, query).toBe(3);
		}
		// 大小写不敏感（合法取值同样归一化）
		const upper = await api('/admin/mails?status=FAILED&type=DORMANT_NOTICE', { headers: authed() });
		expect(upper.body.data.total).toBe(1);
		expect(upper.body.data.list[0].type).toBe('dormant_notice');
	});

	it('组合筛选：status + type + search', async () => {
		await seedFixture();
		const res = await api('/admin/mails?status=failed&type=dormant_notice&search=b@x.com', {
			headers: authed(),
		});
		expect(res.body.data.total).toBe(1);

		const empty = await api('/admin/mails?status=sent&type=dormant_notice', { headers: authed() });
		expect(empty.body.data.total).toBe(0);
	});
});

describe('GET /admin/mails —— 自定义保留天数', () => {
	it('设置为 7 天：窗口外的行不返回，retentionDays 同步', async () => {
		await seedSettings({ mail_log_retention_days: '7' });
		await seedMailLog({
			type: 'test',
			recipient: 'old@x.com',
			subject: '十天前',
			status: 'sent',
			created_at: new Date(Date.now() - 10 * DAY).toISOString(),
		});
		await seedMailLog({
			type: 'test',
			recipient: 'new@x.com',
			subject: '一天前',
			status: 'sent',
			created_at: new Date(Date.now() - 1 * DAY).toISOString(),
		});

		const res = await api('/admin/mails', { headers: authed() });
		expect(res.body.data.retentionDays).toBe(7);
		expect(res.body.data.total).toBe(1);
		expect(res.body.data.list[0].recipient).toBe('new@x.com');
	});

	it('设置为 0：永久保留，不设时间下限、返回全部历史', async () => {
		await seedSettings({ mail_log_retention_days: '0' });
		await seedMailLog({
			type: 'test',
			recipient: 'ancient@x.com',
			subject: '很久以前',
			status: 'sent',
			created_at: new Date(Date.now() - 3000 * DAY).toISOString(),
		});

		const res = await api('/admin/mails', { headers: authed() });
		expect(res.body.data.retentionDays).toBe(0);
		expect(res.body.data.total).toBe(1);
		expect(res.body.data.list[0].recipient).toBe('ancient@x.com');
	});
});

describe('GET /admin/mails —— 与真实发送联动', () => {
	it('后台「测试邮件」发信后立刻能看到那一行', async () => {
		await seedSettings({
			smtp_host: 'smtp.example.com',
			smtp_port: '465',
			email_user: 'noreply@example.com',
			email_password: 'secret',
			admin_email: 'admin@example.com',
			site_name: 'Momo Blog',
		});

		const sent = await api('/admin/settings/test-email', { method: 'POST', headers: authed() });
		expect(sent.status).toBe(200);

		const res = await api('/admin/mails?type=test', { headers: authed() });
		expect(res.body.data.total).toBe(1);
		expect(res.body.data.list[0]).toMatchObject({
			type: 'test',
			recipient: 'admin@example.com',
			subject: 'SMTP 配置验证',
			status: 'sent',
			error: '',
		});
	});
});
