import type { Context } from "hono";
import { checkKey, extractToken } from "../../utils/security";
import { getQueryClampedNumber, getQueryString } from "../../utils/url";
import { listMailLogs } from "../../utils/mailLog";

/**
 * 邮件管理（管理面板「邮件管理」页）
 *
 * `GET /admin/mails?page=&pageSize=&status=&type=&search=`
 *
 * 只读列表：外发邮件日志（真正尝试发送的邮件），保留天数由设置项
 * `mail_log_retention_days` 决定（默认 30 天，0 = 永久保留）。
 * `status` / `type` / `search` 与 `pageSize` 的宽容口径与其它管理端列表一致。
 */
export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const page = getQueryClampedNumber(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = getQueryClampedNumber(c.req.query("pageSize"), 20, 1, 100);

  const data = await listMailLogs({
    page,
    pageSize,
    status: getQueryString(c.req.query("status"), "all"),
    type: getQueryString(c.req.query("type"), "all"),
    search: getQueryString(c.req.query("search"), ""),
  });

  return c.json({
    code: 200,
    message: "Mails fetched successfully",
    data,
  });
};
