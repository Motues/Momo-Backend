import type koa from "koa";
import CommentService  from "../orm/commentService";
import { getQueryNumber, getQueryBoolean, getQueryString } from "../utils/url";
import { Comment, CreateCommentInput } from "../type/prisma"

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  const deleteId =  getQueryNumber(ctx.query.id as string, 0);
//   console.log(data);
//   console.log("有新的评论");
  const comment = await CommentService.deleteComment(deleteId);
  ctx.body = {
    message: "Comment deleted, id: " + deleteId + "."
  };
}
