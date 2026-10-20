import { Bindings } from '../bindings';
import { getSetting } from './settings';

/**
 * 多管理员邮箱与通知收件人（契约 v1）。
 *
 * 唯一事实来源是 `doc/admin_emails.md` 与 `doc/vectors/admin-emails-v1.json`：
 *  - `admin_emails`（JSON 数组字符串，最多 10 个）是**权威列表**，列表里的人都是博主；
 *  - 旧键 `admin_email`（单邮箱）**仅在列表解析为空时**回落成单元素列表；
 *  - `notify_email`（通知收件人）必须命中列表，否则读取时回落到列表第一个。
 *
 * 归一化一律是 `trim` + 转小写；「在列表里」判定用 `admins.includes(normalize(email))`。
 */

export const ADMIN_EMAILS_KEY = 'admin_emails';
/** 旧键（单邮箱）：仅在 `admin_emails` 解析为空时回落 */
export const ADMIN_EMAIL_KEY = 'admin_email';
export const NOTIFY_EMAIL_KEY = 'notify_email';

export const MAX_ADMIN_EMAILS = 10;
export const MAX_ADMIN_EMAIL_LENGTH = 254;

/**
 * 三端共用的邮箱判定（先 trim 再校验）：
 * `^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$` 且长度 ≤ 254。
 * 刻意不做 RFC 5322 全量解析，只挡明显非法形态。
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** 六条错误文案（三端逐字一致，见 `doc/vectors/admin-emails-v1.json` 的 `errors`） */
export const ADMIN_EMAIL_ERRORS = {
	notArray: 'admin_emails 必须是 JSON 数组',
	notString: 'admin_emails 的每一项都必须是字符串',
	tooMany: 'admin_emails 最多 10 个邮箱',
	badEmail: 'admin_emails 包含非法邮箱地址',
	badNotify: 'notify_email 必须是合法的邮箱地址',
	notifyNotInList: 'notify_email 必须在管理员邮箱列表中',
} as const;

/** 归一化邮箱：trim + 转小写 */
export function normalizeEmail(raw: unknown): string {
	return String(raw ?? '').trim().toLowerCase();
}

/** 邮箱校验（先 trim 再校验，长度上限 254） */
export function isEmailAddress(raw: unknown): boolean {
	if (raw === null || raw === undefined) return false;
	const value = String(raw).trim();
	if (value.length === 0 || value.length > MAX_ADMIN_EMAIL_LENGTH) return false;
	return EMAIL_RE.test(value);
}

/**
 * 读取路径的 `admin_emails` 解析（宽容）：
 * 1. null / undefined / 空串 / 只有空白 → `[]`；
 * 2. 不是合法 JSON、或 JSON 不是数组 → `[]`；
 * 3. 非字符串项丢弃、非法邮箱丢弃、空串丢弃；
 * 4. 归一化后去重保序，截断到前 10 个。
 */
export function parseAdminEmails(stored: unknown): string[] {
	if (stored === null || stored === undefined) return [];
	const text = String(stored).trim();
	if (text === '') return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const emails: string[] = [];
	for (const entry of parsed) {
		if (typeof entry !== 'string') continue;
		const value = normalizeEmail(entry);
		if (value === '') continue;
		if (!isEmailAddress(value)) continue;
		if (emails.includes(value)) continue;
		emails.push(value);
		if (emails.length >= MAX_ADMIN_EMAILS) break;
	}
	return emails;
}

/**
 * 写入路径的 `admin_emails` 校验与归一化（严格）。
 *
 * 返回 `{ error, emails }`：`error` 非空时整批拒绝；通过时写入路径应存
 * `JSON.stringify(emails)`（归一化去重后的 JSON 数组）。
 * `null` / `undefined` 视为「未提供」（写入路径会跳过）。
 */
export function validateAdminEmails(raw: unknown): { error: string | null; emails: string[] } {
	if (raw === null || raw === undefined) return { error: null, emails: [] };
	const text = String(raw).trim();
	// trim 后为空视为「未配置」：存 []
	if (text === '') return { error: null, emails: [] };

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: ADMIN_EMAIL_ERRORS.notArray, emails: [] };
	}
	if (!Array.isArray(parsed)) {
		return { error: ADMIN_EMAIL_ERRORS.notArray, emails: [] };
	}
	for (const entry of parsed) {
		if (typeof entry !== 'string') {
			return { error: ADMIN_EMAIL_ERRORS.notString, emails: [] };
		}
	}

	const emails: string[] = [];
	for (const entry of parsed) {
		const value = normalizeEmail(entry);
		if (value === '') continue;
		if (emails.includes(value)) continue;
		emails.push(value);
	}
	if (emails.length > MAX_ADMIN_EMAILS) {
		return { error: ADMIN_EMAIL_ERRORS.tooMany, emails: [] };
	}
	for (const email of emails) {
		if (!isEmailAddress(email)) {
			return { error: ADMIN_EMAIL_ERRORS.badEmail, emails: [] };
		}
	}
	return { error: null, emails };
}

