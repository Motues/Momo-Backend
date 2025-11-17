import type koa from "koa";
import CommentService  from "../../orm/commentService";
import { getQueryNumber, getQueryBoolean, getQueryString } from "../../utils/url";
import { checkAdmin, checkKey } from "../../utils/security"

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  const commentId =  getQueryNumber(ctx.query.id as string, 0);
  const status =  getQueryString(ctx.query.status as string, "pending");
  const key = getQueryString(ctx.query.key as string, "");

  if(!checkKey(key)) {
    ctx.status = 401;
    ctx.body = { error: "Invalid key" };
    return;
  }

  await CommentService.updateCommentStatus(commentId, status);

  ctx.body = {
    message: `Comment status updated, id: ${commentId}, status: ${status}.`
  };
}