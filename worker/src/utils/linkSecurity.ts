import { Bindings } from '../bindings';
import { getSetting } from './settings';
import { toMillis } from './time';

/**
 * 链接安全审查（休眠链接 + 历史链接批量更新 + 休眠提醒邮件）的设置口径与数据操作。
 *
 * 唯一事实来源是 `doc/link_security.md` 与 `doc/vectors/link-security-v1.json`：
 *  - 四个设置键：`link_security_enabled` / `link_dormant_days` / `link_sync_enabled` /
 *    `link_dormant_notice_enabled`；
 *  - 开关一律 **fail-closed**（只有归一化后等于 `"true"` 才算开启）；
 *  - 天数只接受 1–3650 的整数，脏值回退 30，超上限夹取到 3650；
 *  - 休眠判定：`now - lastCommentAt > days * 86400000`（严格大于），身份标识是归一化邮箱；
 *  - 人工确认（`TrustedLink`）：`expires_at` 严格大于 now，且格式必须与写入格式逐字一致，
 *    否则 fail-closed（不豁免休眠，管理员重新确认即可）；有效确认直接豁免休眠；
 *  - 休眠提醒邮件：发信前提 = 总开关 + 提醒开关 + `email_verify_enabled`（见第 2.7 节）。
 */

export const LINK_SECURITY_ENABLED_KEY = 'link_security_enabled';
export const LINK_DORMANT_DAYS_KEY = 'link_dormant_days';
export const LINK_SYNC_ENABLED_KEY = 'link_sync_enabled';
export const LINK_DORMANT_NOTICE_ENABLED_KEY = 'link_dormant_notice_enabled';

export const DEFAULT_LINK_DORMANT_DAYS = 30;
export const MIN_LINK_DORMANT_DAYS = 1;
export const MAX_LINK_DORMANT_DAYS = 3650;
export const DAY_MS = 86400000;

/** 三个开关键（写入校验、归一化落库共用） */
export const LINK_SWITCH_KEYS = [
	LINK_SECURITY_ENABLED_KEY,
	LINK_SYNC_ENABLED_KEY,
	LINK_DORMANT_NOTICE_ENABLED_KEY,
] as const;

/** 错误文案（三端逐字一致，见 `doc/vectors/link-security-v1.json` 的 `errors`） */
export const LINK_SECURITY_ERRORS = {
	securityEnabled: 'link_security_enabled 只能是 true 或 false',
	syncEnabled: 'link_sync_enabled 只能是 true 或 false',
	dormantNoticeEnabled: 'link_dormant_notice_enabled 只能是 true 或 false',
	dormantDays: 'link_dormant_days 必须是 1-3650 之间的整数',
} as const;

/** 归一化开关：trim + 转小写（不做合法性判断，写入路径另有校验） */
export function normalizeSwitch(raw: unknown): string {
	return String(raw ?? '').trim().toLowerCase();
}

/** 设置键 → 自己的错误文案（新增开关时只改这里，避免文案串味） */
const SWITCH_ERRORS: Record<string, string> = {
	[LINK_SECURITY_ENABLED_KEY]: LINK_SECURITY_ERRORS.securityEnabled,
	[LINK_SYNC_ENABLED_KEY]: LINK_SECURITY_ERRORS.syncEnabled,
	[LINK_DORMANT_NOTICE_ENABLED_KEY]: LINK_SECURITY_ERRORS.dormantNoticeEnabled,
};

/** 开关写入校验：归一化后只能是 "" / "true" / "false"；null / undefined 视为未提供 */
export function validateSwitch(raw: unknown, key: string): string | null {
	if (raw === null || raw === undefined) return null;
	const value = normalizeSwitch(raw);
	if (value === '' || value === 'true' || value === 'false') return null;
	return SWITCH_ERRORS[key] ?? LINK_SECURITY_ERRORS.securityEnabled;
}

export interface DormantNoticeGateInput {
	/** 休眠链接总开关（存储原值） */
	securityEnabled: unknown;
	/** 休眠提醒邮件开关（存储原值） */
	noticeEnabled: unknown;
	/** API 地址（`verify_base_url`，存储原值） */
	apiBaseUrl: unknown;
}

