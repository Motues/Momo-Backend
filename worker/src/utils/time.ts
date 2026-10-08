/**
 * 时间字段（pub_date / lastCommentDate 等）的统一解析与格式化。
 *
 * 背景（C1）：三套后端统一以「毫秒整数」存储 pub_date。
 * 历史版本 Worker 曾写入 ISO 字符串，因此读取侧必须同时兼容：
 *  - 毫秒整数（number）
 *  - 数字字符串（'1712345678901'）
 *  - ISO 字符串（'2024-03-05T06:07:08.000Z'）
 */

/** 把任意历史形态的时间值解析为毫秒整数；无法解析时返回 null */
export function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const str = String(value).trim();
  if (!str) return null;

  // 纯数字字符串按毫秒整数处理（new Date('1712345678901') 会得到 Invalid Date）
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 把任意历史形态的时间值格式化为 ISO 字符串；无法解析时返回空串 */
export function toIsoString(value: unknown): string {
  const ms = toMillis(value);
  return ms === null ? "" : new Date(ms).toISOString();
}
