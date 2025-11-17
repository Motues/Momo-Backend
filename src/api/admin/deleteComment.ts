import type koa from "koa";
import CommentService  from "../../orm/commentService";
import { getQueryNumber, getQueryBoolean, getQueryString } from "../../utils/url";
import { checkAdmin, checkKey } from "../../utils/security"
import { Comment, CreateCommentInput } from "../../type/prisma"

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  const deleteId =  getQueryNumber(ctx.query.id as string, 0);
  const key = getQueryString(ctx.query.key as string, "");

  if(!checkKey(key)) {
    ctx.status = 401;
    ctx.body = { error: "Invalid key" };
    return;
  }

  const comment = await CommentService.deleteComment(deleteId);
  ctx.body = {
    message: "Comment deleted, id: " + deleteId + "."
  };
}
