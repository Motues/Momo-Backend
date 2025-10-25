import type koa from "koa";
import CommentService  from "../orm/commentService";
import { Comment, CreateCommentInput } from "../type/prisma"

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  const data = ctx.request.body;
//   console.log(data);
//   console.log("有新的评论");
  const commentData: CreateCommentInput = {
    pub_date: (new Date()).toISOString(),
    post_slug: data.post_slug,
    author: data.author,
    email: data.email,
    url: data.url,
    ip_address: ctx.ip,
    device: ctx.request.header['user-agent'] ?? "",
    browser: ctx.request.header['user-agent'] ?? "",
    content_text: data.content,
    content_html: data.content,
    parent_id: data.parent_id ?? null,
    status: "approved"
  }
  const comment = await CommentService.createComment(commentData);
  ctx.body = {
    message: "Comment submitted. Awaiting moderation."
  };
}