/**
 * 休眠提醒邮件的**发信前提**（见 `doc/link_security.md` 第 2.7 节）：
 *
 * ```
 * 发信 = link_security_enabled && link_dormant_notice_enabled && verify_base_url 非空
 * ```
 *
 * 两个开关一律 fail-closed（归一化后等于 `"true"` 才算开启）；API 地址只做
 * `trim` 后非空判定 —— 没有地址就没有可用的提醒页链接，一封都不发。
 * **不再依赖 `email_verify_enabled`**：只要有 API 地址就可以发提醒邮件。
 * SMTP 可用性与 `email_enabled` 由发信函数再检查一次（不合并进本函数，便于单元测试）。
 */
export function shouldSendDormantNotice({
	securityEnabled,
	noticeEnabled,
	apiBaseUrl,
}: DormantNoticeGateInput): boolean {
	return (
		normalizeSwitch(securityEnabled) === 'true' &&
		normalizeSwitch(noticeEnabled) === 'true' &&
		String(apiBaseUrl ?? '').trim() !== ''
	);
}

/**
 * 读取路径的天数归一化（宽容）：
 * 整数且 1..3650 → 该值；大于上限 → 3650（夹取）；其余脏值 → 30。
 */
export function parseDormantDays(stored: unknown): number {
	const text = String(stored ?? '').trim();
	if (!/^\d+$/.test(text)) return DEFAULT_LINK_DORMANT_DAYS;
	const value = Number(text);
	if (!Number.isFinite(value)) return MAX_LINK_DORMANT_DAYS;
	if (value > MAX_LINK_DORMANT_DAYS) return MAX_LINK_DORMANT_DAYS;
	if (value < MIN_LINK_DORMANT_DAYS) return DEFAULT_LINK_DORMANT_DAYS;
	return value;
}

/**
 * 天数写入校验：只能是 1–3650 的整数（十进制、无符号、无小数、无单位）。
 *
 * 注意与开关的差异：fixture 的 `switches.valid` 含 `null`（视为「未提供」），
 * 而 `days.invalid` 明确把 `null` 列为非法 —— 这里按 fixture 逐条对齐。
 */
export function validateDormantDays(raw: unknown): string | null {
	if (raw === null || raw === undefined) return LINK_SECURITY_ERRORS.dormantDays;
	if (typeof raw === 'number') {
		if (!Number.isInteger(raw) || raw < MIN_LINK_DORMANT_DAYS || raw > MAX_LINK_DORMANT_DAYS) {
			return LINK_SECURITY_ERRORS.dormantDays;
		}
		return null;
	}
	const text = String(raw).trim();
	if (!/^\d+$/.test(text)) return LINK_SECURITY_ERRORS.dormantDays;
	const value = Number(text);
	if (!Number.isInteger(value) || value < MIN_LINK_DORMANT_DAYS || value > MAX_LINK_DORMANT_DAYS) {
		return LINK_SECURITY_ERRORS.dormantDays;
	}
	return null;
}

export interface DormantInput {
	/** 开关原始存储值（fail-closed：只有归一化后等于 "true" 才开启） */
	enabled: unknown;
	/** 该评论是否有个人网址（url 非空） */
	hasUrl: boolean;
	/** 天数原始存储值（内部按读取口径归一化） */
	dormantDays: unknown;
	/** 该网址归属邮箱的「最后一条评论」时间（毫秒）；查不到时为 null */
	lastCommentAt: number | null | undefined;
	/**
	 * 该网址是否有**尚未过期**的人工确认（`isTrustActive` 的结果）。
	 * `true` 时直接豁免休眠；功能关闭时仍然不标记（开关判断在前）。
	 */
	trusted?: boolean;
	/** 当前时间（毫秒），测试可注入 */
	now?: number;
}

/**
 * 休眠判定（读取时实时推导，不落库）：
 * `enabled && trusted !== true && hasUrl && lastCommentAt 存在 && now - lastCommentAt > days * 86400000`。
 * 边界严格大于；最后评论时间未知时 fail-open（不标记）；有效人工确认直接豁免。
 */
export function isUrlDormant(input: DormantInput): boolean {
	if (normalizeSwitch(input.enabled) !== 'true') return false;
	// 人工确认有效：即使在「功能关闭」时也无所谓（上面已经返回 false）
	if (input.trusted === true) return false;
	if (!input.hasUrl) return false;
	const last = toMillis(input.lastCommentAt);
	if (last === null) return false;
	const days = parseDormantDays(input.dormantDays);
	const now = input.now ?? Date.now();
	return now - last > days * DAY_MS;
}

