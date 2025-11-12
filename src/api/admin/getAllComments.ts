import type koa from "koa";
import CommentService from "../../orm/commentService";
import { Comment } from "../../type/prisma";
import { groupCommentsByPost } from "../../utils/content";

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  // 获取所有评论
  const comments: Comment[] = await CommentService.getAllComments();
  
  // 按文章slug分组评论
  const groupedComments = groupCommentsByPost(comments);
  
  ctx.body = {
    data: groupedComments
  };
};