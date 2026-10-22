/**
 * 「API 地址」（`verify_base_url`）的纯逻辑：归一化与校验。
 *
 * 口径与后端三端一致（`doc/api.md`）：
 * - 空串允许（表示未配置）；
 * - 非空必须是 `http(s)://` 开头的绝对地址，不能带 query / hash / 用户名密码；
 * - 保存前去首尾空格与末尾 `/`。
 */

export const MAX_BASE_URL_LENGTH = 500;

export const BASE_URL_ERROR = 'API 地址必须是 http(s) 开头的完整地址';
export const BASE_URL_TOO_LONG = `API 地址不能超过 ${MAX_BASE_URL_LENGTH} 个字符`;

/** 归一化：去首尾空格、去末尾 `/`；空串保持空串 */
export function normalizeBaseUrl(value) {
	const raw = String(value ?? '').trim();
	return raw === '' ? '' : raw.replace(/\/+$/, '');
}

/** 校验：返回错误文案，合法或空串返回空串 */
export function validateBaseUrl(value) {
	const raw = String(value ?? '').trim();
	if (raw === '') return '';
	if (raw.length > MAX_BASE_URL_LENGTH) return BASE_URL_TOO_LONG;
	if (!/^https?:\/\//i.test(raw)) return BASE_URL_ERROR;

	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return BASE_URL_ERROR;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return BASE_URL_ERROR;
	if (!parsed.hostname) return BASE_URL_ERROR;
	if (parsed.username || parsed.password || parsed.search || parsed.hash) return BASE_URL_ERROR;
	return '';
}
