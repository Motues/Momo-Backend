import type { Context } from "hono";
import { checkKey, extractToken } from "../../utils/security";
import { getQueryClampedNumber, getQueryString } from "../../utils/url";
import { listVerifyRecords } from "../../orm/verifyRecordService";

/**
 * 认证明细列表（GET /admin/verify/records）
 *
 * 查询参数：
 *  - page：页码，默认 1
 *  - pageSize：每页条数，默认 20，上限 100
 *  - event：`all` | `challenge` | `pass` | `fail`，默认 all
 *  - reason：失败原因精确匹配（如 `ip mismatch`）
 *  - ip：来源 IP 前缀匹配（便于按网段排查）
 *  - slug：文章标识精确匹配
 *  - days：时间窗口天数，默认 30；`all` 或 `0` 表示全部历史
 *
 * 三端（Node / Go / Worker）的参数语义与响应结构完全一致，见 doc/api.md。
 */
export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const rawDays = getQueryString(c.req.query("days"), "30").trim().toLowerCase();
  const parsedDays = rawDays === "all" ? 0 : parseInt(rawDays, 10);
  // 非法值（非数字、负数）回退默认 30；0 与 all = 全部历史；上限 365 —— 与 Go / Worker 一致
  const days = rawDays === "all"
    ? 0
    : Number.isFinite(parsedDays) && parsedDays >= 0
      ? Math.min(parsedDays, 365)
      : 30;

  const result = await listVerifyRecords({
    page: getQueryClampedNumber(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: getQueryClampedNumber(c.req.query("pageSize"), 20, 1, 100),
    event: getQueryString(c.req.query("event"), "all"),
    reason: getQueryString(c.req.query("reason"), ""),
    ip: getQueryString(c.req.query("ip"), ""),
    slug: getQueryString(c.req.query("slug"), ""),
    days,
  });

  return c.json({
    code: 200,
    message: "Verify records fetched successfully",
    data: result,
  });
};
