import { Bindings } from '../bindings';
import { getSetting } from './settings';

/**
 * 邮件发送日志（MailLog，见任务规范 §3 与 §9）。
 *
 * 口径（三端逐字一致）：
 *  - **一次真正尝试过的发送 = 一行**：写点在最底层的发送函数 `smtpFetch` 里；
 *  - SMTP 未配置 / 邮件通知关闭导致的「跳过」不记录（那些都发生在拿到配置之前就 return）；
 *  - 发送成功 → `sent`、`error` 为 NULL；发送抛错 → `failed` + 错误信息（截断到 500 字符），
 *    随后**照旧把错误抛给调用方**（日志绝不改变既有的发送/失败语义）；
 *  - 写日志本身失败一律无声吞掉（只写服务端日志），绝不影响发信结果；
 *  - 保留策略：保留天数由设置项 `mail_log_retention_days` 决定（默认 30 天，0 = 永久保留）；
 *    每次写日志时顺手删除窗口外的行，列表接口也只返回窗口内的行。
 */

/** 六种邮件类型（`MailLog.type` 的取值，三端逐字一致） */
export const MAIL_TYPES = [
	'verify',
	'link_sync',
	'dormant_notice',
	'comment_notify',
	'reply_notify',
	'test',
] as const;

export type MailType = (typeof MAIL_TYPES)[number];

/** 邮件状态 */
export const MAIL_STATUSES = ['sent', 'failed'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

/** 保留天数的设置键（面板「邮件通知设置 → 邮件记录」写入） */
export const MAIL_LOG_RETENTION_KEY = 'mail_log_retention_days';
/** 默认保留天数（未配置 / 脏值时的回退值） */
export const MAIL_LOG_RETENTION_DAYS = 30;
/** 保留天数上限（与认证记录的保留天数同一口径） */
export const MAX_MAIL_LOG_RETENTION_DAYS = 3650;
/** 非法保留天数的错误文案（三端逐字一致） */
export const MAIL_LOG_RETENTION_ERROR = `mail_log_retention_days 必须是 0-${MAX_MAIL_LOG_RETENTION_DAYS} 之间的整数`;

/** 错误信息截断长度 */
export const MAIL_LOG_ERROR_MAX_LENGTH = 500;

const DAY_MS = 86400000;

/** 类型守卫：是否是六种已知邮件类型 */
export function isMailType(value: unknown): value is MailType {
	return typeof value === 'string' && (MAIL_TYPES as readonly string[]).includes(value);
}

/**
 * 读取路径的保留天数归一化（宽容）：
 *
 * - 未配置 / 非整数（`""`、`abc`、`1.5`）→ 默认 30 天；
 * - `0` 或负数 → **永久保留**（不清理、列表不做时间下限）；
 * - 大于上限 → 夹取到 3650。
 */
export function resolveMailLogRetentionDays(raw: unknown): number {
	const text = String(raw ?? '').trim();
	if (text === '') return MAIL_LOG_RETENTION_DAYS;
	if (!/^-?\d+$/.test(text)) return MAIL_LOG_RETENTION_DAYS;
	const days = Number(text);
	if (!Number.isFinite(days)) return MAIL_LOG_RETENTION_DAYS;
	if (days <= 0) return 0;
	return Math.min(days, MAX_MAIL_LOG_RETENTION_DAYS);
}

/** 写入路径校验：0–3650 的十进制整数（`""` / 负数 / 小数 / 单位都不接受） */
export function validateMailLogRetentionDays(raw: unknown): string | null {
	const text = String(raw ?? '').trim();
	if (!/^\d+$/.test(text)) return MAIL_LOG_RETENTION_ERROR;
	const days = Number(text);
	if (!Number.isFinite(days) || days > MAX_MAIL_LOG_RETENTION_DAYS) {
		return MAIL_LOG_RETENTION_ERROR;
	}
	return null;
}

/** 从设置读取当前生效的保留天数（0 = 永久保留） */
export async function getMailLogRetentionDays(env: Bindings): Promise<number> {
	return resolveMailLogRetentionDays(await getSetting(env, MAIL_LOG_RETENTION_KEY));
}

/**
 * 保留窗口的起点（ISO 8601 UTC）；永久保留时返回 `null`
 * （调用方据此跳过清理，列表也不加时间下限）。
 */
export function mailLogCutoff(nowMs: number, days: number): string | null {
	if (days <= 0) return null;
	return new Date(nowMs - days * DAY_MS).toISOString();
}

/** 失败原因截断到 500 字符 */
function truncateError(raw: unknown): string {
	const text = String(raw ?? '');
	return text.length > MAIL_LOG_ERROR_MAX_LENGTH ? text.slice(0, MAIL_LOG_ERROR_MAX_LENGTH) : text;
}

export interface MailLogInput {
	type: MailType;
	/** 收件人；多个用 ', ' 连接 */
	recipient: string;
	/** 实际发出的主题（模板插值后的最终字符串） */
	subject: string;
	status: MailStatus;
	/** 失败原因；成功时省略 */
	error?: string | null;
	/** 当前时间（毫秒），测试可注入 */
	nowMs?: number;
}

/**
 * 写入一行邮件日志，并顺手清理超过保留期的行。
 *
 * **绝不抛错**：任何异常只写服务端日志。发信路径的语义不能被日志改变。
 */
export async function writeMailLog(env: Bindings, input: MailLogInput): Promise<void> {
	try {
		const now = input.nowMs ?? Date.now();
		const days = await getMailLogRetentionDays(env);
		await env.MOMO_DB.prepare(
			`INSERT INTO MailLog (type, recipient, subject, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
		)
			.bind(
				input.type,
				input.recipient,
				input.subject,
				input.status,
				input.status === 'failed' ? truncateError(input.error) : null,
				new Date(now).toISOString()
			)
			.run();

		// 保留策略：顺手清掉窗口外的旧行（走 idx_ml_created）；0 = 永久保留，不清
		const cutoff = mailLogCutoff(now, days);
		if (cutoff) {
			await env.MOMO_DB.prepare('DELETE FROM MailLog WHERE created_at < ?').bind(cutoff).run();
		}
	} catch (error) {
		console.error('MailLog 写入失败（已忽略）:', error);
	}
}
