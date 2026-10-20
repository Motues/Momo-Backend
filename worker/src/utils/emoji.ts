import { countCodePoints } from './security';

/**
 * 表情设置（契约 v3：多来源）的常量、写入校验与读取归一化。
 *
 * 唯一事实来源是 `doc/emoji.md` 与 `doc/vectors/emoji-v3.json`（v2 的单来源 fixture
 * 仍然兼容）。契约 v3 在 v2 的基础上新增 `emoji_cdn_urls`（JSON 数组字符串，最多 5 个
 * OwO 格式地址，按数组顺序拼接合并）；旧的单地址键 `emoji_cdn_url` **仅在数组解析为空时**
 * 作为回落，保证升级前后行为一致。
 *
 * 长度单位是 **Unicode 码点**（`String.length` 是 UTF-16 码元，`😂` 会算成 2）。
 */

export const EMOJI_ENABLED_KEY = 'emoji_enabled';
/** 旧键（单地址）：仅在 `emoji_cdn_urls` 解析为空时回落 */
export const EMOJI_CDN_URL_KEY = 'emoji_cdn_url';
/** 新键（多地址）：JSON 数组字符串 */
export const EMOJI_CDN_URLS_KEY = 'emoji_cdn_urls';
export const DEFAULT_EMOJI_CDN_URL = 'https://open.motues.top/emoji/owo.json';
export const DEFAULT_EMOJI_ENABLED = 'true';
export const MAX_EMOJI_CDN_URL_LENGTH = 500;
export const MAX_EMOJI_CDN_URLS = 5;

const CDN_URL_RE = /^https?:\/\/[^"<>]+$/i;

/**
 * `emoji_cdn_urls` 的五条错误文案（三端逐字一致，见 `doc/vectors/emoji-v3.json` 的 `errors`）。
 */
export const EMOJI_CDN_URLS_ERRORS = {
	notArray: 'emoji_cdn_urls 必须是 JSON 数组',
	notString: 'emoji_cdn_urls 的每一项都必须是字符串',
	tooMany: 'emoji_cdn_urls 最多 5 个地址',
	badScheme: 'emoji_cdn_urls 只允许 http/https 地址',
	tooLong: 'emoji_cdn_urls 不能超过 500 个字符',
} as const;

/** 归一化 `emoji_enabled`：trim + 转小写。写入时存的就是这个值。 */
export function normalizeEmojiEnabled(raw: unknown): string {
	return String(raw ?? '').trim().toLowerCase();
}

/**
 * 校验 `emoji_enabled`：归一化后只能是 "" / "true" / "false"。
 * 返回错误信息；通过校验返回 null。空串表示「未配置」，视为合法。
 */
export function validateEmojiEnabled(raw: unknown): string | null {
	const value = normalizeEmojiEnabled(raw);
	if (value === '' || value === 'true' || value === 'false') return null;
	return 'emoji_enabled 只能是 true 或 false';
}

/** 校验 `emoji_cdn_url`：trim 后空串表示「未配置」，否则必须是 http/https 且不超过 500 码点 */
export function validateEmojiCdnUrl(raw: unknown): string | null {
	const value = String(raw ?? '').trim();
	if (value === '') return null;
	if (countCodePoints(value) > MAX_EMOJI_CDN_URL_LENGTH) {
		return `emoji_cdn_url 不能超过 ${MAX_EMOJI_CDN_URL_LENGTH} 个字符`;
	}
	if (!CDN_URL_RE.test(value)) return 'emoji_cdn_url 只允许 http/https 地址';
	return null;
}

/**
 * 读取路径的 `emoji_cdn_urls` 解析（宽容）。
 *
 * 历史脏值不能让面板/评论区整体不可用，因此：
 * 1. null / undefined / 空串 / 只有空白 → `[]`；
 * 2. 不是合法 JSON、或 JSON 不是数组 → `[]`；
 * 3. 数组里非字符串项直接丢弃、字符串项 trim 后为空的丢弃；
 * 4. 结果截断到前 5 个（顺序保持）。
 */
export function parseEmojiCdnUrlsRead(stored: unknown): string[] {
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

	const urls: string[] = [];
	for (const entry of parsed) {
		if (typeof entry !== 'string') continue;
		const value = entry.trim();
		if (value === '') continue;
		urls.push(value);
		if (urls.length >= MAX_EMOJI_CDN_URLS) break;
	}
	return urls;
}

/**
 * 写入路径的 `emoji_cdn_urls` 校验与归一化（严格）。
 *
 * 返回 `{ error, urls }`：`error` 非空时必须整批拒绝（400 且不落库）；
 * 通过时 `urls` 是 trim + 去空后的地址列表，写入路径应存 `JSON.stringify(urls)`。
 * `null` / `undefined` 视为「未提供」（写入路径会跳过）。
 */
export function validateEmojiCdnUrls(raw: unknown): { error: string | null; urls: string[] } {
	if (raw === null || raw === undefined) return { error: null, urls: [] };
	const text = String(raw).trim();
	// trim 后为空视为「未配置」：存 []
	if (text === '') return { error: null, urls: [] };

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: EMOJI_CDN_URLS_ERRORS.notArray, urls: [] };
	}
	if (!Array.isArray(parsed)) {
		return { error: EMOJI_CDN_URLS_ERRORS.notArray, urls: [] };
	}
	for (const entry of parsed) {
		if (typeof entry !== 'string') {
			return { error: EMOJI_CDN_URLS_ERRORS.notString, urls: [] };
		}
	}

	const urls: string[] = [];
	for (const entry of parsed) {
		const value = entry.trim();
		if (value !== '') urls.push(value);
	}
	if (urls.length > MAX_EMOJI_CDN_URLS) {
		return { error: EMOJI_CDN_URLS_ERRORS.tooMany, urls: [] };
	}
	for (const url of urls) {
		if (countCodePoints(url) > MAX_EMOJI_CDN_URL_LENGTH) {
			return { error: EMOJI_CDN_URLS_ERRORS.tooLong, urls: [] };
		}
		if (!CDN_URL_RE.test(url)) {
			return { error: EMOJI_CDN_URLS_ERRORS.badScheme, urls: [] };
		}
	}
	return { error: null, urls };
}

