/**
 * 数据统计页的**客户端分布**口径：把 `Comment.browser` / `Comment.os` / `Comment.device`
 * 的原始值归一化成展示用的「家族名」。
 *
 * 为什么需要归一化：这三列存的是 ua-parser 的原始解析结果 ——
 * `os` / `browser` 是 `<名称> <版本号>`（`Chrome 145.0.0.0`、`Windows 10`），
 * `device` 是 `model || type || vendor`（桌面端通常是空串，移动端是机型码 `ABR-AL60`）。
 * 直接按原值分组会让同一个浏览器的每个版本各占一档，榜单失去意义；
 * 旧版本写过库的整条原始 UA 还会独占榜首。
 *
 * 口径由 `doc/vectors/stats-distribution-v1.json` 在 Node / Go / Worker 三端钉死：
 * 任何一端改了正则、去版本号的边界或设备分类的优先级，都会在向量测试里立刻暴露。
 */

/**
 * 归一化时认可的全部空白字符。
 *
 * 刻意写成**显式字符类**，而不是依赖各语言自带的「空白」概念（`\s` / `trim()`）：
 * JS 的 `\s` 含 NBSP 与 U+FEFF，Go 的 RE2 `\s` 只认 ASCII 空白、`strings.TrimSpace`
 * 又不含 U+FEFF —— 只靠语言默认口径，从导入的脏数据里就会得到不同的家族名。
 * 这份字符集与 `doc/vectors/stats-distribution-v1.json` 的
 * `browser` / `os` / `device` 向量一一对应。
 */
const WS_CLASS =
  "[ \\t\\n\\r\\f\\v\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";

/** 同时吃掉首尾空白 */
const TRIM_RE = new RegExp(`^${WS_CLASS}+|${WS_CLASS}+$`, "g");

/** 尾部的「空白 + 以数字开头的 token」就是版本号：`Chrome 145.0.0.0` → `Chrome` */
const VERSION_SUFFIX_RE = new RegExp(`${WS_CLASS}+[0-9][0-9A-Za-z_.]*$`);

const trimWhitespace = (text: string): string => text.replace(TRIM_RE, "");

/** 旧版本 / 导入的历史数据可能整条都是原始 UA，无法解析出家族名 */
const RAW_UA_PREFIX_RE = /^Mozilla\//i;
const RAW_UA_HINT_RE = /AppleWebKit/i;

/** 无法识别时的兜底家族名（三端同一文案） */
export const UNKNOWN_FAMILY = "未知";
/** `device` 为空 = 桌面：ua-parser 对桌面端就是不下发 device */
export const DESKTOP_DEVICE = "桌面";
export const MOBILE_DEVICE = "移动";
export const TABLET_DEVICE = "平板";

const TABLET_RE = /ipad|tablet/i;
/**
 * 移动关键词**必须排在桌面关键词之前**：`Windows Phone` 同时含 `windows` 与 `phone`，
 * 先判桌面会把它算成桌面；反过来不会误伤任何桌面取值。
 */
const MOBILE_RE = /mobile|android|iphone|ipod|phone/i;
const DESKTOP_RE = /desktop|macintosh|windows|linux|mac os|chrome os|ubuntu/i;

/** 单条分布最多下发的档位数（超出部分由前端合并成「其他」） */
export const DISTRIBUTION_LIMIT = 5;

export interface RawDistributionRow {
  /** 列里的原始值（可空） */
  name: string | null;
  count: number;
}

export interface DistributionItem {
  name: string;
  count: number;
}

/** 是否是整条原始 UA（历史脏数据） */
export function isRawUserAgent(raw: string): boolean {
  return RAW_UA_PREFIX_RE.test(raw) || RAW_UA_HINT_RE.test(raw);
}

/**
 * 浏览器 / 操作系统的家族名。
 * 空值、纯空白与原始 UA 一律归入「未知」—— 不拿原始 UA 去截版本号。
 */
export function normalizeFamily(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return UNKNOWN_FAMILY;
  const text = trimWhitespace(raw);
  if (text === "" || isRawUserAgent(text)) return UNKNOWN_FAMILY;
  const family = trimWhitespace(text.replace(VERSION_SUFFIX_RE, ""));
  return family === "" ? UNKNOWN_FAMILY : family;
}

export const normalizeBrowserFamily = normalizeFamily;
export const normalizeOsFamily = normalizeFamily;

/**
 * 设备类型：`device` 列存的是 `model || type || vendor`。
 *
 * 判定优先级（三端必须一致）：
 *   1. 空（含 null）→ 桌面；
 *   2. 原始 UA → 未知；
 *   3. iPad / tablet → 平板；
 *   4. 移动关键词 → 移动（必须早于桌面关键词，见 `MOBILE_RE` 的注释）；
 *   5. 桌面关键词 → 桌面；
 *   6. 其余非空值是具体机型码（`ABR-AL60` / `V2507A`）→ 移动。
 *
 * 已知局限：Android 平板只留下机型（如 `Nexus 7`）时会被算作「移动」，
 * 因为此时 ua-parser 已经丢掉了 `tablet` 这个类型信息。
 */
export function normalizeDeviceType(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return DESKTOP_DEVICE;
  const text = trimWhitespace(raw);
  if (text === "") return DESKTOP_DEVICE;
  if (isRawUserAgent(text)) return UNKNOWN_FAMILY;
  if (TABLET_RE.test(text)) return TABLET_DEVICE;
  if (MOBILE_RE.test(text)) return MOBILE_DEVICE;
  if (DESKTOP_RE.test(text)) return DESKTOP_DEVICE;
  return MOBILE_DEVICE;
}

/**
 * 合并分布：归一化 → 同名累加 → 按数量降序排序 → 截断。
 *
 * 排序的并列规则必须是**名称升序**（按 Unicode 码点），否则三端会给出不同的榜单顺序
 * （JS 的 Map 插入序、Go 的 map 遍历序天然不同）。
 */
export function mergeDistribution(
  rows: RawDistributionRow[],
  normalize: (raw: string | null | undefined) => string,
  limit: number = DISTRIBUTION_LIMIT
): DistributionItem[] {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const name = normalize(row.name);
    merged.set(name, (merged.get(name) ?? 0) + (Number(row.count) || 0));
  }
  return Array.from(merged.entries())
    .map(([name, value]) => ({ name, count: value }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.max(0, limit));
}
