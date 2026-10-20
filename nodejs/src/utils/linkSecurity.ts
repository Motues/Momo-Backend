/**
 * 链接安全审查（休眠链接 + 历史链接批量更新 + 休眠提醒邮件）的设置口径与休眠判定。
 *
 * 口径的唯一事实来源是 `doc/link_security.md`：三端（Node / Go / Worker）必须逐条一致，
 * 跨语言固定向量见 `doc/vectors/link-security-v1.json`。
 *
 * 开关都是 **fail-closed**：只有归一化后等于 `"true"` 才算开启 ——
 * 与表情开关的 fail-open 刻意相反，安全功能绝不会因为一个脏值把全站链接拦起来。
 */

export const LINK_SECURITY_ENABLED_KEY = "link_security_enabled";
export const LINK_DORMANT_DAYS_KEY = "link_dormant_days";
export const LINK_SYNC_ENABLED_KEY = "link_sync_enabled";
export const LINK_DORMANT_NOTICE_ENABLED_KEY = "link_dormant_notice_enabled";

export const DEFAULT_LINK_SECURITY_ENABLED = "false";
export const DEFAULT_LINK_SYNC_ENABLED = "false";
export const DEFAULT_LINK_DORMANT_NOTICE_ENABLED = "false";
export const DEFAULT_LINK_DORMANT_DAYS = 30;
export const MIN_LINK_DORMANT_DAYS = 1;
export const MAX_LINK_DORMANT_DAYS = 3650;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 开关与天数的错误文案（三端逐字一致，见 doc/vectors/link-security-v1.json 的 errors） */
export const LINK_SECURITY_ERRORS = {
  securityEnabled: `${LINK_SECURITY_ENABLED_KEY} 只能是 true 或 false`,
  syncEnabled: `${LINK_SYNC_ENABLED_KEY} 只能是 true 或 false`,
  dormantNoticeEnabled: `${LINK_DORMANT_NOTICE_ENABLED_KEY} 只能是 true 或 false`,
  dormantDays: `${LINK_DORMANT_DAYS_KEY} 必须是 ${MIN_LINK_DORMANT_DAYS}-${MAX_LINK_DORMANT_DAYS} 之间的整数`,
};

/** 设置键 → 自己的错误文案（新增开关时只改这里，避免文案串味） */
const LINK_SWITCH_ERRORS: Record<string, string> = {
  [LINK_SECURITY_ENABLED_KEY]: LINK_SECURITY_ERRORS.securityEnabled,
  [LINK_SYNC_ENABLED_KEY]: LINK_SECURITY_ERRORS.syncEnabled,
  [LINK_DORMANT_NOTICE_ENABLED_KEY]: LINK_SECURITY_ERRORS.dormantNoticeEnabled,
};

/** 三个开关键（写入校验、归一化落库共用） */
export const LINK_SWITCH_KEYS = [
  LINK_SECURITY_ENABLED_KEY,
  LINK_SYNC_ENABLED_KEY,
  LINK_DORMANT_NOTICE_ENABLED_KEY,
];

/** 开关归一化：trim + 转小写（写入时存归一化后的值） */
export function normalizeLinkSwitch(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** 校验链接安全开关：归一化后只允许 `""` / `"true"` / `"false"` */
export function validateLinkSwitch(raw: unknown, key: string): string | null {
  const value = normalizeLinkSwitch(raw);
  if (value === "" || value === "true" || value === "false") return null;
  return LINK_SWITCH_ERRORS[key] ?? LINK_SECURITY_ERRORS.securityEnabled;
}

/** 校验休眠天数：1–3650 的十进制整数 */
export function validateDormantDays(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return LINK_SECURITY_ERRORS.dormantDays;
  const value = Number(text);
  if (value < MIN_LINK_DORMANT_DAYS || value > MAX_LINK_DORMANT_DAYS) {
    return LINK_SECURITY_ERRORS.dormantDays;
  }
  return null;
}

/** 读取归一化开关：fail-closed，只有 `true`（大小写不敏感）才算开启 */
export function resolveLinkSwitch(raw: unknown): string {
  return normalizeLinkSwitch(raw) === "true" ? "true" : "false";
}

/** 读取归一化天数：脏值回退默认 30，超过上限夹取到 3650 */
export function resolveDormantDays(raw: unknown): number {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return DEFAULT_LINK_DORMANT_DAYS;
  const value = Number(text);
  if (value < MIN_LINK_DORMANT_DAYS) return DEFAULT_LINK_DORMANT_DAYS;
  if (value > MAX_LINK_DORMANT_DAYS) return MAX_LINK_DORMANT_DAYS;
  return value;
}

export interface DormantInput {
  /** 功能是否开启（存储原值） */
  enabled: string | null | undefined;
  /** 该评论是否有个人网址 */
  hasUrl: boolean;
  /** 休眠天数（存储原值） */
  days: string | number | null | undefined;
  /** 该邮箱最后一条评论距今的毫秒数；`null` 表示查不到（不标记） */
  ageMs: number | null | undefined;
  /**
   * 该（邮箱, 网址）是否有人工确认**且未过期**。
   *
   * 由调用方用 `isTrustActive(expires_at, now)` 算好传进来 —— 判定本身保持纯函数，
   * 才能被跨语言向量逐条钉死。
   */
  trusted?: boolean;
}

/**
 * 休眠判定（见 doc/link_security.md 第 2.1 / 2.4 节）：
 *
 * ```
 * 休眠 = 功能开启 && 未被人工确认 && 有个人网址 && 最后评论距今 **严格大于** N 天
 * ```
 *
 * 最后评论时间未知（数据缺失）一律**不标记**：宁可照常跳转，也不冤枉活人。
 */
export function isLinkDormant({ enabled, hasUrl, days, ageMs, trusted }: DormantInput): boolean {
  if (resolveLinkSwitch(enabled) !== "true") return false;
  // 人工确认未过期 → 直接豁免（管理员已经人工看过这条链接了）
  if (trusted === true) return false;
  if (!hasUrl) return false;
  if (ageMs === null || ageMs === undefined || !Number.isFinite(Number(ageMs))) return false;
  return Number(ageMs) > resolveDormantDays(days) * DAY_MS;
}

/**
 * 人工确认的到期时间格式：与 `new Date(ms).toISOString()` 逐字一致。
 *
 * 只接受这一种形状是**刻意**的：JS 的 `Date.parse` 能宽容地吃下 `2026-11-17`、
 * 带时区偏移等写法，而 Go 的 `time.Parse(time.RFC3339)` 会拒绝它们 ——
 * 只按「能解析就算有效」，两端就会对同一条记录给出不同答案。
 */
const TRUST_EXPIRES_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 人工确认是否仍在有效期内（见 doc/link_security.md 第 2.4 节）。
 *
 * **严格大于**当前时间才算有效（与休眠判定的严格大于同一风格）；
 * 空值 / 格式不符 / 无法解析一律 `false`（fail-closed：不豁免休眠，管理员重新确认即可）。
 */
export function isTrustActive(
  expiresAt: string | null | undefined,
  nowMs: number
): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const text = String(expiresAt);
  if (!TRUST_EXPIRES_RE.test(text)) return false;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > nowMs;
}