export interface DormantNoticeInput {
	/** 该链接当前是否休眠（`isUrlDormant` 的结果，已含人工确认豁免） */
	dormant: boolean;
	/** 是否已有该 (email, url) 的提醒记录 */
	hasRecord: boolean;
	/** 已有记录是否已过期（`expires_at <= now`，由调用方用 `isTrustActive` 同口径判定） */
	recordExpired: boolean;
	/** 记录里保存的「发提醒时该邮箱的最后评论时间」（毫秒）；没有记录时为 null */
	recordLastCommentAt: number | null | undefined;
	/** 该邮箱当前的最后评论时间（毫秒） */
	currentLastCommentAt: number | null | undefined;
}

/**
 * 是否需要发休眠提醒（纯函数，见任务规范 §6 / `doc/vectors/link-security-v1.json` 的 `notice.needNotify`）：
 *
 * ```
 * 需要发提醒 = 该链接当前休眠
 *           && ( 没有任何提醒记录
 *                || 记录已过期
 *                || 记录里的 last_comment_at ≠ 当前该邮箱的最后评论时间 )
 * ```
 *
 * 含义：同一个「休眠周期」（最后评论时间没变）只提醒一次；他后来又评论过（时间变了）
 * = 新的休眠周期，要再提醒一次；记录过期后也要再提醒（并顺带刷新令牌与有效期）。
 */
export function needDormantNotice(input: DormantNoticeInput): boolean {
	if (!input.dormant) return false;
	if (!input.hasRecord) return true;
	if (input.recordExpired) return true;
	return toMillis(input.recordLastCommentAt) !== toMillis(input.currentLastCommentAt);
}

/**
 * 人工确认的到期格式：必须与写入格式 `new Date(ms).toISOString()` 逐字一致
 * （`YYYY-MM-DDTHH:mm:ss.sssZ` —— 恰好 3 位毫秒、只接受 Z）。
 *
 * 解析必须**严格**：JS 的 `Date.parse` 能吃下 `2026-11-17` 甚至数字串，Go 的
 * `time.Parse("2006-01-02T15:04:05.000Z")` 会拒绝；只按「能解析就算」两端会给出不同答案。
 */
const TRUST_EXPIRES_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 人工确认的来源：`admin`（管理员在用户列表人工确认）/ `self`（评论者本人从提醒页确认）。
 * 缺省 `admin`（与建表默认值一致）。
 */
export type TrustSource = 'admin' | 'self';

/** 归一化来源：只认 `self`，其余（含脏值 / 缺省）一律 `admin`（fail-safe 到建表默认值） */
export function normalizeTrustSource(raw: unknown): TrustSource {
	return String(raw ?? '').trim().toLowerCase() === 'self' ? 'self' : 'admin';
}

/**
 * 人工确认是否仍然有效：`expires_at` **严格大于** now。
 *
 * 格式不符 / 无法解析 → false（fail-closed：不豁免休眠，管理员重新确认即可）。
 * 与 Go `IsTrustActive` 同口径，向量见 `doc/vectors/link-security-v1.json` 的 `trust.active`。
 */
export function isTrustActive(expiresAt: unknown, nowMs: number): boolean {
	if (typeof expiresAt !== 'string' || !TRUST_EXPIRES_RE.test(expiresAt)) return false;
	const expires = Date.parse(expiresAt);
	if (!Number.isFinite(expires)) return false;
	return expires > nowMs;
}

export interface LinkSecurityConfig {
	securityEnabled: boolean;
	dormantDays: number;
	syncEnabled: boolean;
}

/** 从数据库读取并归一化链接安全设置（开关 fail-closed） */
export async function resolveLinkSecurityConfig(env: Bindings): Promise<LinkSecurityConfig> {
	const [securityEnabled, dormantDays, syncEnabled] = await Promise.all([
		getSetting(env, LINK_SECURITY_ENABLED_KEY),
		getSetting(env, LINK_DORMANT_DAYS_KEY),
		getSetting(env, LINK_SYNC_ENABLED_KEY),
	]);
	return {
		securityEnabled: normalizeSwitch(securityEnabled) === 'true',
		dormantDays: parseDormantDays(dormantDays),
		syncEnabled: normalizeSwitch(syncEnabled) === 'true',
	};
}

