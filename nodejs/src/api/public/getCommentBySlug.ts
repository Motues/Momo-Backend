import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { getQueryNumber, getQueryBoolean, getQueryString } from "../../utils/url";
import { getResponseComment } from "../../utils/content";

export default async (c: Context): Promise<Response> => {
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
