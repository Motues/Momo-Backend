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

  const author = getQueryString(c.req.query("author"), "");
  const email = getQueryString(c.req.query("email"), "");
  // 分页参数 clamp（C14）：page >= 1
  const page = getQueryClampedNumber(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);

  if (!author || !email) {
    return c.json({ code: 400, message: "author and email are required" }, 400);
  }

  const result = await CommentService.getUserComments(author, email, page);

  return c.json({
    code: 200,
    message: "User comments fetched successfully",
    data: result,
  });
};
