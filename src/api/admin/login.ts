import type koa from "koa";
import CommentService from "../../orm/commentService";
import { Comment } from "../../type/prisma";
import { getResponseCommentAdmin } from "../../utils/content";
import { checkAdmin, checkKey, generateTempKey } from "../../utils/security"
import { getQueryNumber, getQueryBoolean, getQueryString } from "../../utils/url";
import LogService from "../../utils/log";

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {

  const data = ctx.request.body;
  const ip = ctx.request.headers['cf-connecting-ip'] as string || ctx.request.headers['x-real-ip'] as string || 
            (ctx.request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
            ctx.ip;

//   console.log(data);

  if(!checkAdmin(data.name, data.password)) {
    ctx.status = 401;
    ctx.body = { message: "Invalid username or password" };
    LogService.warn("Login failed", { ip: ip});
    return;
  }

  LogService.info("Login successful", { ip: ip});
  
  // 生成临时密钥
  const tempKey = generateTempKey(data.name);
  
  ctx.body = {
    data: { key: tempKey }
  };
};