import { Context } from 'hono';
import { Bindings } from '../../bindings';
import {
	getMailLogRetentionDays,
	isMailType,
	mailLogCutoff,
} from '../../utils/mailLog';

/**
 * `GET /admin/mails` —— 邮件发送日志列表（任务规范 §9）。
 *
 * 查询参数：`page`（默认 1，≥1）、`pageSize`（默认 20，上限 100）、
 * `status`（`all` 默认 / `sent` / `failed`；无法识别按 `all`）、
 * `type`（`all` 默认 / 六种邮件类型；无法识别按 `all`）、
 * `search`（对 `recipient` 或 `subject` 做不区分大小写的模糊匹配，trim 后为空表示不筛选）。
 *
 * 只返回保留窗口内的记录（保留天数由 `mail_log_retention_days` 决定，0 = 永久保留），
 * 按 `created_at DESC, id DESC` 排序（并列时 id 倒序，保证稳定）。
 */
export const listMails = async (c: Context<{ Bindings: Bindings }>) => {
	// 分页参数 clamp：page >= 1，1 <= pageSize <= 100
	const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
	const pageSize = Math.min(Math.max(1, parseInt(c.req.query('pageSize') || '20', 10) || 20), 100);

	// status：无法识别的取值按 all
	const rawStatus = (c.req.query('status') || 'all').trim().toLowerCase();
	const status = rawStatus === 'sent' || rawStatus === 'failed' ? rawStatus : 'all';

	// type：无法识别的取值按 all
	const rawType = (c.req.query('type') || 'all').trim().toLowerCase();
	const type = isMailType(rawType) ? rawType : 'all';

	const search = (c.req.query('search') || '').trim();

	// 只返回保留窗口内的行；0 = 永久保留时不加时间下限
	const retentionDays = await getMailLogRetentionDays(c.env);
	const cutoff = mailLogCutoff(Date.now(), retentionDays);
	const conditions: string[] = [];
	const args: unknown[] = [];
	if (cutoff) {
		conditions.push('created_at >= ?');
		args.push(cutoff);
	}
	if (status !== 'all') {
		conditions.push('status = ?');
		args.push(status);
	}
	if (type !== 'all') {
		conditions.push('type = ?');
		args.push(type);
	}
	if (search) {
		// 对 recipient / subject 做不区分大小写的模糊匹配
		conditions.push('(LOWER(recipient) LIKE ? OR LOWER(subject) LIKE ?)');
		const like = `%${search.toLowerCase()}%`;
		args.push(like, like);
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const totalRow = await c.env.MOMO_DB.prepare(
		`SELECT COUNT(*) as count FROM MailLog ${whereClause}`
	)
		.bind(...args)
		.first<{ count: number }>();

	const { results } = await c.env.MOMO_DB.prepare(
		`SELECT id, type, recipient, subject, status, error, created_at
       FROM MailLog
       ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
	)
		.bind(...args, pageSize, (page - 1) * pageSize)
		.all<{
			id: number;
			type: string;
			recipient: string;
			subject: string;
			status: string;
			error: string | null;
			created_at: string;
		}>();

	const list = (results || []).map((row) => ({
		id: row.id,
		type: row.type,
		recipient: row.recipient,
		subject: row.subject,
		status: row.status,
		// 与既有接口的空串风格一致：error 无值时空串
		error: row.error || '',
		createdAt: row.created_at,
	}));

	return c.json({
		code: 200,
		message: 'Mails fetched successfully',
		data: {
			list,
			total: totalRow?.count || 0,
			page,
			pageSize,
			retentionDays,
		},
	});
};
