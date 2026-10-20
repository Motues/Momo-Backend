/**
 * 后台「链接安全」页的纯逻辑（契约 v1）：开关归一化与休眠天数解析/校验。
 *
 * 唯一事实来源是 `doc/link_security.md` 与 `doc/vectors/link-security-v1.json`：
 * - 开关一律 **fail-closed**：只有归一化（trim + 小写）后等于 `"true"` 才算开启；
 * - `link_dormant_days` 只能是 1–3650 的整数，脏值读取时回退 30、超上限夹取到 3650。
 *
 * 与表情开关的 fail-open **刻意相反**：安全功能默认不生效，
 * 绝不会因为一个脏值把全站链接拦起来。
 */

/** 休眠天数默认值（`doc/link_security.md` 第 1 节） */
export const DEFAULT_LINK_DORMANT_DAYS = 30;

/** 休眠天数下限 / 上限 */
export const MIN_LINK_DORMANT_DAYS = 1;
export const MAX_LINK_DORMANT_DAYS = 3650;

/** 非法休眠天数的错误文案（与 `doc/vectors/link-security-v1.json` 的 errors 逐字一致） */
export const LINK_DORMANT_DAYS_ERROR = `link_dormant_days 必须是 ${MIN_LINK_DORMANT_DAYS}-${MAX_LINK_DORMANT_DAYS} 之间的整数`;

/** 归一化开关：只有 true（大小写/空格无关）才是 `'true'`，其余 fail-closed 为 `'false'` */
export function normalizeLinkSwitch(value) {
	return String(value ?? '').trim().toLowerCase() === 'true' ? 'true' : 'false';
}

/** 十进制无符号整数（不接受小数、负号、单位、科学计数法） */
const UNSIGNED_INT_RE = /^\d+$/;

/**
 * 读取路径（宽容）解析 `link_dormant_days`：
 * 非整数 / 小于 1 → 默认 30；大于 3650 → 夹取到 3650。
 */
export function resolveLinkDormantDays(stored) {
	const text = String(stored ?? '').trim();
	if (!UNSIGNED_INT_RE.test(text)) return DEFAULT_LINK_DORMANT_DAYS;
	const days = Number(text);
	if (days < MIN_LINK_DORMANT_DAYS) return DEFAULT_LINK_DORMANT_DAYS;
	if (days > MAX_LINK_DORMANT_DAYS) return MAX_LINK_DORMANT_DAYS;
	return days;
}

/** 写入路径（严格）校验休眠天数：返回错误文案，空串表示通过 */
export function validateLinkDormantDays(value) {
	const text = String(value ?? '').trim();
	if (!UNSIGNED_INT_RE.test(text)) return LINK_DORMANT_DAYS_ERROR;
	const days = Number(text);
	if (days < MIN_LINK_DORMANT_DAYS || days > MAX_LINK_DORMANT_DAYS) return LINK_DORMANT_DAYS_ERROR;
	return '';
}
