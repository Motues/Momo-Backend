import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken } from "../../utils/security";
import { getQueryNumber, getQueryString } from "../../utils/url";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const page = getQueryNumber(c.req.query("page"), 1);
  const limit = getQueryNumber(c.req.query("limit"), 20);
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
