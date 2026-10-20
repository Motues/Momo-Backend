/**
 * 多管理员邮箱（`admin_emails`）与通知收件邮箱（`notify_email`）的校验与归一化。
 *
 * 口径的唯一事实来源是 `doc/admin_emails.md`：三端（Node / Go / Worker）必须逐条一致，
 * 跨语言固定向量见 `doc/vectors/admin-emails-v1.json`。
 *
 * 契约 1.8.0 起：
 *  - `admin_emails`：JSON 数组字符串（最多 10 个），列表内的人都享有博主特权；
 *  - `notify_email`：新评论通知 / 测试邮件的收件人，必须命中管理员列表；
 *  - 旧的 `admin_email`（单邮箱）继续兼容：列表为空时回落成单元素列表。
 */

import { countCodePoints } from "./security";
import { getSetting } from "./settings";

export const ADMIN_EMAILS_KEY = "admin_emails";
export const ADMIN_EMAIL_KEY = "admin_email";
export const NOTIFY_EMAIL_KEY = "notify_email";

export const MAX_ADMIN_EMAILS = 10;
export const MAX_ADMIN_EMAIL_LENGTH = 254;

/**
 * 邮箱判定：先 `trim` 再匹配。
 * 刻意不做 RFC 5322 全量解析，只挡明显非法形态（无 `@`、无 TLD、含空格、`<a@b.com>` 包裹等）。
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** `admin_emails` 的 4 条错误文案 + `notify_email` 的 2 条（三端逐字一致） */
export const ADMIN_EMAILS_ERRORS = {
  notArray: "admin_emails 必须是 JSON 数组",
  notString: "admin_emails 的每一项都必须是字符串",
  tooMany: `admin_emails 最多 ${MAX_ADMIN_EMAILS} 个邮箱`,
  badEmail: "admin_emails 包含非法邮箱地址",
  badNotify: "notify_email 必须是合法的邮箱地址",
  notifyNotInList: "notify_email 必须在管理员邮箱列表中",
};

/** 归一化邮箱：trim + 转小写（三端一致） */
export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** 邮箱是否合法（按 doc/admin_emails.md 第 2 节） */
export function isValidEmail(value: unknown): boolean {
  const email = normalizeEmail(value);
  if (email === "") return false;
  if (countCodePoints(email) > MAX_ADMIN_EMAIL_LENGTH) return false;
  return EMAIL_RE.test(email);
}

/**
 * 写入路径（严格）校验 `admin_emails`。
 * 空串 / 空数组视为「未配置」，通过校验。
 */
export function validateAdminEmails(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ADMIN_EMAILS_ERRORS.notArray;
  }
  if (!Array.isArray(parsed)) return ADMIN_EMAILS_ERRORS.notArray;
  for (const item of parsed) {
    if (typeof item !== "string") return ADMIN_EMAILS_ERRORS.notString;
  }

  const normalized = (parsed as string[])
    .map((item) => normalizeEmail(item))
    .filter((item) => item !== "");
  // 先归一化去重再数个数：同一个地址写 11 遍不应该被判成「超过 10 个」
  // （三端口径一致：notString → 归一化去空去重 → tooMany → badEmail）
  const emails = Array.from(new Set(normalized));
  if (emails.length > MAX_ADMIN_EMAILS) return ADMIN_EMAILS_ERRORS.tooMany;
  for (const email of emails) {
    if (!isValidEmail(email)) return ADMIN_EMAILS_ERRORS.badEmail;
  }
  return null;
}

/** 写入路径归一化：trim + 小写 + 去重（保序），存回 JSON 数组字符串 */
export function normalizeAdminEmails(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (text === "") return "[]";
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return "[]";
    const emails: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const email = normalizeEmail(item);
      if (email === "" || emails.includes(email)) continue;
      emails.push(email);
    }
    return JSON.stringify(emails);
  } catch {
    return "[]";
  }
}

/**
 * 读取路径（宽容）解析管理员列表：
 * 坏值 → `[]`；非字符串项 / 非法邮箱 / 空串丢弃；归一化后去重保序；截断到前 10 个。
 */
export function parseAdminEmails(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const text = String(raw).trim();
  if (text === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const email = normalizeEmail(item);
    if (!isValidEmail(email)) continue;
    if (result.includes(email)) continue;
    result.push(email);
    if (result.length >= MAX_ADMIN_EMAILS) break;
  }
  return result;
}

/** 读取路径：管理员列表（数组为空时回落到旧的单邮箱键） */
export function resolveAdminEmails(
  storedAdmins: string | null | undefined,
  legacyAdmin: string | null | undefined
): string[] {
  const admins = parseAdminEmails(storedAdmins);
  if (admins.length > 0) return admins;
  const legacy = normalizeEmail(legacyAdmin);
  return isValidEmail(legacy) ? [legacy] : [];
}

/** 读取路径：通知收件人（必须命中列表，否则回落第一个；列表为空 → 空串） */
export function resolveNotifyEmail(
  storedNotify: string | null | undefined,
  storedAdmins: string | null | undefined,
  legacyAdmin: string | null | undefined
): string {
  const admins = resolveAdminEmails(storedAdmins, legacyAdmin);
  if (admins.length === 0) return "";
  const notify = normalizeEmail(storedNotify);
  return admins.includes(notify) ? notify : admins[0];
}

/** 某个邮箱是否属于管理员列表（trim + 小写后比较） */
export function isAdminEmail(email: unknown, admins: string[]): boolean {
  const normalized = normalizeEmail(email);
  return normalized !== "" && admins.includes(normalized);
}

/**
 * 写入路径校验 `notify_email`。
 * 空串 = 清空（读取时回落列表第一个）；非空时必须合法且命中 `admins`。
 */
export function validateNotifyEmail(raw: unknown, admins: string[]): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  const notify = normalizeEmail(text);
  if (!isValidEmail(notify)) return ADMIN_EMAILS_ERRORS.badNotify;
  if (!admins.includes(notify)) return ADMIN_EMAILS_ERRORS.notifyNotInList;
  return null;
}

/** 从设置里读解析后的管理员列表（列表为空时回落旧键 `admin_email`） */
export async function getAdminEmailList(): Promise<string[]> {
  return resolveAdminEmails(await getSetting(ADMIN_EMAILS_KEY), await getSetting(ADMIN_EMAIL_KEY));
}

/** 从设置里读解析后的通知收件邮箱（命中列表的第一个/指定项；无管理员时为空串） */
export async function getNotifyEmail(): Promise<string> {
  return resolveNotifyEmail(
    await getSetting(NOTIFY_EMAIL_KEY),
    await getSetting(ADMIN_EMAILS_KEY),
    await getSetting(ADMIN_EMAIL_KEY)
  );
}
