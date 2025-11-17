import type koa from "koa";
import CommentService from "../../orm/commentService";
import { Comment } from "../../type/prisma";
import { getResponseCommentAdmin } from "../../utils/content";
import { checkAdmin, checkKey } from "../../utils/security"
import { getQueryNumber, getQueryBoolean, getQueryString } from "../../utils/url";

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {

  const data = ctx.request.body;

//   console.log(data);

  if(!checkAdmin(data.name, data.password)) {
    ctx.status = 401;
    ctx.body = { message: "Invalid username or password" };
    return;
  }
  
  ctx.body = {
    data: { key: process.env.ADMIN_KEY }
  };
};