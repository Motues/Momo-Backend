import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "node:net";
import { getSetting } from "./settings";

/**
 * 客户端 IP 解析策略。
 *
 * - 默认（`trust_proxy` 关闭）：只使用 TCP 连接对端地址（getConnInfo），
 *   攻击者无法通过伪造 `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`
 *   绕过 IP 黑名单、登录失败锁定与评论频率限制。
 * - 开启时（后台「安全设置 → 客户端 IP 识别」开关，或环境变量）：
 *   按 cf-connecting-ip → x-real-ip → x-forwarded-for 取值，
 *   其中 x-forwarded-for 取**最右一跳**——该值由最近的可信代理追加，
 *   客户端自行伪造的前置条目不会生效。
 *
 * 优先级：环境变量 `TRUST_PROXY`（显式指定时）> 页面设置 `trust_proxy`。
 */

const TRUST_PROXY_SETTING = "trust_proxy";
const CACHE_TTL_MS = 15 * 1000;

const TRUE_VALUES = ["true", "1", "yes", "on"];
const FALSE_VALUES = ["false", "0", "no", "off"];

/** 环境变量显式覆盖：未设置时返回 null（表示以页面设置为准） */
function envTrustProxyOverride(): boolean | null {
  const raw = (process.env.TRUST_PROXY || "").trim().toLowerCase();
  if (!raw) return null;
  if (TRUE_VALUES.includes(raw)) return true;
  if (FALSE_VALUES.includes(raw)) return false;
  return null;
}

/** 环境变量是否显式指定了该开关（供后台展示提示） */
export function hasTrustProxyEnvOverride(): boolean {
  return envTrustProxyOverride() !== null;
}

let cachedTrustProxy = false;
let cacheLoadedAt = 0;
let refreshing: Promise<void> | null = null;

/** 从 Settings 表刷新缓存（环境变量优先） */
export async function refreshTrustProxy(): Promise<void> {
  const override = envTrustProxyOverride();
  if (override !== null) {
    cachedTrustProxy = override;
    cacheLoadedAt = Date.now();
    return;
  }
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      cachedTrustProxy = (await getSetting(TRUST_PROXY_SETTING)) === "true";
    } catch {
      // 读取失败时保持上一次的值（默认关闭）
    } finally {
      cacheLoadedAt = Date.now();
      refreshing = null;
    }
  })();

  return refreshing;
}

/** 启动时预加载，避免最初的请求按默认值处理 */
export async function initTrustProxy(): Promise<void> {
  await refreshTrustProxy();
}

/** 后台保存设置后立即生效 */
export function applyTrustProxySetting(value: string): void {
  cachedTrustProxy = value === "true";
  cacheLoadedAt = Date.now();
}

/** 当前生效值 */
export function isTrustProxyEnabled(): boolean {
  const override = envTrustProxyOverride();
  if (override !== null) return override;

  // 缓存过期时触发后台刷新（不阻塞当前请求），多实例/直改数据库也能在 15 秒内同步
  if (Date.now() - cacheLoadedAt >= CACHE_TTL_MS) {
    void refreshTrustProxy();
  }
  return cachedTrustProxy;
}

/** 去掉 IPv6 映射前缀、端口与方括号，并做一次基本校验 */
const normalizeIp = (value?: string | null): string => {
  if (!value) return "";
  let ip = value.trim();
  if (!ip) return "";

  // [::1]:1234 / [::1]
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 0) ip = ip.slice(1, end);
  } else if (ip.includes(":") && ip.includes(".")) {
    // 1.2.3.4:5678
    const idx = ip.lastIndexOf(":");
    if (idx > 0 && isIP(ip.slice(0, idx)) === 4) ip = ip.slice(0, idx);
  }

  // ::ffff:1.2.3.4 -> 1.2.3.4
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];

  return ip;
};

/** 仅接受合法 IP，避免伪造头里塞入任意字符串 */
const pickIp = (value?: string | null): string => {
  const ip = normalizeIp(value);
  return ip && isIP(ip) !== 0 ? ip : "";
};

/**
 * 获取客户端真实 IP 地址。
 */
export const getClientIP = (c: Context): string => {
  if (isTrustProxyEnabled()) {
    // Cloudflare CDN（由 Cloudflare 覆写，不可伪造）
    const cfConnectingIP = pickIp(c.req.header("cf-connecting-ip"));
    if (cfConnectingIP) return cfConnectingIP;

    // Nginx 反向代理
    const xRealIP = pickIp(c.req.header("x-real-ip"));
    if (xRealIP) return xRealIP;

    // 负载均衡/代理链，取最右一跳
    const xForwardedFor = c.req.header("x-forwarded-for");
    if (xForwardedFor) {
      const parts = xForwardedFor.split(",");
      for (let i = parts.length - 1; i >= 0; i--) {
        const ip = pickIp(parts[i]);
        if (ip) return ip;
      }
    }
  }

  // 默认：直接连接地址，无法被请求头影响
  try {
    return normalizeIp(getConnInfo(c).remote.address) || "Unknown";
  } catch {
    return "Unknown";
  }
};
