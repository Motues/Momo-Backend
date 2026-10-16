import { countCodePoints } from "./security";

/**
 * 表情配置（OwO 来源地址 + 启用开关）的校验与归一化。
 *
 * 口径的唯一事实来源是 `doc/emoji.md`：Node / Go / Worker 三端必须逐条一致，
 * 否则同一份配置在不同部署形态下会出现「一端能存、另一端 400」或「下发值不同」。
 * 跨语言固定向量见 `doc/vectors/emoji-v2.json`（三端读同一份 fixture 各自复算）。
 *
 * 契约 v2 起，v1 的「自定义表情包」（`emoji_packs`）与公开接口 `GET /api/emoji`
 * 已整体删除：评论区只有一个由管理员配置的 OwO 格式来源，由访客浏览器直接拉取。
 */

export const EMOJI_ENABLED_KEY = "emoji_enabled";
export const EMOJI_CDN_URL_KEY = "emoji_cdn_url";
export const DEFAULT_EMOJI_CDN_URL = "https://open.motues.top/emoji/owo.json";
export const DEFAULT_EMOJI_ENABLED = "true";
export const MAX_EMOJI_CDN_URL_LENGTH = 500;

const CDN_URL_RE = /^https?:\/\/[^"<>]+$/i;

/** 归一化启用开关：trim + 转小写（写入时存归一化后的值） */
export function normalizeEmojiEnabled(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** 校验 `emoji_enabled`：归一化后只允许 `""` / `"true"` / `"false"` */
export function validateEmojiEnabled(raw: unknown): string | null {
  const value = normalizeEmojiEnabled(raw);
  if (value === "" || value === "true" || value === "false") return null;
  return "emoji_enabled 只能是 true 或 false";
}

/** 校验 `emoji_cdn_url`：空串表示「未配置」，读取时回落默认源 */
export function validateEmojiCdnUrl(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  if (value === "") return null;
  if (countCodePoints(value) > MAX_EMOJI_CDN_URL_LENGTH) {
    return `emoji_cdn_url 不能超过 ${MAX_EMOJI_CDN_URL_LENGTH} 个字符`;
  }
  if (!CDN_URL_RE.test(value)) return "emoji_cdn_url 只允许 http/https 地址";
  return null;
}

export interface EmojiConfig {
  /** 下发给前端的有效地址：存储为空/缺失时回落默认源 */
  url: string;
  /** `"true"` / `"false"`：只有归一化后等于 `"false"` 才算关闭，其余 fail-open 为启用 */
  enabled: string;
}

/**
 * 读取路径归一化：把存储值换算成下发给前端的两个字段（三端一致，见 doc/emoji.md 第 3.2 节）。
 *
 * - 地址：`trim` 后为空（未配置 / 历史空串）→ 默认源；
 * - 开关：空或无法识别的值 → 启用（fail-open），仅 `false`（大小写不敏感）判为关闭；
 * - **关闭时地址照常下发**：后台面板据此保留配置，不会因为关一下就丢掉地址。
 */
export function resolveEmojiConfig(
  storedUrl: string | null | undefined,
  storedEnabled: string | null | undefined
): EmojiConfig {
  return {
    url: String(storedUrl ?? "").trim() || DEFAULT_EMOJI_CDN_URL,
    enabled: normalizeEmojiEnabled(storedEnabled) === "false" ? "false" : "true",
  };
}
