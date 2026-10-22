/**
 * API 地址（`verify_base_url`）与邮箱验证开关（`email_verify_enabled`）的写入口径。
 *
 * 口径的唯一事实来源是 `doc/api.md`：API 地址属于站点基本信息，三端（Node / Go / Worker）
 * 必须逐条一致：
 *   - 空串允许（表示未配置）；
 *   - 非空必须是 `http(s)://` 开头的绝对地址，不能带 query / hash / 用户名密码；
 *   - 写入时去首尾空格与末尾 `/`。
 *
 * 依赖关系（改这里时同步改 Go / Worker）：
 *   - `email_verify_enabled = "true"` 需要 API 地址非空；
 *   - `link_sync_enabled = "true"` 需要 API 地址非空；
 *   - `link_dormant_notice_enabled = "true"` 需要 API 地址非空。
 * 后两者**不再依赖** `email_verify_enabled`（见 doc/link_security.md）。
 */

import {
  LINK_DORMANT_NOTICE_ENABLED_KEY,
  LINK_SYNC_ENABLED_KEY,
  normalizeLinkSwitch,
} from "./linkSecurity";

export const VERIFY_BASE_URL_KEY = "verify_base_url";
export const EMAIL_VERIFY_ENABLED_KEY = "email_verify_enabled";
export const MAX_VERIFY_BASE_URL_LENGTH = 500;

/** 三端逐字一致的错误文案 */
export const VERIFY_SETTINGS_ERRORS = {
  baseUrl: `${VERIFY_BASE_URL_KEY} 必须是 http(s) 开头的完整地址`,
  baseUrlTooLong: `${VERIFY_BASE_URL_KEY} 不能超过 ${MAX_VERIFY_BASE_URL_LENGTH} 个字符`,
  emailVerifyEnabled: `${EMAIL_VERIFY_ENABLED_KEY} 只能是 true 或 false`,
  emailVerifyNeedsBaseUrl: "邮箱验证开启时必须填写 API 地址",
  linkSyncNeedsBaseUrl: "历史链接同步开启时必须填写 API 地址",
  dormantNoticeNeedsBaseUrl: "休眠提醒邮件开启时必须填写 API 地址",
};

/** 写入前的归一化：去首尾空格、去末尾 `/`；空串保持空串。 */
export function normalizeVerifyBaseUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  return raw === "" ? "" : raw.replace(/\/+$/, "");
}

/** 写入校验：空串允许；否则必须是合法的 http(s) 绝对地址。 */
export function validateVerifyBaseUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  if (raw.length > MAX_VERIFY_BASE_URL_LENGTH) return VERIFY_SETTINGS_ERRORS.baseUrlTooLong;
  if (!/^https?:\/\//i.test(raw)) return VERIFY_SETTINGS_ERRORS.baseUrl;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return VERIFY_SETTINGS_ERRORS.baseUrl;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return VERIFY_SETTINGS_ERRORS.baseUrl;
  }
  if (!parsed.hostname) return VERIFY_SETTINGS_ERRORS.baseUrl;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return VERIFY_SETTINGS_ERRORS.baseUrl;
  }
  return null;
}

/** 开关归一化：只保留 true / false，其余（含空串）按空串处理。 */
export function normalizeEmailVerifyEnabled(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true" || normalized === "false") return normalized;
  return "";
}

/** 开关写入校验：只接受 "" / "true" / "false"（忽略大小写与两侧空格）。 */
export function validateEmailVerifyEnabled(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "true" || normalized === "false") return null;
  return VERIFY_SETTINGS_ERRORS.emailVerifyEnabled;
}

/**
 * 交叉校验：请求体优先、否则回落到库中现值，判断「开启某个依赖 API 地址的功能时，
 * API 地址是否为空」。
 *
 * 注意：只要请求体里带了 `verify_base_url`（即使是空串），就以请求体为准 —— 这样
 * 「清空 API 地址」会立刻被依赖功能拦住，而不是等下一次保存才发现。
 */
export function validateApiUrlDependents(
  body: Record<string, unknown>,
  stored: Record<string, string>
): string | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const pick = (key: string) => (has(key) ? body[key] : stored[key]);

  const baseUrl = normalizeVerifyBaseUrl(pick(VERIFY_BASE_URL_KEY));
  if (baseUrl !== "") return null;

  if (normalizeEmailVerifyEnabled(pick(EMAIL_VERIFY_ENABLED_KEY)) === "true") {
    return VERIFY_SETTINGS_ERRORS.emailVerifyNeedsBaseUrl;
  }
  if (normalizeLinkSwitch(pick(LINK_SYNC_ENABLED_KEY)) === "true") {
    return VERIFY_SETTINGS_ERRORS.linkSyncNeedsBaseUrl;
  }
  if (normalizeLinkSwitch(pick(LINK_DORMANT_NOTICE_ENABLED_KEY)) === "true") {
    return VERIFY_SETTINGS_ERRORS.dormantNoticeNeedsBaseUrl;
  }
  return null;
}

/** 请求体是否涉及 API 地址依赖链（用于避免无意义的全量设置查询/交叉校验）。 */
export function hasApiUrlDependencyKey(body: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(body, VERIFY_BASE_URL_KEY) ||
    Object.prototype.hasOwnProperty.call(body, EMAIL_VERIFY_ENABLED_KEY) ||
    Object.prototype.hasOwnProperty.call(body, LINK_SYNC_ENABLED_KEY) ||
    Object.prototype.hasOwnProperty.call(body, LINK_DORMANT_NOTICE_ENABLED_KEY)
  );
}
