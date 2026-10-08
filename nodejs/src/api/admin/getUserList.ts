import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken } from "../../utils/security";
import { getQueryClampedNumber, getQueryString } from "../../utils/url";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  // 分页参数 clamp（C14）：page >= 1，1 <= limit <= 100
  const page = getQueryClampedNumber(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = getQueryClampedNumber(c.req.query("limit"), 20, 1, 100);
  const search = getQueryString(c.req.query("search"), "");

  // 邮箱验证筛选：all（默认）/ true（已验证）/ false（未验证）
  let verified = getQueryString(c.req.query("verified"), "all").trim().toLowerCase();
  if (verified !== "true" && verified !== "false") {
    verified = "all";
  }

  const result = await CommentService.getUserList(page, limit, search, verified);

  return c.json({
    code: 200,
    message: "Users fetched successfully",
    data: result,
  });
};
