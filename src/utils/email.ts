import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendCommentReplyNotification({
  toEmail,
  toName,
  postTitle,
  parentComment,
  replyAuthor,
  replyContent,
  postUrl,
  replyId,
}: {
  toEmail: string;
  toName: string;
  postTitle: string;
  parentComment: string;
  replyAuthor: string;
  replyContent: string;
  postUrl: string;
  replyId: number;
}) {
  const { data, error } = await resend.emails.send({
    from: '评论通知 <notify@notifications.motues.top>', // 替换为你验证过的域名邮箱
    to: toEmail,
    subject: `你在 motues.top 上的评论有了新回复`,
    html: `
      <p>Hi ${toName}，</p>
      <p>${replyAuthor} 回复了你在${postTitle}中的评论：</p>
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
    console.error('邮件发送失败:', error);
    throw new Error('Failed to send email');
  }

  console.log('邮件已发送:', data.id);
  return data;
}