export interface EmojiConfig {
	/** 归一化后的来源地址；存储为空时回落默认源 */
	url: string;
	/** 归一化后的开关，只会是 "true" / "false" */
	enabled: string;
}

export interface EmojiSettings extends EmojiConfig {
	/** 解析后的来源地址列表（至少 1 个）；`url` 恒等于 `urls[0]` */
	urls: string[];
}

/**
 * 读取路径归一化（契约 v3，宽容，三端一致）：
 *
 * ```
 * urls    = parseRead(storedUrls)                  # 最多取前 5 个
 * if urls 为空:
 *     legacy = trim(storedCdnUrl)                  # 旧键回落
 *     urls = legacy == "" ? [DEFAULT] : [legacy]
 * enabled = (trim+小写(storedEnabled) === "false") ? "false" : "true"
 * ```
 *
 * 关闭时地址照常下发（面板不会丢掉配置）。
 */
export function resolveEmojiSettings(
	storedUrls: unknown,
	storedCdnUrl: unknown,
	storedEnabled: unknown
): EmojiSettings {
	let urls = parseEmojiCdnUrlsRead(storedUrls);
	if (urls.length === 0) {
		const legacy = String(storedCdnUrl ?? '').trim();
		urls = legacy === '' ? [DEFAULT_EMOJI_CDN_URL] : [legacy];
	}
	return {
		urls,
		url: urls[0],
		enabled: normalizeEmojiEnabled(storedEnabled) === 'false' ? 'false' : 'true',
	};
}

/**
 * 契约 v2 的读取口径（单地址）：保留给旧调用方与 v2 fixture 使用。
 * 等价于 `resolveEmojiSettings('', storedUrl, storedEnabled)` 去掉数组部分。
 */
export function resolveEmojiConfig(storedUrl: unknown, storedEnabled: unknown): EmojiConfig {
	const resolved = resolveEmojiSettings('', storedUrl, storedEnabled);
	return { url: resolved.url, enabled: resolved.enabled };
}
