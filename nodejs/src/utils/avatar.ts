/**
 * 评论区头像来源（契约 v1，见 `doc/avatar.md` 与 `doc/vectors/avatar-v1.json`）。
 *
 * 头像由服务端按邮箱推导后随评论列表下发，不落库、不代理、不向第三方发起请求。
 * 两个设置键：
 *   - `avatar_source`：default / gravatar / cravatar / qq / custom
 *   - `avatar_custom_url`：仅 source=custom 时使用的 URL 模板
 *
 * 读取路径 **fail-open**：未知来源、空/非法模板、qq 来源下的非 QQ 邮箱，
 * 一律回落到内置默认源（历史地址），保证评论区永远有头像可用。
 *
 * 本文件与 Go `go/internal/pkg/utils/avatar.go`、Worker `worker/src/utils/avatar.ts`
 * 逐字一致；任何一端改动都必须同步另外两端与向量文件。
 */
import * as crypto from "crypto";

export const AVATAR_ENABLED_KEY = "avatar_enabled";
export const AVATAR_SOURCE_KEY = "avatar_source";
export const AVATAR_CUSTOM_URL_KEY = "avatar_custom_url";

export const DEFAULT_AVATAR_SOURCE = "default";
export const DEFAULT_AVATAR_CUSTOM_URL = "";
export const DEFAULT_AVATAR_ENABLED = "true";

/**
 * 关闭头像后统一下发的默认头像：内联 SVG（灰色人像），零外部请求。
 * 三端与 `doc/vectors/avatar-v1.json` 的 `defaultAvatarUrl` 逐字一致。
 */
export const DEFAULT_AVATAR_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIzMiIgZmlsbD0iI2U1ZTdlYiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjQiIHI9IjExIiBmaWxsPSIjOWNhM2FmIi8+PHBhdGggZD0iTTEzIDU3YzAtMTAuNSA4LjUtMTkgMTktMTlzMTkgOC41IDE5IDE5IiBmaWxsPSIjOWNhM2FmIi8+PC9zdmc+";

/** 自定义模板长度上限（按码点计，与 emoji 地址上限一致） */
export const AVATAR_URL_MAX_LENGTH = 500;

export const AVATAR_SOURCES = ["default", "gravatar", "cravatar", "qq", "custom"] as const;
export type AvatarSource = (typeof AVATAR_SOURCES)[number];

/** 四个预设模板（custom 由管理员提供） */
export const AVATAR_TEMPLATES: Record<Exclude<AvatarSource, "custom">, string> = {
  default: "https://open.motues.top/avatar?name={hash}&mode=cravatar&variant=beam",
  gravatar: "https://gravatar.com/avatar/{hash}?s=200&d=identicon",
  cravatar: "https://cravatar.cn/avatar/{hash}?s=200&d=identicon",
  qq: "https://q1.qlogo.cn/g?b=qq&nk={qq}&s=100",
};

export const AVATAR_PLACEHOLDERS = ["{hash}", "{email}", "{author}", "{qq}"] as const;

/** 三端逐字一致的错误文案（文档/向量里钉死） */
export const AVATAR_ERRORS = {
  notString: "avatar_custom_url 必须是字符串",
  badSource: "avatar_source 只能是 default / gravatar / cravatar / qq / custom",
  badScheme: "avatar_custom_url 只允许 http/https 地址",
  tooLong: `avatar_custom_url 不能超过 ${AVATAR_URL_MAX_LENGTH} 个字符`,
  controlChar: "avatar_custom_url 不能包含控制字符",
  badPlaceholder: "avatar_custom_url 包含不支持的占位符",
  emptyCustom: "选择自定义头像来源时必须填写头像地址",
  badEnabled: "avatar_enabled 只能是 true 或 false",
} as const;

