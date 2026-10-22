import { Bindings } from '../bindings';
import { normalizeEmail } from './adminEmails';
import { sendDormantNoticeEmail } from './email';
import { getSetting } from './settings';
import {
	DAY_MS,
	LINK_DORMANT_NOTICE_ENABLED_KEY,
	LINK_SECURITY_ENABLED_KEY,
	isTrustActive,
	needDormantNotice,
	shouldSendDormantNotice,
} from './linkSecurity';
import { VERIFY_BASE_URL_KEY } from './verifySettings';
import type { WaitUntil } from './verifyRecord';

/**
 * 休眠链接提醒（DormantNotice）的状态机与惰性检测（见任务规范 §4 / §8）。
 *
 * 本仓库三端都没有定时任务，休眠本身就是「读取时实时推导」；因此提醒也在**公开评论列表**
 * 的构建路径里惰性触发：本页里 `urlDormant === true` 的评论按 (归一化邮箱, url) 去重后，
 * 用 `needDormantNotice` 判断谁需要提醒，再**异步**执行「发提醒邮件 → 成功才 upsert 记录」。
 *
 * 关键口径：
 *  - 同一个「休眠周期」（最后评论时间没变）只提醒一次；时间变了或记录过期 → 再提醒一次；
 *  - 发信函数在 SMTP 未配置 / 邮件通知关闭时返回 `null` → **不落记录**，下次读取会重试；
 *  - 任何异常只写服务端日志，**绝不影响评论列表响应**。
 */

/** 提醒页路径（邮件里的按钮与明文 URL 都指向它） */
export const DORMANT_NOTICE_PATH = '/api/link-dormant/notice';

/**
 * 单个请求最多发出的休眠提醒邮件数。
 *
 * 老站点第一次开启这个功能时，历史上可能一下子有几十条链接同时「已经休眠」；
 * 不设上限就会在第一次有人访问评论区时群发几十封邮件（容易被 SMTP 判成垃圾发信）。
 * 因此先把「这次该发」的候选筛出来，再按上限截断，其余留给后续请求 ——
 * 状态机保证不会重复提醒同一次休眠，所以只是分几次完成。
 */
export const MAX_DORMANT_NOTICES_PER_REQUEST = 3;

/** 一次提醒的候选：本页里被判为休眠的评论（调用方已按 (email, url) 去重） */
export interface DormantNoticeCandidate {
	/** 归一化（trim + 小写）邮箱 */
	email: string;
	/** 触发休眠的网址（评论里 trim 后的逐字值） */
	url: string;
	/** 评论者昵称（邮件问候语） */
	author: string;
	/** 该邮箱「最后一条评论」的毫秒时间戳 */
	lastCommentAt: number;
}

export interface DormantNoticeRow {
	id: number;
	email: string;
	url: string;
	last_comment_at: number;
	token: string;
	expires_at: string;
	notified_at: string;
	notify_count: number;
}

/** (email, url) 的复合键（与 idx_dn_email_url 口径一致） */
function pairKey(email: unknown, url: unknown): string {
	return `${normalizeEmail(email)}\n${String(url ?? '').trim()}`;
}

/**
 * 一次（分批）取回这些 (email, url) 的提醒记录，返回 `Map<复合键, 行>`。
 *
 * D1 的绑定参数有上限，因此按对分批（每批 25 对 = 50 个参数）；每批仍是一条查询，不是 N+1。
 */
export async function getDormantNoticesByEmailUrl(
	env: Bindings,
	pairs: { email: string; url: string }[]
): Promise<Map<string, DormantNoticeRow>> {
	const result = new Map<string, DormantNoticeRow>();
	const unique = new Map<string, { email: string; url: string }>();
	for (const pair of pairs) {
		const email = normalizeEmail(pair.email);
		const url = String(pair.url ?? '').trim();
		if (!email || !url) continue;
		unique.set(pairKey(email, url), { email, url });
	}
	if (unique.size === 0) return result;

	const entries = Array.from(unique.values());
	const CHUNK = 25;
	for (let start = 0; start < entries.length; start += CHUNK) {
		const chunk = entries.slice(start, start + CHUNK);
		const where = chunk.map(() => '(email = ? AND url = ?)').join(' OR ');
		const args = chunk.flatMap((entry) => [entry.email, entry.url]);
		const { results } = await env.MOMO_DB.prepare(
			`SELECT * FROM DormantNotice WHERE ${where}`
		)
			.bind(...args)
			.all<DormantNoticeRow>();

		for (const row of results || []) {
			result.set(pairKey(row.email, row.url), row);
		}
	}
	return result;
}

/** 按令牌读取一条提醒记录（提醒页 / 确认 / 更新端点共用） */
export async function getDormantNoticeByToken(
	env: Bindings,
	token: string
): Promise<DormantNoticeRow | null> {
	if (!token) return null;
	return await env.MOMO_DB.prepare('SELECT * FROM DormantNotice WHERE token = ?')
		.bind(token)
		.first<DormantNoticeRow>();
}

/** 删除一条提醒记录（两个动作都是一次性的：完成后同一 token 再访问即「已失效或已处理」） */
export async function deleteDormantNoticeById(env: Bindings, id: number): Promise<void> {
	await env.MOMO_DB.prepare('DELETE FROM DormantNotice WHERE id = ?').bind(id).run();
}

