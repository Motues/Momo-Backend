import CommentService   from "../orm/commentService"
import crypto from "crypto";
import LogService from "./log";
import { getSetting } from "./settings";

// 存储临时密钥的Map，包含密钥和过期时间
const tempKeys = new Map<string, { key: string; expiresAt: number }>();

export async function canPostComment(ip: string): Promise<boolean> {
    const lastComment = await CommentService.getlastCommentByIP(ip);
    // 如果没有找到评论或返回为空，则允许发布
    if (!lastComment || lastComment.length === 0) return true;

    // 确保有评论后再检查时间
    const comment = lastComment[0];
    if (!comment || !comment.pub_date) return true; // 防止 comment 或 pub_date 不存在的情况

    return Date.now() - comment.pub_date.getTime() > 60 * 1000;
}

// 使用 DOMPurify 进行 XSS 过滤（用于纯文本字段）
export function checkContent(content: string): string {
    if (!content) return content;
    return content
        // Remove script/style blocks and their content
        .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, '')
        // Remove event handler attributes (onclick, onerror, onload, etc.)
        .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // Remove javascript: and vbscript: links in href/src/action (all quote forms)
        .replace(/(?:href|src|action|formaction)\s*=\s*"(?:javascript|vbscript):[^"]*"/gi, '')
        .replace(/(?:href|src|action|formaction)\s*=\s*'(?:javascript|vbscript):[^']*'/gi, '')
        .replace(/(?:href|src|action|formaction)\s*=\s*(?:javascript|vbscript):[^\s>"]+/gi, '')
        // Remove standalone javascript: protocol
        .replace(/(?:javascript|vbscript):\s*/gi, '')
        // Remove dangerous embedding tags
        .replace(/<\/?(?:iframe|object|embed|frame|meta|link|base|form|input)\b[^>]*>/gi, '');
}

/**
 * 协议白名单校验（比黑名单正则可靠）。
 *
 * 允许：相对路径、http:、https:、mailto:
 * 拒绝：javascript:、vbscript:、data: 等一切其他 scheme
 *
 * 注意：浏览器在解析 URL 前会剥离 \t \n \r 等控制字符，
 * 因此 `java\nscript:alert(1)` 这类变体必须先剥离再判断 scheme。
 */
export function sanitizeUrl(raw: unknown): string {
    if (typeof raw !== "string") return "";
    const value = raw.trim();
    if (!value) return "";

    // 用于 scheme 判定的归一化副本：去掉全部 ASCII 控制字符与空白
    const probe = value.replace(/[\u0000-\u0020\u007f]/g, "");
    if (!probe) return "";

    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(probe);
    if (!schemeMatch) {
        // 没有 scheme：相对路径 / 协议相对地址（//host/path），交给浏览器按当前页面协议解析
        return value;
    }

    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") {
        return value;
    }
    return "";
}

// 使用 DOMPurify 过滤已渲染的 HTML 内容（Markdown 输出后使用）
import DOMPurify from 'isomorphic-dompurify';