export interface AvatarConfig {
  source: AvatarSource;
  template: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HTTP_SCHEME = /^https?:\/\//i;
const PLACEHOLDER_TOKEN = /\{[^{}]*\}/g;

const isAvatarSource = (value: string): value is AvatarSource =>
  (AVATAR_SOURCES as readonly string[]).includes(value);

/** 开关归一化（写入用）：trim + 小写；空串表示「未配置」 */
export function normalizeAvatarEnabled(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** 开关写入校验：只接受 "" / "true" / "false" */
export function validateAvatarEnabled(raw: unknown): string | null {
  const value = normalizeAvatarEnabled(raw);
  if (value === "" || value === "true" || value === "false") return null;
  return AVATAR_ERRORS.badEnabled;
}

/** 读取：只有明确 "false" 才算关闭，其余（含空/脏值）fail-open 为开启 */
export function isAvatarEnabled(raw: unknown): boolean {
  return normalizeAvatarEnabled(raw) !== "false";
}

/** 读取归一化：trim + 小写；未知值/空串一律回落 default */
export function normalizeAvatarSource(raw: string | null | undefined): AvatarSource {
  const value = String(raw ?? "").trim().toLowerCase();
  return isAvatarSource(value) ? value : DEFAULT_AVATAR_SOURCE;
}

/** 写入校验：空串合法（归一化为 default），未知取值返回错误文案 */
export function validateAvatarSource(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (value === "" || isAvatarSource(value)) return null;
  return AVATAR_ERRORS.badSource;
}

/** 模板字符数按码点计（与 emoji 的 500 码点口径一致） */
export function avatarCodePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * 自定义模板校验：空串合法（表示未配置）。
 * 校验顺序固定：类型 → trim → 控制字符 → 协议 → 长度 → 占位符。
 */
export function validateAvatarCustomUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return AVATAR_ERRORS.notString;
  const value = raw.trim();
  if (value === "") return null;
  if (CONTROL_CHARS.test(value)) return AVATAR_ERRORS.controlChar;
  if (!HTTP_SCHEME.test(value)) return AVATAR_ERRORS.badScheme;
  if (avatarCodePointLength(value) > AVATAR_URL_MAX_LENGTH) return AVATAR_ERRORS.tooLong;
  for (const token of value.match(PLACEHOLDER_TOKEN) ?? []) {
    if (!(AVATAR_PLACEHOLDERS as readonly string[]).includes(token)) {
      return `${AVATAR_ERRORS.badPlaceholder}：${token}`;
    }
  }
  return null;
}

export function normalizeAvatarCustomUrl(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * 写入校验（含跨键约束）：source=custom 时生效模板不能为空。
 * `stored` 用于补全本次请求没提交的另一个键。
 */
export function validateAvatarSettings(
  input: { enabled?: unknown; source?: unknown; customUrl?: unknown },
  stored: { source?: string | null; customUrl?: string | null } = {}
): string | null {
  if (input.enabled !== undefined) {
    const enabledError = validateAvatarEnabled(input.enabled);
    if (enabledError) return enabledError;
  }
  if (input.source !== undefined) {
    const sourceError = validateAvatarSource(input.source);
    if (sourceError) return sourceError;
  }
  if (input.customUrl !== undefined) {
    const customError = validateAvatarCustomUrl(input.customUrl);
    if (customError) return customError;
  }

  const sourceHasInput = input.source !== undefined;
  const customHasInput = input.customUrl !== undefined;
  if (!sourceHasInput && !customHasInput) return null;

  const effectiveSource = sourceHasInput
    ? normalizeAvatarSource(String(input.source))
    : normalizeAvatarSource(stored.source);
  const effectiveCustom = customHasInput
    ? normalizeAvatarCustomUrl(input.customUrl)
    : normalizeAvatarCustomUrl(stored.customUrl);

  if (effectiveSource === "custom" && effectiveCustom === "") {
    return AVATAR_ERRORS.emptyCustom;
  }
  return null;
}

/** 读取解析：始终返回一个可用的配置（非法输入回落内置默认源） */
export function resolveAvatarConfig(
  sourceRaw: string | null | undefined,
  customRaw: string | null | undefined
): AvatarConfig {
  const source = normalizeAvatarSource(sourceRaw);
  if (source === "custom") {
    const custom = normalizeAvatarCustomUrl(customRaw);
    if (custom !== "" && validateAvatarCustomUrl(custom) === null) {
      return { source: "custom", template: custom };
    }
    return { source: DEFAULT_AVATAR_SOURCE, template: AVATAR_TEMPLATES.default };
  }
  return { source, template: AVATAR_TEMPLATES[source] };
}

const md5Hex = (value: string): string =>
  crypto.createHash("md5").update(value).digest("hex");

const normalizeAvatarEmail = (email: string | null | undefined): string =>
  String(email ?? "").trim().toLowerCase();

/** RFC 3986：只保留非保留字符，其余 UTF-8 字节编码为 %XX（大写） */
export function avatarPercentEncode(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(String(value ?? ""), "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) {
      encoded += char;
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

const qqNumberOf = (normalizedEmail: string): string =>
  normalizedEmail.match(/^(\d+)@qq\.com$/)?.[1] ?? "";

/** 按解析后的配置生成头像地址；模板含 {qq} 但邮箱不是 QQ 时回落默认源 */
export function buildAvatarUrl(
  config: AvatarConfig,
  email: string | null | undefined,
  author: string | null | undefined
): string {
  const normalizedEmail = normalizeAvatarEmail(email);
  const qq = qqNumberOf(normalizedEmail);
  let template = config.template;
  if (template.includes("{qq}") && qq === "") {
    template = AVATAR_TEMPLATES.default;
  }
  return template.replace(/\{(hash|email|author|qq)\}/g, (_match, name: string) => {
    switch (name) {
      case "hash":
        return md5Hex(normalizedEmail);
      case "email":
        return avatarPercentEncode(normalizedEmail);
      case "author":
        return avatarPercentEncode(String(author ?? "").trim());
      default:
        return qq;
    }
  });
}

/**
 * 公开评论列表最终下发的头像：关闭开关时一律返回内置默认头像，
 * 否则按来源配置生成。开关只影响下发结果，不修改/清空已保存的来源配置。
 */
export function resolveAvatarUrl(
  enabled: boolean,
  config: AvatarConfig,
  email: string | null | undefined,
  author: string | null | undefined
): string {
  return enabled ? buildAvatarUrl(config, email, author) : DEFAULT_AVATAR_URL;
}
