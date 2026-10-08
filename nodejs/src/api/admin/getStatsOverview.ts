import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken } from "../../utils/security";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  // range=all / range=0：最近 12 个月按月聚合；其余：最近 N 天（默认 7，上限 365）
  // 与 Go/Worker 统一（C9）：此前 parseInt("all") 得到 NaN 会退化成 7 天
  const rawRange = (c.req.query("range") || "").trim().toLowerCase();
  const isAll = rawRange === "all" || rawRange === "0";
  const parsedRange = parseInt(rawRange, 10);
  const range = isAll
    ? 0
    : Number.isFinite(parsedRange) && parsedRange > 0
      ? Math.min(parsedRange, 365)
      : 7;

  const stats = await CommentService.getStatsOverview(range);

  return c.json({
    code: 200,
    message: "Stats fetched successfully",
    data: stats,
  });
};