/**
 * upsert 一条提醒记录：`token` 换新的、`expires_at` = 现在 + N 天、`notified_at` = 现在、
 * `notify_count` = 已有值 + 1（没有记录时为 1）。
 */
export async function upsertDormantNotice(
	env: Bindings,
	params: {
		email: string;
		url: string;
		lastCommentAt: number;
		token: string;
		expiresAt: string;
		notifiedAt: string;
	}
): Promise<void> {
	await env.MOMO_DB.prepare(
		`INSERT INTO DormantNotice (email, url, last_comment_at, token, expires_at, notified_at, notify_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(email, url) DO UPDATE SET
           last_comment_at = excluded.last_comment_at,
           token = excluded.token,
           expires_at = excluded.expires_at,
           notified_at = excluded.notified_at,
           notify_count = DormantNotice.notify_count + 1`
	)
		.bind(
			normalizeEmail(params.email),
			params.url,
			params.lastCommentAt,
			params.token,
			params.expiresAt,
			params.notifiedAt
		)
		.run();
}

/**
 * 惰性检测（任务规范 §8.1）：对候选逐个判断是否需要提醒，需要的就异步发信 + 落记录。
 *
 * 调用方（`getComments`）只在 `link_security_enabled === "true"` 时调用，并已按
 * (email, url) 收集好本页休眠评论；这里再做一次同请求内去重，保证同一对只处理一次。
 *
 * - **发信前提**（doc/link_security.md 第 2.7 节）：总开关 + 休眠提醒开关 + API 地址非空才发信，
 *   任一不满足直接返回（连 DormantNotice 都不查）：打开提醒开关后第一次有人访问评论区才开始提醒；
 *   不再依赖 `email_verify_enabled`。
 * - 发信函数在 SMTP 未配置 / 邮件通知关闭 / 发送失败时返回 `null` → **不落记录**，下次读取重试；
 * - 只有真正发出去（拿到返回）才 upsert 记录：换新令牌、刷新有效期、`notify_count` +1。
 */
export async function sweepDormantNotices(
	env: Bindings,
	candidates: DormantNoticeCandidate[],
	params: { baseUrl: string; dormantDays: number },
	waitUntil: WaitUntil | undefined
): Promise<void> {
	try {
		const [securityEnabled, noticeEnabled, apiBaseUrl] = await Promise.all([
			getSetting(env, LINK_SECURITY_ENABLED_KEY),
			getSetting(env, LINK_DORMANT_NOTICE_ENABLED_KEY),
			getSetting(env, VERIFY_BASE_URL_KEY),
		]);
		if (!shouldSendDormantNotice({ securityEnabled, noticeEnabled, apiBaseUrl })) {
			return;
		}
		// 同一次请求里同一 (email, url) 只处理一次
		const unique = new Map<string, DormantNoticeCandidate>();
		for (const candidate of candidates) {
			const email = normalizeEmail(candidate.email);
			const url = String(candidate.url ?? '').trim();
			if (!email || !url) continue;
			const key = pairKey(email, url);
			if (!unique.has(key)) unique.set(key, { ...candidate, email, url });
		}
		if (unique.size === 0) return;

		// 一次（分批）取回这些 (email, url) 的提醒记录
		const entries = Array.from(unique.values());
		const records = await getDormantNoticesByEmailUrl(env, entries);

		const now = Date.now();
		const baseUrl = params.baseUrl.replace(/\/+$/, '');

		// 先筛出「这次该发」的候选，再按单请求上限截断（其余留给后续请求）
		const pending: DormantNoticeCandidate[] = [];
		for (const candidate of entries) {
			const record = records.get(pairKey(candidate.email, candidate.url));
			const needed = needDormantNotice({
				// 候选来自本页 `urlDormant === true` 的评论
				dormant: true,
				hasRecord: !!record,
				recordExpired: record ? !isTrustActive(record.expires_at, now) : false,
				recordLastCommentAt: record?.last_comment_at ?? null,
				currentLastCommentAt: candidate.lastCommentAt,
			});
			if (needed) pending.push(candidate);
		}

		for (const candidate of pending.slice(0, MAX_DORMANT_NOTICES_PER_REQUEST)) {
			const token = crypto.randomUUID();
			const noticeUrl = `${baseUrl}${DORMANT_NOTICE_PATH}?token=${encodeURIComponent(token)}`;

			const task = (async () => {
				try {
					// 发信函数在 SMTP 未配置 / 邮件通知关闭时返回 null → 不落记录，下次读取重试
					const info = await sendDormantNoticeEmail(env, {
						toEmail: candidate.email,
						toName: candidate.author,
						url: candidate.url,
						noticeUrl,
						dormantDays: params.dormantDays,
					});
					if (!info) return;

					await upsertDormantNotice(env, {
						email: candidate.email,
						url: candidate.url,
						lastCommentAt: candidate.lastCommentAt,
						token,
						expiresAt: new Date(Date.now() + params.dormantDays * DAY_MS).toISOString(),
						notifiedAt: new Date().toISOString(),
					});
				} catch (error) {
					// 任何异常只写服务端日志，绝不影响评论列表响应
					console.error('[dormant] 发送休眠提醒失败（已忽略）:', error);
				}
			})();

			if (waitUntil) waitUntil(task);
			else void task;
		}
	} catch (error) {
		console.error('[dormant] 休眠提醒惰性检测失败（已忽略）:', error);
	}
}
