/**
 * 后台「基本设置」里管理员邮箱列表的纯逻辑（契约 v1）。
 *
 * 唯一事实来源是 `doc/admin_emails.md`：
 * - `admin_emails`（JSON 数组字符串，最多 10 个）是管理员列表；
 * - 旧键 `admin_email`（单邮箱）仅在列表为空时回落；
 * - `notify_email` 必须命中列表，否则读取时回落到列表第一个。
 *
 * 归一化一律是 `trim` + 转小写（与后端三端一致）。
 */

/** 列表长度上限（与后端一致） */
export const ADMIN_EMAIL_MAX = 10;

/** 邮箱长度上限（与后端一致） */
export const ADMIN_EMAIL_MAX_LENGTH = 254;

/** 邮箱判定：与 `doc/admin_emails.md` 第 2 节逐字一致（不做 RFC 5322 全量解析） */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** 面板侧文案：数量超限（后端为 `admin_emails 最多 10 个邮箱`，这里用更直白的提示） */
export const ADMIN_EMAIL_TOO_MANY = `最多 ${ADMIN_EMAIL_MAX} 个管理员邮箱`;

/** 面板侧文案：邮箱不合法 */
export const ADMIN_EMAIL_INVALID = '请输入合法的邮箱地址';

/** 面板侧文案：重复（不区分大小写） */
export const ADMIN_EMAIL_DUPLICATE = '该邮箱已在列表中';

/** 归一化：trim + 转小写 */
export function normalizeEmail(value) {
	return String(value ?? '').trim().toLowerCase();
}

/** 是否合法邮箱（先 trim，再按长度与正则判定） */
export function isValidEmail(value) {
	const email = String(value ?? '').trim();
	if (email === '' || email.length > ADMIN_EMAIL_MAX_LENGTH) return false;
	return EMAIL_RE.test(email);
}

/**
 * 读取路径（宽容）解析 `admin_emails`：容错规则同 `doc/admin_emails.md` 第 4 节。
 *
 * 非字符串项丢弃、非法邮箱丢弃、空串丢弃，归一化后去重保序，截断到前 10 个；
 * 列表为空时回落到旧键 `admin_email`（合法才用，否则视为没有管理员）。
 */
export function parseAdminEmails(raw, legacyEmail = '') {
	const list = [];
	const push = (value) => {
		if (typeof value !== 'string') return;
		const email = normalizeEmail(value);
		if (!isValidEmail(email)) return;
		if (list.includes(email)) return;
		if (list.length >= ADMIN_EMAIL_MAX) return;
		list.push(email);
	};

	const text = String(raw ?? '').trim();
	if (text !== '') {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = null;
		}
		if (Array.isArray(parsed)) parsed.forEach(push);
	}

	if (list.length === 0) push(String(legacyEmail ?? '').trim());
	return list;
}

/** 归一化 `notify_email`：命中列表就用它，否则回落到列表第一个（列表为空 → 空串） */
export function resolveNotifyEmail(stored, list) {
	const notify = normalizeEmail(stored);
	if (Array.isArray(list) && list.includes(notify)) return notify;
	return (Array.isArray(list) && list[0]) || '';
}

/**
 * 往列表里加一个邮箱（列表编辑器用）。返回 `{ list, error }`：
 * - 输入 trim 后为空 → 原样返回、无错误（调用方自行决定是否清空输入框）；
 * - 非法邮箱 → `ADMIN_EMAIL_INVALID`；
 * - 重复（不区分大小写）→ `ADMIN_EMAIL_DUPLICATE`；
 * - 已达 10 个 → `ADMIN_EMAIL_TOO_MANY`。
 *
 * 成功时返回**新数组**（不做原地修改，便于 Vue 响应式与测试断言）。
 */
export function addAdminEmail(list, raw) {
	const current = Array.isArray(list) ? list : [];
	const email = normalizeEmail(raw);
	if (email === '') return { list: current, error: '' };
	if (!isValidEmail(email)) return { list: current, error: ADMIN_EMAIL_INVALID };
	if (current.includes(email)) return { list: current, error: ADMIN_EMAIL_DUPLICATE };
	if (current.length >= ADMIN_EMAIL_MAX) return { list: current, error: ADMIN_EMAIL_TOO_MANY };
	return { list: [...current, email], error: '' };
}
