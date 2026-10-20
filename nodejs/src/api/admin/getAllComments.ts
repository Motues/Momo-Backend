import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { Comment } from "../../type/prisma";
import { getResponseCommentAdmin } from "../../utils/content";
import { checkKey, extractToken } from "../../utils/security";
import { getQueryClampedNumber, getQueryString } from "../../utils/url";

export default async (c: Context): Promise<Response> => {
  // 分页参数 clamp（C14）：page >= 1
  const page = getQueryClampedNumber(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const status = getQueryString(c.req.query("status"), "");
  // 文章标识精确筛选（数据统计页「热门文章」点击跳转用）；为空表示不筛选
  const postSlug = getQueryString(c.req.query("postSlug"), "").trim();
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  // 获取所有评论（可按状态、文章标识筛选）
  const comments: Comment[] = await CommentService.getAllComments(
    status || undefined,
    postSlug || undefined
  );

  const groupedComments = await getResponseCommentAdmin(comments, page);

  return c.json(groupedComments);
};