/**
 * 设置写入路径的联合校验（`PUT /admin/settings` 与导入接口共用）。
 * 返回第一条错误信息；通过校验返回 null。与 `validateSwitch` / `validateDormantDays` 同口径。
 */
export function validateLinkSecuritySettings(body: Record<string, unknown>): string | null {
	for (const key of LINK_SWITCH_KEYS) {
		if (key in body) {
			const error = validateSwitch(body[key], key);
			if (error) return error;
		}
	}
	if (LINK_DORMANT_DAYS_KEY in body) {
		const error = validateDormantDays(body[LINK_DORMANT_DAYS_KEY]);
		if (error) return error;
	}
	return null;
}

/* ----------------------------- LinkSyncRequest ---------------------------- */

/** 存库的 email 一律是归一化后的值（身份凭据） */
function normalizeIdentityEmail(raw: unknown): string {
	return String(raw ?? '').trim().toLowerCase();
}

/**
 * 查该邮箱「URL 非空且与本次提交不同」的历史评论（状态过滤 rejected/deleted）。
 * 返回最近一条这样的评论的 url；没有则 null（= 不满足触发条件）。
 */
export async function findHistoricalOtherUrl(
	env: Bindings,
	email: string,
	newUrl: string
): Promise<string | null> {
	const row = await env.MOMO_DB.prepare(
		`SELECT url FROM Comment
          WHERE lower(trim(email)) = ?
            AND status NOT IN ('rejected', 'deleted')
            AND url IS NOT NULL AND trim(url) != '' AND url != ?
          ORDER BY pub_date DESC
          LIMIT 1`
	)
		.bind(normalizeIdentityEmail(email), newUrl)
		.first<{ url: string }>();
	return row?.url ?? null;
}

/** 同一邮箱 + 同一 newUrl 是否已有「未过期未确认」记录（去重，不重复发信） */
export async function hasPendingLinkSync(
	env: Bindings,
	email: string,
	newUrl: string
): Promise<boolean> {
	const row = await env.MOMO_DB.prepare(
		`SELECT COUNT(*) AS count FROM LinkSyncRequest
          WHERE email = ? AND new_url = ? AND confirmed = 0
            AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
	)
		.bind(normalizeIdentityEmail(email), newUrl)
		.first<{ count: number }>();
	return (row?.count ?? 0) > 0;
}

/**
 * 作废该邮箱既有的「未确认且未过期」记录：同一邮箱只保留一条有效待确认记录，
 * 保证邮件里的旧链接立刻失效（这里直接删除，确认页不会把旧令牌误报成「已完成」）。
 */
export async function invalidatePendingLinkSync(env: Bindings, email: string): Promise<void> {
	await env.MOMO_DB.prepare(
		`DELETE FROM LinkSyncRequest
          WHERE email = ? AND confirmed = 0
            AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
	)
		.bind(normalizeIdentityEmail(email))
		.run();
}

