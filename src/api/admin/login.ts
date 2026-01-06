import type koa from "koa";
import CommentService from "../../orm/commentService";
import { Comment } from "../../type/prisma";
import { getResponseCommentAdmin } from "../../utils/content";
import { checkAdmin, checkKey, generateTempKey } from "../../utils/security"
import { getQueryNumber, getQueryBoolean, getQueryString } from "../../utils/url";
import LogService from "../../utils/log";
import { isIPBlocked, recordFailedAttempt, recordSuccessfulLogin } from "../../utils/ipSecurity";

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {

  const data = ctx.request.body;
  const ip = ctx.request.headers['cf-connecting-ip'] as string || ctx.request.headers['x-real-ip'] as string || 
            (ctx.request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
            ctx.ip;

  // 检查IP是否被阻止
  if (isIPBlocked(ip)) {
    ctx.status = 403;
    ctx.body = { message: "IP is blocked due to multiple failed login attempts" };
    LogService.warn("Blocked IP attempted to login", { ip: ip });
    return;
  }

//   console.log(data);

  if(!checkAdmin(data.name, data.password)) {
    const isBlocked = recordFailedAttempt(ip);
    ctx.status = 401;
    ctx.body = { message: "Invalid username or password" };
    LogService.warn("Login failed", { ip: ip, failedAttempts: recordFailedAttempt });
    if (isBlocked) {
      ctx.status = 403;
      ctx.body = { message: "IP is blocked due to multiple failed login attempts" };
    }
    return;
  }

  // 登录成功后清除失败尝试记录
  recordSuccessfulLogin(ip);
  LogService.info("Login successful", { ip: ip});
  
  // 生成临时密钥
  const tempKey = generateTempKey(data.name);
  
  ctx.body = {
    data: { key: tempKey }
  };
};