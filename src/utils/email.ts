import { Resend } from 'resend';
import LogService from "../utils/log";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendCommentReplyNotification({
  toEmail,
  toName,
  postTitle,
  parentComment,
  replyAuthor,
  replyContent,
  postUrl,
}: {
  toEmail: string;
  toName: string;
  postTitle: string;
  parentComment: string;
  replyAuthor: string;
  replyContent: string;
  postUrl: string;
}) {
  const { data, error } = await resend.emails.send({
    from: `评论通知 ${process.env.RESEND_FROM_EMAIL}`, // 替换为你验证过的域名邮箱
    to: toEmail,
    subject: `你在 blog.motues.top 上的评论有了新回复`,
    html: `
      <p>Hi ${toName}，</p>
      <p>${replyAuthor} 回复了你在 <b>${postTitle}</b> 中的评论：</p>
      <blockquote style="margin: 10px 0; padding-left: 10px; border-left: 3px solid #ccc;">
        ${parentComment}
      </blockquote>
      <p>回复内容：</p>
      <blockquote style="margin: 10px 0; padding-left: 10px; border-left: 3px solid #007acc;">
        ${replyContent}
      </blockquote>
      <p>
        <a href="${postUrl}" 
           style="background: #007acc; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">
          查看回复
        </a>
      </p>
      <hr>
      <p><small>此邮件由系统自动发送，请勿直接回复。</small></p>
    `,
  });

  if (error) {
    // console.error('邮件发送失败:', error);
    LogService.error('邮件发送失败:', error);
    throw new Error('Failed to send email');
  }

  // console.log('邮件已发送:', data.id);
  LogService.info('邮件已发送:', data.id);
  return data;
}

export async function sendCommentNotification({
  postTitle,
  postUrl,
  commentAuthor,
  commentContent,
}: {
  postTitle: string;
  postUrl: string;
  commentAuthor: string;
  commentContent: string;
}) { 
  const { data, error } = await resend.emails.send({
    from: `评论通知 ${process.env.RESEND_FROM_EMAIL}`, // 替换为你验证过的域名邮箱
    to: process.env.EMAIL_ADDRESS as string,
    subject: `你在 blog.motues.top 上有新的评论`,
    html: `
      <p>${commentAuthor} 评论了你的文章 <b>${postTitle}</b>：</p>
      <p>回复内容：</p>
      <blockquote style="margin: 10px 0; padding-left: 10px; border-left: 3px solid #ccc;">
        ${commentContent}
      </blockquote>
      <p>
        <a href="${postUrl}" 
           style="background: #007acc; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px;">
          查看评论
        </a>
      </p>
      <hr>
      <p><small>此邮件由系统自动发送，请勿直接回复。</small></p>
    `,
  });

  if (error) {
    // console.error('邮件发送失败:', error);
    LogService.error('邮件发送失败:', error);
    throw new Error('Failed to send email');
  }

  // console.log('邮件已发送:', data.id);
  LogService.info('邮件已发送:', data.id);
  return data;
}