/**
 * 校验 `notify_email`：
 * - trim 后为空 = 清空（读取时回落列表第一个），永远合法；
 * - 非空时必须是合法邮箱，且归一化后必须命中管理员列表（`admins` 必须已是归一化列表）。
 */
export function validateNotifyEmail(
	raw: unknown,
	admins: string[]
): { error: string | null; value: string } {
	if (raw === null || raw === undefined) return { error: null, value: '' };
	const trimmed = String(raw).trim();
	if (trimmed === '') return { error: null, value: '' };

	const value = normalizeEmail(trimmed);
	if (!isEmailAddress(value)) {
		return { error: ADMIN_EMAIL_ERRORS.badNotify, value };
	}
	if (!admins.includes(value)) {
		return { error: ADMIN_EMAIL_ERRORS.notifyNotInList, value };
	}
	return { error: null, value };
}

export interface AdminConfig {
	/** 归一化后的管理员邮箱列表（可能为空：没有管理员） */
	admins: string[];
	/** 解析后的通知收件人（列表为空时为空串：不发通知） */
	notify: string;
}

/**
 * 读取路径归一化（宽容，三端一致）：
 *
 * ```
 * admins = parseAdminEmails(storedAdminEmails)
 * if admins 为空:
 *     legacy = normalize(storedAdminEmail)
 *     admins = isEmail(legacy) ? [legacy] : []
 * notify = normalize(storedNotifyEmail) ∈ admins ? normalize(storedNotifyEmail) : (admins[0] || "")
 * ```
 */
export function resolveAdminConfig(
	storedAdmins: unknown,
	storedLegacyAdmin: unknown,
	storedNotify: unknown
): AdminConfig {
	let admins = parseAdminEmails(storedAdmins);
	if (admins.length === 0) {
		const legacy = normalizeEmail(storedLegacyAdmin);
		admins = isEmailAddress(legacy) ? [legacy] : [];
	}
	const candidate = normalizeEmail(storedNotify);
	const notify = candidate !== '' && admins.includes(candidate) ? candidate : admins[0] || '';
	return { admins, notify };
}

/** 管理员成员判定：`admins.includes(String(email).trim().toLowerCase())` */
export function isAdminMember(admins: string[], email: unknown): boolean {
	const value = normalizeEmail(email);
	return value !== '' && admins.includes(value);
}

/** sha256 十六进制摘要（小写） */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** 每个归一化管理员邮箱的 sha256 哈希（供公开接口的 `admin_email_hashes` 下发） */
export async function adminEmailHashes(admins: string[]): Promise<string[]> {
	return await Promise.all(admins.map((email) => sha256Hex(email)));
}

/** 从数据库读取并解析管理员配置 */
export async function getAdminConfig(env: Bindings): Promise<AdminConfig> {
	const [storedAdmins, legacy, notify] = await Promise.all([
		getSetting(env, ADMIN_EMAILS_KEY),
		getSetting(env, ADMIN_EMAIL_KEY),
		getSetting(env, NOTIFY_EMAIL_KEY),
	]);
	return resolveAdminConfig(storedAdmins, legacy, notify);
}

/** 只读取解析后的通知收件人（列表为空时为空串） */
export async function getNotifyEmail(env: Bindings): Promise<string> {
	return (await getAdminConfig(env)).notify;
}

export interface AdminSettingsWriteResult {
	error: string | null;
	/** 提交了 admin_emails 且通过校验时：归一化去重后的 JSON 数组字符串 */
	adminEmailsJson?: string;
	/** 提交了 notify_email 且通过校验时：归一化后的邮箱（空串 = 清空） */
	notifyEmail?: string;
}

/**
 * 设置写入路径的联合校验（`PUT /admin/settings` 与导入接口共用）。
 *
 * 「notify_email 在列表里」判定用的列表：同一次请求里若同时提交了 `admin_emails`，
 * 用**新列表**判定；否则用**当前库里**解析出的列表。
 */
export function validateAdminSettingsBody(
	body: Record<string, unknown>,
	currentAdmins: string[]
): AdminSettingsWriteResult {
	const hasAdminEmails = 'admin_emails' in body && body.admin_emails !== null && body.admin_emails !== undefined;

	let adminEmailsJson: string | undefined;
	let effectiveAdmins = currentAdmins;
	if (hasAdminEmails) {
		const result = validateAdminEmails(body.admin_emails);
		if (result.error) return { error: result.error };
		adminEmailsJson = JSON.stringify(result.emails);
		effectiveAdmins = result.emails;
	}

	if ('notify_email' in body && body.notify_email !== null && body.notify_email !== undefined) {
		const result = validateNotifyEmail(body.notify_email, effectiveAdmins);
		if (result.error) return { error: result.error };
		return { error: null, adminEmailsJson, notifyEmail: result.value };
	}

	return { error: null, adminEmailsJson };
}
