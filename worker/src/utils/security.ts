/**
 * Worker 端安全工具：与 Node/Go 三端保持一致的净化与校验逻辑。
 */

// 检查内容，删除 XSS 攻击脚本（用于纯文本字段）
export function checkContent(content: string): string {
  if (!content) return content;
  return content
    // Remove script/style blocks and their content
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, '')
    // Remove event handler attributes (onclick, onerror, onload, etc.)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Remove javascript: and vbscript: links in href/src/action (quoted)
    .replace(/(?:href|src|action|formaction)\s*=\s*"(?:javascript|vbscript):[^"]*"/gi, '')
    .replace(/(?:href|src|action|formaction)\s*=\s*'(?:javascript|vbscript):[^']*'/gi, '')
    // Remove javascript: and vbscript: links (unquoted, e.g. href=javascript:alert(1))
    .replace(/(?:href|src|action|formaction)\s*=\s*(?:javascript|vbscript):[^\s>"]+/gi, '')
    // Remove standalone javascript: and vbscript: protocol
    .replace(/(?:javascript|vbscript):\s*/gi, '')
    // Remove dangerous embedding tags
    .replace(/<\/?(?:iframe|object|embed|frame|meta|link|base|form|input)\b[^>]*>/gi, '');
}

/**
 * 协议白名单校验（比黑名单正则可靠）。
 * 允许：相对路径、http:、https:、mailto:；其余 scheme 一律返回空串。
 *
 * 浏览器解析 URL 前会剥离 \t \n \r 等控制字符，因此必须先剥离再判断 scheme，
 * 否则 `java\nscript:alert(1)` 会绕过黑名单。
 */
export function sanitizeUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";

  const probe = value.replace(/[\u0000-\u0020\u007f]/g, "");
  if (!probe) return "";

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(probe);
  if (!schemeMatch) {
    // 没有 scheme：相对路径 / 协议相对地址
    return value;
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    return value;
  }
  return "";
}

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

  // 内嵌 IPv4
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

/** 解析 IP；IPv4-mapped IPv6 归一化为 IPv4 */
function parseIp(input: string): ParsedIp | null {
  const value = input.trim();
  if (!value) return null;

  const v4 = parseIPv4(value);
  if (v4) return { bytes: v4, family: 4 };

  const v6 = parseIPv6(value);
  if (!v6) return null;

  const isMapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (isMapped) return { bytes: v6.slice(12), family: 4 };

  return { bytes: v6, family: 6 };
}

/** 校验单条黑名单条目是否为合法 IP 或 CIDR */
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

/** 校验黑名单 JSON 字符串 */
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
 * CIDR 匹配。非法条目一律返回 false，IPv4/IPv6 不跨族匹配。
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

/** 解析黑名单 JSON；失败时返回 null（调用方决定 fail-open + 告警） */
export function parseIpBlacklist(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

export function ipMatchesBlacklist(ip: string, blacklist: string[]): boolean {
  const target = ip.trim();
  const parsedTarget = parseIp(target);

  return blacklist.some((entry) => {
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

// ---- 评论状态白名单 ----
export const COMMENT_STATUSES = ["pending", "approved", "rejected", "deleted"] as const;

export function isValidCommentStatus(status: unknown): status is typeof COMMENT_STATUSES[number] {
  return typeof status === "string" && (COMMENT_STATUSES as readonly string[]).includes(status);
}

// ---- 字段长度上限（与前端组件约束对齐） ----
export const MAX_CONTENT = 2000;
export const MAX_CONTENT_HTML = 50000;
export const MAX_AUTHOR = 100;
export const MAX_EMAIL = 254;
export const MAX_URL = 500;
export const MAX_POST_SLUG = 200;
