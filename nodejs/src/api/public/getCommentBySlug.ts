import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { getQueryNumber, getQueryBoolean, getQueryString } from "../../utils/url";
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
  const page = getQueryNumber(c.req.query("page"), 1);
  const limit = getQueryNumber(c.req.query("limit"), 20);
  const nested = getQueryBoolean(c.req.query("nested"), true);

  if (postSlug === "") {
    return c.json({ error: "Invalid post_slug" }, 400);
  }

  const comments = await CommentService.getCommentBySlug(postSlug);
  return c.json(await getResponseComment(comments, page, limit, nested, postSlug));
};
