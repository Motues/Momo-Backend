import { countCodePoints } from './security';

/**
 * 表情设置（契约 v2）的常量、写入校验与读取归一化。
 *
 * 唯一事实来源是 `doc/emoji.md` 与 `doc/vectors/emoji-v2.json`：
 * 评论区只有一个「是否启用」开关 + 一个 OwO 格式（owo.json 同构）的来源地址，
 * 由访客浏览器直接拉取，本站不代理也不存储；自定义表情包（`emoji_packs`）与
 * 公开接口 `GET /api/emoji` 已整体删除。
 *
 * 长度单位是 **Unicode 码点**（`String.length` 是 UTF-16 码元，`😂` 会算成 2）。
 */

export const EMOJI_ENABLED_KEY = 'emoji_enabled';
export const EMOJI_CDN_URL_KEY = 'emoji_cdn_url';
export const DEFAULT_EMOJI_CDN_URL = 'https://open.motues.top/emoji/owo.json';
export const DEFAULT_EMOJI_ENABLED = 'true';
export const MAX_EMOJI_CDN_URL_LENGTH = 500;

const CDN_URL_RE = /^https?:\/\/[^"<>]+$/i;

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

export interface EmojiConfig {
	/** 归一化后的来源地址；存储为空时回落默认源 */
	url: string;
	/** 归一化后的开关，只会是 "true" / "false" */
	enabled: string;
}

/**
 * 读取路径归一化（宽容，三端一致）：
 * - `url` 去掉两侧空白，空则回落默认源；
 * - `enabled` 仅当归一化后为 `"false"` 时判为关闭，其余（含空值与无法识别的历史脏值）
 *   fail-open 为启用；
 * - 关闭时地址照常下发，面板不会丢掉配置。
 */
export function resolveEmojiConfig(storedUrl: unknown, storedEnabled: unknown): EmojiConfig {
	const url = String(storedUrl ?? '').trim();
	return {
		url: url === '' ? DEFAULT_EMOJI_CDN_URL : url,
		enabled: normalizeEmojiEnabled(storedEnabled) === 'false' ? 'false' : 'true',
	};
}
