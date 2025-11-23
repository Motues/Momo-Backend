import type koa from "koa";
import { UAParser } from "ua-parser-js";
import CommentService  from "../../orm/commentService";
import { Comment, CreateCommentInput } from "../../type/prisma"
import { sendCommentReplyNotification, sendCommentNotification } from "../../utils/email";
import { canPostComment, checkContent} from "../../utils/security"
import LogService from "../../utils/log";

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  const data = ctx.request.body;
  const ip = ctx.request.headers['cf-connecting-ip'] as string || ctx.request.headers['x-real-ip'] as string || 
            (ctx.request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
            ctx.ip;
  // 检查评论时间
  if(!await canPostComment(ip)) {
    ctx.body = {
      message: "Time limit exceeded. Please wait before posting again."
    };
    return; 
  }
  // 创建评论
    const content = checkContent(data.content), author = checkContent(data.author);
    const uaParser = new UAParser(ctx.request.header['user-agent'] ?? "");
    const uaResult = uaParser.getResult();
    const commentData: CreateCommentInput = {
      pub_date: (new Date()).toISOString(),
      post_slug: data.post_slug,
      author: author,
      email: data.email,
      url: data.url,
      ip_address: ip,
      os: (uaResult.os.name || "") + " " + (uaResult.os.version || ""),
      browser: (uaResult.browser.name || "") + " " + (uaResult.browser.version || ""),
      device: uaResult.device.model || uaResult.device.type || uaResult.device.vendor || "",
      user_agent: ctx.request.header['user-agent'] || "",
      content_text: content,
      content_html: content,
      parent_id: data.parent_id ?? null,
      status: "approved"
    }
    const comment = await CommentService.createComment(commentData);
    // 发送邮件通知
    if(data.parent_id) {
      LogService.info("Reply comment", { Name: comment.author, Email: comment.email})
      const parentComment = await CommentService.getCommentById(data.parent_id);
      if(parentComment && parentComment.email !== data.email) {
        await sendCommentReplyNotification({
          toEmail: parentComment.email,
          toName: parentComment.author,
          postTitle: data.post_title,
          parentComment: parentComment.content_text,
          replyAuthor: author,
          replyContent: content,
          postUrl: data.post_url,
        });
      }
    } else {
      LogService.info("New comment", { Name: comment.author, Email: comment.email})
      await sendCommentNotification({
        postTitle: data.post_title,
        postUrl: data.post_url,
        commentAuthor: author,
        commentContent: content
      });
    }
    ctx.body = {
      message: "Comment submitted. Awaiting moderation."
    };
}