/** 写入一条待确认记录（token 由调用方生成：crypto.randomUUID()，24 小时有效） */
export async function createLinkSyncRequest(
	env: Bindings,
	params: { email: string; newUrl: string; token: string; expiresAt: string }
): Promise<void> {
	await env.MOMO_DB.prepare(
		`INSERT INTO LinkSyncRequest (email, new_url, token, expires_at, confirmed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
	)
		.bind(
			normalizeIdentityEmail(params.email),
			params.newUrl,
			params.token,
			params.expiresAt,
			new Date().toISOString()
		)
		.run();
}

/**
 * 执行批量更新：把该邮箱**所有**历史评论的 url 改为 newUrl（只改 url，不动正文）。
 * 返回受影响行数（幂等：`url != newUrl` 的老评论才会被写）。
 */
export async function applyLinkSync(
	env: Bindings,
	email: string,
	newUrl: string
): Promise<number> {
	const result = await env.MOMO_DB.prepare(
		`UPDATE Comment SET url = ?
          WHERE lower(trim(email)) = ?
            AND status NOT IN ('rejected', 'deleted')
            AND url != ?`
	)
		.bind(newUrl, normalizeIdentityEmail(email), newUrl)
		.run();
	return result.meta.changes || 0;
}

/** 标记确认记录已使用（一次性，不可重放） */
export async function markLinkSyncConfirmed(env: Bindings, id: number): Promise<void> {
	await env.MOMO_DB.prepare('UPDATE LinkSyncRequest SET confirmed = 1 WHERE id = ?')
		.bind(id)
		.run();
}

/** 某邮箱（归一化后）的聚合链接状态 */
export interface LinkStatus {
	/** 该邮箱「最后一条评论」时间（毫秒）；只在存在非 rejected/deleted 评论时才有值 */
	lastAt: number;
	/** 最近一条「网址非空」评论的网址；从未留过链接时为 "" */
	latestUrl: string;
}

/**
 * 按「本页用户涉及的邮箱集合」一次查询每个人的「最后评论时间 + 最新非空网址」（避免 N+1）。
 *
 * 口径与公开评论区的 `urlDormant` 完全一致（`doc/link_security.md` 第 2 节）：
 *  - 身份是归一化邮箱（trim + 小写），跨文章统计，`rejected` / `deleted` 不算「来过」；
 *  - 「最新网址」= 网址非空且 pubDate 最大的那条（更晚的空网址不会清空它）；
 *  - 返回 Map<归一化邮箱, LinkStatus>；查不到的邮箱不出现在 Map 里（调用方按 null 处理）。
 *
 * 用户列表按 `linkStatus` 筛选时会把「全部用户」的邮箱传进来，因此与 `getLastCommentTimes`
 * 一样分批查询（D1 的绑定参数有上限）；每批仍是一条查询，不是 N+1。
 */
export async function getLinkStatusByEmail(
	env: Bindings,
	emails: string[]
): Promise<Map<string, LinkStatus>> {
	const result = new Map<string, LinkStatus>();
	const unique = Array.from(new Set(emails.map(normalizeIdentityEmail).filter((email) => email !== '')));
	if (unique.length === 0) return result;

	const CHUNK = 50;
	for (let start = 0; start < unique.length; start += CHUNK) {
		const chunk = unique.slice(start, start + CHUNK);
		const placeholders = chunk.map(() => '?').join(', ');
		const { results } = await env.MOMO_DB.prepare(
			`SELECT lower(trim(email)) AS email, pub_date, COALESCE(url, '') AS url
           FROM Comment
          WHERE status NOT IN ('rejected', 'deleted')
            AND lower(trim(email)) IN (${placeholders})
          ORDER BY pub_date ASC`
		)
			.bind(...chunk)
			.all<{ email: string; pub_date: unknown; url: string | null }>();

		// 升序遍历：最后一条决定 lastAt；只在网址非空时覆盖 latestUrl（「以最新链接为准」）
		for (const row of results || []) {
			const key = normalizeIdentityEmail(row.email);
			const at = toMillis(row.pub_date);
			const url = String(row.url ?? '').trim();
			const current = result.get(key);
			result.set(key, {
				lastAt: at ?? current?.lastAt ?? 0,
				latestUrl: url !== '' ? url : current?.latestUrl ?? '',
			});
		}
	}
	return result;
}

/**
 * 按「本页评论涉及的邮箱集合」一次分组查询每个人的最后评论时间（避免 N+1）。
 * 口径：`status NOT IN ('rejected','deleted')`（pending 也算「来过」），全部文章跨文章统计。
 * 返回 Map<归一化邮箱, 毫秒时间戳>；查不到的邮箱不出现在 Map 里（调用方按 null 处理）。
 */
export async function getLastCommentTimes(
	env: Bindings,
	emails: string[]
): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	const unique = Array.from(new Set(emails.map(normalizeIdentityEmail).filter((email) => email !== '')));
	if (unique.length === 0) return result;

	// D1 的绑定参数有上限，分批查询；每批仍然是一条分组查询（不是 N+1）
	const CHUNK = 50;
	for (let start = 0; start < unique.length; start += CHUNK) {
		const chunk = unique.slice(start, start + CHUNK);
		const placeholders = chunk.map(() => '?').join(', ');
		const { results } = await env.MOMO_DB.prepare(
			`SELECT lower(trim(email)) AS email, MAX(pub_date) AS last_pub_date
               FROM Comment
              WHERE lower(trim(email)) IN (${placeholders})
                AND status NOT IN ('rejected', 'deleted')
              GROUP BY lower(trim(email))`
		)
			.bind(...chunk)
			.all<{ email: string; last_pub_date: unknown }>();

		for (const row of results || []) {
			const last = toMillis(row.last_pub_date);
			if (last !== null) result.set(row.email, last);
		}
	}
	return result;
}

/* ------------------------------- TrustedLink ------------------------------- */

/**
 * 写入 / 刷新一条人工确认（幂等 upsert）。
 *
 * 同一 `(email, url)` 只保留一行：已有记录则刷新 `expires_at`、`created_at`
 * 与 `source`（`created_at` 即本次确认时刻）。唯一索引 `idx_tl_email_url` 让 `ON CONFLICT` 可用。
 */
export async function upsertTrustedLink(
	env: Bindings,
	params: { email: string; url: string; expiresAt: string; createdAt: string; source: TrustSource }
): Promise<void> {
	await env.MOMO_DB.prepare(
		`INSERT INTO TrustedLink (email, url, expires_at, created_at, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email, url) DO UPDATE SET
           expires_at = excluded.expires_at,
           created_at = excluded.created_at,
           source = excluded.source`
	)
		.bind(
			normalizeIdentityEmail(params.email),
			params.url,
			params.expiresAt,
			params.createdAt,
			params.source
		)
		.run();
}

/** 撤销一条人工确认；返回是否真的删掉了一行（本来就没有 → false） */
export async function revokeTrustedLink(env: Bindings, email: string, url: string): Promise<boolean> {
	const result = await env.MOMO_DB.prepare('DELETE FROM TrustedLink WHERE email = ? AND url = ?')
		.bind(normalizeIdentityEmail(email), url)
		.run();
	return (result.meta.changes || 0) > 0;
}

/** 一条「未过期」的人工确认（供用户列表下发 `urlTrustedUntil` / `urlTrustedSource`） */
export interface ActiveTrust {
	/** 到期时间（ISO 8601 UTC，原样下发） */
	expiresAt: string;
	/** 确认来源：`admin` / `self`（脏值归一化为 `admin`） */
	source: TrustSource;
}

/**
 * 按「本页涉及的邮箱集合」一次查询每个人名下**未过期**的人工确认（避免 N+1）。
 *
 * 返回 `Map<归一化邮箱, Map<url, ActiveTrust>>`：外层键是归一化邮箱，
 * 内层用「逐字相等」的 url 定位（写入端的 url 都已过 `sanitizeUrl`）。
 * 查不到的邮箱不出现在 Map 里（调用方按「没有确认」处理）。
 *
 * 读取判定与 `isTrustActive` 完全一致：SQL 只用字典序粗筛（写入格式固定为 ISO），
 * 脏格式 / 边界值再由 `isTrustActive` 兜底，保证 fail-closed。
 */
export async function getActiveTrustsByEmail(
	env: Bindings,
	emails: string[],
	nowMs: number
): Promise<Map<string, Map<string, ActiveTrust>>> {
	const result = new Map<string, Map<string, ActiveTrust>>();
	const unique = Array.from(new Set(emails.map(normalizeIdentityEmail).filter((email) => email !== '')));
	if (unique.length === 0) return result;

	const nowIso = new Date(nowMs).toISOString();
	// D1 的绑定参数有上限，分批查询；每批仍然是一条查询（不是 N+1）
	const CHUNK = 50;
	for (let start = 0; start < unique.length; start += CHUNK) {
		const chunk = unique.slice(start, start + CHUNK);
		const placeholders = chunk.map(() => '?').join(', ');
		const { results } = await env.MOMO_DB.prepare(
			`SELECT lower(trim(email)) AS email, url, expires_at, source
               FROM TrustedLink
              WHERE lower(trim(email)) IN (${placeholders})
                AND expires_at > ?`
		)
			.bind(...chunk, nowIso)
			.all<{ email: string; url: string | null; expires_at: string; source: string | null }>();

		for (const row of results || []) {
			if (!isTrustActive(row.expires_at, nowMs)) continue;
			const key = normalizeIdentityEmail(row.email);
			const byUrl = result.get(key) ?? new Map<string, ActiveTrust>();
			result.set(key, byUrl);
			byUrl.set(String(row.url ?? ''), {
				expiresAt: row.expires_at,
				source: normalizeTrustSource(row.source),
			});
		}
	}
	return result;
}
