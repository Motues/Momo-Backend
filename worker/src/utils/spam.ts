/**
 * 评论审核自动化（垃圾规则）。
 *
 * 与 `comment_auto_approve` 合并为一个开关，语义与 Node / Go 逐字一致：
 *   - `comment_auto_approve = "false"` → 所有评论 pending（历史行为）；
 *   - 否则：命中任一垃圾规则 → pending，未命中 → approved；
 *   - 管理员密钥已验证的博主评论永远 approved，不参与规则判定。
 *
 * 四条规则：
 *   1. 敏感关键词：JSON 数组，不区分大小写，命中「正文 / 昵称 / 网址」任一即垃圾；
 *   2. 链接数：正文中的 `http(s)://…` 与裸 `www.` + 个人网址字段（计 1），超过阈值即垃圾；
 *   3. 正文长度：按 **Unicode 码点** 计算，低于阈值即垃圾；
 *   4. 重复内容：同一 IP 在时间窗内提交过**完全相同**的正文即垃圾。
 *
 * 阈值 `0` 一律表示「不启用该规则」，且**四项默认值全部为 0**：升级后行为与旧版本完全一致，
 * 不会凭空拦下任何评论。后台页面会给出建议值（链接 3 / 正文 5 字符 / 重复 10 分钟）供按需填写。
 */
import { Bindings } from '../bindings';
import { getSetting } from './settings';
import { countCodePoints } from './security';

/** 各配置项的取值上限（三端一致，防止一条坏配置把规则变成全站拦截或全表扫描） */
export const SPAM_LIMITS = {
  MAX_KEYWORDS: 200,
  MAX_KEYWORD_LENGTH: 100,
  MAX_LINKS: 50,
  MAX_MIN_LENGTH: 2000,
  MAX_DUPLICATE_WINDOW_MINUTES: 10080, // 7 天
} as const;

/** 未配置时的默认阈值：全部为 0（不启用），与后台页面的默认值保持一致 */
export const SPAM_DEFAULTS = {
  maxLinks: 0,
  minLength: 0,
  duplicateWindow: 0,
} as const;

/** 匹配带协议的链接（连同后面的非空白字符一起吃掉，避免与裸 www. 重复计数） */
const SCHEME_LINK_RE = /https?:\/\/\S*/gi;
/** 匹配裸域名形式的链接 */
const BARE_WWW_RE = /www\./gi;

/**
 * 解析敏感关键词配置。
 *
 * 配置损坏或类型不对时返回空数组（等于该规则不生效）并留下告警 ——
 * 与 IP/邮箱黑名单一致：一条坏配置不能让全站评论都被判为垃圾。
 */
export function parseSpamKeywords(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const text = String(raw).trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn('[spam] comment_spam_keywords 不是合法 JSON，关键词规则已被跳过，请在后台修复该配置');
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[spam] comment_spam_keywords 不是数组，关键词规则已被跳过，请在后台修复该配置');
    return [];
  }

  // 统一转小写做匹配：关键词规则不区分大小写
  return parsed
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** 解析数值型配置：非法值退回默认值，超上限按上限夹取 */
export function parseSpamNumber(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw === null || raw === undefined) return fallback;
  const text = String(raw).trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(value, max);
}

/** 统计正文中的链接数量（只数正文，个人网址字段由调用方另计 1） */
export function countLinks(text: string): number {
  if (!text) return 0;
  const schemeLinks = text.match(SCHEME_LINK_RE)?.length ?? 0;
  const rest = text.replace(SCHEME_LINK_RE, ' ');
  const bareLinks = rest.match(BARE_WWW_RE)?.length ?? 0;
  return schemeLinks + bareLinks;
}

/** 规则判定输入 */
export interface SpamRuleInput {
  content: string;
  author: string;
  url: string;
  keywords: string[];
  maxLinks: number;
  minLength: number;
}

/**
 * 纯函数规则判定：返回命中原因（用于日志），未命中返回 `null`。
 *
 * 与 DB 无关，便于三端做完全一致的单元测试与向量对齐。
 */
export function evaluateSpamRules(input: SpamRuleInput): string | null {
  const { content, author, url, keywords, maxLinks, minLength } = input;

  // 1. 敏感关键词（正文 / 昵称 / 网址）
  if (keywords.length > 0) {
    const haystack = `${content}\n${author}\n${url}`.toLowerCase();
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) return `keyword:${keyword}`;
    }
  }

  // 2. 链接数（正文链接 + 个人网址字段）
  if (maxLinks > 0) {
    const links = countLinks(content) + (url ? 1 : 0);
    if (links > maxLinks) return `too_many_links:${links}`;
  }

  // 3. 正文长度（Unicode 码点）
  if (minLength > 0) {
    const length = countCodePoints(content.trim());
    if (length < minLength) return `too_short:${length}`;
  }

  return null;
}

