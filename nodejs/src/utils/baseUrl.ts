import { getSetting } from "./settings";

/**
 * 邮件里链接的「站点基址」：优先用手动配置的 `verify_base_url`，否则从请求头推断。
 *
 * 邮箱验证、历史链接同步确认、休眠链接提醒三封邮件共用同一口径
 * （原先这段逻辑只存在于评论提交路径，多一个调用方后抽到这里）。
 */
export async function resolveBaseUrl(headers: {
  origin?: string | null;
  host?: string | null;
}): Promise<string> {
  const configured = await getSetting("verify_base_url");
  if (configured) return configured.replace(/\/+$/, "");

  const origin = headers.origin || headers.host || "";
  const protocol = origin.includes("localhost") || origin.includes("127.0.0.1") ? "http" : "https";
  const base = origin.startsWith("http") ? origin : `${protocol}://${origin}`;
  return base.replace(/\/+$/, "");
}