export function sanitizeHtml(dirty: string): string {
    if (typeof dirty !== "string") return "";
    return DOMPurify.sanitize(dirty, {
        ALLOWED_TAGS: [
            'p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
            'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del', 'img',
            'span', 'div'
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel'],
        ALLOW_DATA_ATTR: false,
    });
}

/**
 * 生成基于随机 UUID 的临时密钥。
 * Map 的键使用独立随机值，不再使用调用方提供的用户名——
 * 否则同一密码可用任意用户名登录并产生多个并存会话。
 */
export async function generateTempKey(): Promise<string> {
    const tempKey = crypto.randomUUID();
    const expiresAt = Date.now() + 20 * 60 * 1000; // 20分钟后过期
    const id = crypto.randomUUID();

    tempKeys.set(id, { key: tempKey, expiresAt });

    return tempKey;
}

/** 常数时间字符串比较，避免 token 被逐字节爆破 */
function timingSafeEqualString(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// 检查密钥是否有效
export function checkKey(key: string): boolean {
    if (!key || typeof key !== "string") return false;

    // 检查是否是有效的临时密钥
    const now = Date.now();
    const entries = Array.from(tempKeys.entries());
    let valid = false;
    for (let i = 0; i < entries.length; i++) {
        const [id, tempKey] = entries[i];
        // 清除过期密钥
        if (tempKey.expiresAt <= now) {
            tempKeys.delete(id);
            continue;
        }
        // 检查密钥是否匹配（常数时间比较）
        if (!valid && timingSafeEqualString(tempKey.key, key)) {
            valid = true;
        }
    }

    return valid;
}

/** 吊销全部会话（改密后调用，避免旧 token 继续有效） */
export function clearAllTempKeys(): void {
    tempKeys.clear();
}

/** 吊销单个会话（登出） */
export function revokeTempKey(key: string): boolean {
    if (!key) return false;
    let revoked = false;
    for (const [id, tempKey] of Array.from(tempKeys.entries())) {
        if (timingSafeEqualString(tempKey.key, key)) {
            tempKeys.delete(id);
            revoked = true;
        }
    }
    return revoked;
}

/**
 * 从 Authorization header 中提取 token
 * 支持格式：Bearer <token> 或直接返回 token
 */
export function extractToken(authHeader: string): string {
    if (!authHeader) return "";

    // 如果是 "Bearer <token>" 格式，提取 token
    if (authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7);
    }

    // 否则直接返回 header 值
    return authHeader;
}

// ---- IP 黑名单和评论审核 ----

/* ------------------------- IP / CIDR 解析与匹配 ------------------------- */

function parseIPv4(input: string): number[] | null {
    const parts = input.split(".");
    if (parts.length !== 4) return null;
    const bytes: number[] = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n > 255) return null;
        bytes.push(n);
    }
    return bytes;
}

function parseIPv6(input: string): number[] | null {
    let ip = input;
    const zone = ip.indexOf("%");
    if (zone >= 0) ip = ip.slice(0, zone);
    if (!ip) return null;

    // 内嵌 IPv4：::ffff:1.2.3.4 / ::1.2.3.4
    const lastColon = ip.lastIndexOf(":");
    if (lastColon !== -1) {
        const tail = ip.slice(lastColon + 1);
        if (tail.includes(".")) {
            const v4 = parseIPv4(tail);
            if (!v4) return null;
            const high = (((v4[0] << 8) | v4[1]) >>> 0).toString(16);
            const low = (((v4[2] << 8) | v4[3]) >>> 0).toString(16);
            ip = ip.slice(0, lastColon + 1) + high + ":" + low;
        }
    }

    const doubleColonCount = ip.split("::").length - 1;
    if (doubleColonCount > 1) return null;

    let groups: string[];
    if (doubleColonCount === 1) {
        const [leftStr, rightStr] = ip.split("::");
        const left = leftStr === "" ? [] : leftStr.split(":");
        const right = rightStr === "" ? [] : rightStr.split(":");
        const missing = 8 - left.length - right.length;
        if (missing < 1) return null;
        groups = [...left, ...new Array(missing).fill("0"), ...right];
    } else {
        groups = ip.split(":");
        if (groups.length !== 8) return null;
    }

    const bytes: number[] = [];
    for (const group of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        const n = parseInt(group, 16);
        bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
}

interface ParsedIp { bytes: number[]; family: 4 | 6 }

/** 解析 IP；IPv4-mapped IPv6（::ffff:1.2.3.4）归一化为 IPv4，便于匹配 IPv4 网段 */
function parseIp(input: string): ParsedIp | null {
    const value = input.trim();
    if (!value) return null;

    const v4 = parseIPv4(value);
    if (v4) return { bytes: v4, family: 4 };

    let v6 = parseIPv6(value);
    if (!v6) return null;

    const isMapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    if (isMapped) return { bytes: v6.slice(12), family: 4 };

    return { bytes: v6, family: 6 };
}

/** 校验单条黑名单条目是否为合法 IP 或 CIDR（保存前使用） */
export function isValidIpOrCidr(entry: unknown): boolean {
    if (typeof entry !== "string") return false;
    const value = entry.trim();
    if (!value) return false;

    const slash = value.lastIndexOf("/");
    if (slash === -1) return parseIp(value) !== null;

    const addr = value.slice(0, slash);
    const bitsStr = value.slice(slash + 1);
    if (!/^\d{1,3}$/.test(bitsStr)) return false;

    const parsed = parseIp(addr);
    if (!parsed) return false;

    const bits = Number(bitsStr);
    const maxBits = parsed.family === 4 ? 32 : 128;
    return bits >= 0 && bits <= maxBits;
}

/** 校验黑名单 JSON 字符串（必须是合法 JSON 数组，且每项都是合法 IP/CIDR） */
export function isValidIpBlacklistJson(raw: string): boolean {
    if (raw === "") return true;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }
    if (!Array.isArray(parsed)) return false;
    return parsed.every((entry) => isValidIpOrCidr(entry));
}

