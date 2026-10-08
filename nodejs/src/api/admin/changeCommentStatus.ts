import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { getQueryNumber, getQueryString } from "../../utils/url";
import { checkKey, extractToken, isValidCommentStatus } from "../../utils/security";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const commentId = getQueryNumber(c.req.query("id"), 0);
  const status = getQueryString(c.req.query("status"), "pending");

  if (!commentId) {
    return c.json({ code: 400, message: "Invalid comment id" }, 400);
  }

  // 状态枚举白名单：拒绝任意字符串写入状态机
  if (!isValidCommentStatus(status)) {
    return c.json(
      { code: 400, message: "Invalid status. Allowed: pending, approved, rejected, deleted" },
      400
    );
  }

  await CommentService.updateCommentStatus(commentId, status);

  return c.json({ code: 200, message: `Comment status updated` });
};