/**
 * 人工确认记录的查找键：`(归一化邮箱, 网址)`。
 *
 * 仅本端内部使用（内存 Map 的键），不是跨语言契约；分隔符取不可能出现在邮箱/网址里的
 * NUL，避免拼接歧义。
 */
export function linkTrustKey(email: string, url: string): string {
  return `${String(email ?? "").trim().toLowerCase()}\u0000${String(url ?? "").trim()}`;
}

export interface DormantNoticeInput {
  /** 该 (邮箱, 网址) 当前是否被判为休眠 */
  dormant: boolean;
  /** 是否已经有提醒记录 */
  hasRecord: boolean;
  /** 已有记录是否已过期（提醒页令牌失效） */
  recordExpired: boolean;
  /** 已有记录里存的「最后评论时间」（毫秒）；无记录时无意义 */
  recordLastCommentAt: number | null;
  /** 当前该邮箱的最后评论时间（毫秒） */
  currentLastCommentAt: number;
}

/**
 * 休眠提醒的状态机：**同一个休眠周期只提醒一次**（见 doc/link_security.md 第 2.7 节）。
 *
 * ```
 * 需要发提醒 = 当前休眠 && (没有记录 || 记录已过期 || 记录里的最后评论时间 ≠ 当前最后评论时间)
 * ```
 *
 * 「最后评论时间」是这个状态机的锚：他没再评论过 = 同一个休眠周期（只提醒一次）；
 * 他后来又评论过 = 新的休眠周期（再提醒一次）；记录过期 = 提醒页失效了（刷新令牌与有效期后再发）。
 */
export function needDormantNotice({
  dormant,
  hasRecord,
  recordExpired,
  recordLastCommentAt,
  currentLastCommentAt,
}: DormantNoticeInput): boolean {
  if (dormant !== true) return false;
  if (hasRecord !== true) return true;
  if (recordExpired === true) return true;
  return Number(recordLastCommentAt) !== Number(currentLastCommentAt);
}

export interface DormantNoticeGateInput {
  /** 休眠链接总开关（存储原值） */
  securityEnabled: unknown;
  /** 休眠提醒邮件开关（存储原值） */
  noticeEnabled: unknown;
  /** 邮箱验证开关（存储原值） */
  emailVerifyEnabled: unknown;
}

/**
 * 休眠提醒邮件的**发信前提**（见 doc/link_security.md 第 2.7 节）：
 *
 * ```
 * 发信 = link_security_enabled && link_dormant_notice_enabled && email_verify_enabled
 * ```
 *
 * 三个值一律 fail-closed（归一化后等于 `"true"` 才算开启）：功能没开、提醒开关没开、
 * 或站点没开邮箱验证时，一封提醒都不发 —— 面板上的警告与这里完全同口径。
 * SMTP 可用性与 `email_enabled` 由发信函数再检查一次（不合并进本函数，便于单元测试）。
 */
export function shouldSendDormantNotice({
  securityEnabled,
  noticeEnabled,
  emailVerifyEnabled,
}: DormantNoticeGateInput): boolean {
  return (
    resolveLinkSwitch(securityEnabled) === "true" &&
    resolveLinkSwitch(noticeEnabled) === "true" &&
    resolveLinkSwitch(emailVerifyEnabled) === "true"
  );
}

/** 参与休眠统计 / 批量更新的评论状态口径 */
export const LINK_SECURITY_ACTIVE_STATUSES = ["approved", "pending"];

/**
 * 批量更新链接时允许被改写的状态：
 * `rejected` / `deleted` 不动（已驳回或已删除的评论不该被「顺手改活」）。
 */
export function isLinkSecurityActiveStatus(status: string): boolean {
  return LINK_SECURITY_ACTIVE_STATUSES.includes(String(status ?? ""));
}