/**
 * CIDR 匹配。
 * - 非法条目一律返回 false（此前的实现会让 "notanip/24" 命中全部 IP）；
 * - IPv4 条目不再命中 IPv6 地址，反之亦然（此前的实现会把 IPv6 解析成 NaN）。
 */
function ipInCIDR(ip: string, cidr: string): boolean {
    const entry = cidr.trim();
    const slash = entry.lastIndexOf("/");
    if (slash === -1) return false;

    const range = parseIp(entry.slice(0, slash));
    if (!range) return false;

    const bitsStr = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(bitsStr)) return false;
    const prefix = Number(bitsStr);
    const maxBits = range.family === 4 ? 32 : 128;
    if (prefix < 0 || prefix > maxBits) return false;

    const target = parseIp(ip);
    if (!target || target.family !== range.family) return false;

    const fullBytes = prefix >> 3;
    const restBits = prefix & 7;

    for (let i = 0; i < fullBytes; i++) {
        if (target.bytes[i] !== range.bytes[i]) return false;
    }
    if (restBits > 0) {
        const mask = (0xff << (8 - restBits)) & 0xff;
        if ((target.bytes[fullBytes] & mask) !== (range.bytes[fullBytes] & mask)) return false;
    }
    return true;
}

export async function checkIpBlacklist(ip: string): Promise<boolean> {
  const blacklistStr = await getSetting("ip_blacklist");
  if (!blacklistStr) return false;

  let blacklist: unknown;
  try {
    blacklist = JSON.parse(blacklistStr);
  } catch (e) {
    // 配置损坏：保持放行（避免因一条坏配置导致全站无法评论），但必须留下告警
    LogService.warn("[security] ip_blacklist 不是合法 JSON，黑名单检查已被跳过，请在后台修复该配置", e);
    return false;
  }
  if (!Array.isArray(blacklist)) {
    LogService.warn("[security] ip_blacklist 不是数组，黑名单检查已被跳过，请在后台修复该配置");
    return false;
  }

  const target = ip.trim();
  const parsedTarget = parseIp(target);

  return blacklist.some((entry) => {
    if (typeof entry !== "string") return false;
    const value = entry.trim();
    if (!value) return false;

    if (value.includes("/")) {
      return ipInCIDR(target, value);
    }

    const parsedEntry = parseIp(value);
    if (parsedEntry && parsedTarget) {
      return parsedEntry.family === parsedTarget.family &&
        parsedEntry.bytes.join(",") === parsedTarget.bytes.join(",");
    }
    return value === target;
  });
}

export async function checkEmailBlacklist(email: string): Promise<boolean> {
  const blacklistStr = await getSetting("email_blacklist");
  if (!blacklistStr) return false;

  let blacklist: unknown;
  try {
    blacklist = JSON.parse(blacklistStr);
  } catch (e) {
    LogService.warn("[security] email_blacklist 不是合法 JSON，黑名单检查已被跳过，请在后台修复该配置", e);
    return false;
  }
  if (!Array.isArray(blacklist)) {
    LogService.warn("[security] email_blacklist 不是数组，黑名单检查已被跳过，请在后台修复该配置");
    return false;
  }

  // 不区分大小写匹配，与拉黑接口的小写归一化保持一致
  return blacklist.some((entry) => String(entry).toLowerCase() === email.toLowerCase());
}

export async function getCommentStatus(): Promise<string> {
  const autoApprove = await getSetting("comment_auto_approve");
  return autoApprove === "false" ? "pending" : "approved";
}

// ---- 评论状态白名单 ----
export const COMMENT_STATUSES = ["pending", "approved", "rejected", "deleted"] as const;

export function isValidCommentStatus(status: unknown): status is typeof COMMENT_STATUSES[number] {
  return typeof status === "string" && (COMMENT_STATUSES as readonly string[]).includes(status);
}