/** 读取四项垃圾规则配置 */
export async function getSpamSettings(env: Bindings): Promise<{
  keywords: string[];
  maxLinks: number;
  minLength: number;
  duplicateWindow: number;
}> {
  const [rawKeywords, rawMaxLinks, rawMinLength, rawWindow] = await Promise.all([
    getSetting(env, 'comment_spam_keywords'),
    getSetting(env, 'comment_spam_max_links'),
    getSetting(env, 'comment_spam_min_length'),
    getSetting(env, 'comment_spam_duplicate_window'),
  ]);

  return {
    keywords: parseSpamKeywords(rawKeywords),
    maxLinks: parseSpamNumber(rawMaxLinks, SPAM_DEFAULTS.maxLinks, SPAM_LIMITS.MAX_LINKS),
    minLength: parseSpamNumber(rawMinLength, SPAM_DEFAULTS.minLength, SPAM_LIMITS.MAX_MIN_LENGTH),
    duplicateWindow: parseSpamNumber(
      rawWindow,
      SPAM_DEFAULTS.duplicateWindow,
      SPAM_LIMITS.MAX_DUPLICATE_WINDOW_MINUTES
    ),
  };
}

/**
 * 判定一条评论是否应被判为垃圾（含重复检测）。
 *
 * 返回命中原因，未命中返回 `null`。调用方只在「本来会直接通过」时才调用它，
 * 因此 `comment_auto_approve = "false"` 时不会产生额外查询。
 */
export async function checkCommentSpam(
  env: Bindings,
  input: { content: string; author: string; url: string; ip: string }
): Promise<string | null> {
  const settings = await getSpamSettings(env);

  const reason = evaluateSpamRules({ ...input, ...settings });
  if (reason) return reason;

  if (settings.duplicateWindow > 0) {
    const since = Date.now() - settings.duplicateWindow * 60 * 1000;
    // 不区分状态：被判为垃圾或被删除的评论同样计入 —— 否则刷屏者只要被删一次
    // 就能把同一段内容无限重发。
    const row = await env.MOMO_DB.prepare(
      'SELECT id FROM Comment WHERE ip_address = ? AND content_text = ? AND pub_date >= ? LIMIT 1'
    )
      .bind(input.ip, input.content, since)
      .first<{ id: number }>();
    if (row) return `duplicate:${settings.duplicateWindow}m`;
  }

  return null;
}

// ---- 后台设置校验（与 Node / Go 口径一致） ----

function isIntInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

/** 校验敏感关键词 JSON：必须是去重前的非空字符串数组，条数与单条长度都受限 */
export function isValidSpamKeywordsJson(raw: string): boolean {
  if (!raw) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length > SPAM_LIMITS.MAX_KEYWORDS) return false;
  return parsed.every(
    (entry) =>
      typeof entry === 'string' &&
      entry.trim().length > 0 &&
      countCodePoints(entry.trim()) <= SPAM_LIMITS.MAX_KEYWORD_LENGTH
  );
}

/**
 * 校验一条垃圾规则设置；通过返回 `null`，否则返回错误信息。
 *
 * 空串表示「未设置」→ 使用默认值，允许。
 */
export function validateSpamSetting(key: string, raw: unknown): string | null {
  const value = String(raw ?? '').trim();

  switch (key) {
    case 'comment_spam_keywords':
      return isValidSpamKeywordsJson(value)
        ? null
        : `comment_spam_keywords must be a JSON array of at most ${SPAM_LIMITS.MAX_KEYWORDS} non-empty strings`;
    case 'comment_spam_max_links':
      return value === '' || isIntInRange(value, 0, SPAM_LIMITS.MAX_LINKS)
        ? null
        : `comment_spam_max_links must be an integer between 0 and ${SPAM_LIMITS.MAX_LINKS}`;
    case 'comment_spam_min_length':
      return value === '' || isIntInRange(value, 0, SPAM_LIMITS.MAX_MIN_LENGTH)
        ? null
        : `comment_spam_min_length must be an integer between 0 and ${SPAM_LIMITS.MAX_MIN_LENGTH}`;
    case 'comment_spam_duplicate_window':
      return value === '' || isIntInRange(value, 0, SPAM_LIMITS.MAX_DUPLICATE_WINDOW_MINUTES)
        ? null
        : `comment_spam_duplicate_window must be an integer between 0 and ${SPAM_LIMITS.MAX_DUPLICATE_WINDOW_MINUTES}`;
    default:
      return null;
  }
}

/** 垃圾规则相关的设置键 */
export const SPAM_SETTING_KEYS = [
  'comment_spam_keywords',
  'comment_spam_max_links',
  'comment_spam_min_length',
  'comment_spam_duplicate_window',
] as const;

/** 批量校验垃圾规则设置；返回首个错误信息，全部通过返回 `null` */
export function validateSpamSettings(body: Record<string, unknown>): string | null {
  for (const key of SPAM_SETTING_KEYS) {
    if (key in body) {
      const error = validateSpamSetting(key, body[key]);
      if (error) return error;
    }
  }
  return null;
}
