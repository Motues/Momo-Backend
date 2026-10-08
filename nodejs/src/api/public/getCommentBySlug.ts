import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { getQueryClampedNumber, getQueryBoolean, getQueryString } from "../../utils/url";
import { getResponseComment } from "../../utils/content";
import { getClientIP } from "../../utils/ip";
import { allowRequest } from "../../utils/rateLimit";

// 公开评论列表限流：缓解批量遍历 post_slug 采集博主邮箱哈希等爬取行为
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60 * 1000;

export default async (c: Context): Promise<Response> => {
  const ip = getClientIP(c);
  if (!allowRequest(`comments:get:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return c.json({ code: 429, message: "Too many requests. Please slow down." }, 429);
  }

  const postSlug = getQueryString(c.req.query("post_slug"), "");
  // 分页参数 clamp（C14）：page >= 1，1 <= limit <= 50，与 Go/Worker 一致
  const page = getQueryClampedNumber(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = getQueryClampedNumber(c.req.query("limit"), 20, 1, 50);
  const nested = getQueryBoolean(c.req.query("nested"), true);

  if (postSlug === "") {
    // 错误响应形状与 Go/Worker 对齐（C8）：必须带 code
    return c.json({ code: 400, message: "post_slug is required" }, 400);
  }

  const comments = await CommentService.getCommentBySlug(postSlug);
  return c.json(await getResponseComment(comments, page, limit, nested, postSlug));
};
