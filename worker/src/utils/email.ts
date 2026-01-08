import { Bindings } from '../bindings';

/**
 * 通用 Resend API 请求函数
 */
async function resendFetch(env: Bindings, body: object) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const status = response.status;
    
    // 对应你提供的状态码逻辑
    const errorMap: Record<number, string> = {
      400: '参数错误，请检查格式',
      401: 'API Key 缺失',
      403: 'API Key 无效',
      429: '发送频率过快',
    };

    const msg = errorMap[status] || `Resend 服务器错误 (${status})`;
    throw new Error(`${msg}: ${JSON.stringify(errorData)}`);
  }

  return await response.json();
}

/**
 * 回复通知邮件
 */
export async function sendCommentReplyNotification(
  env: Bindings,
  params: {
    toEmail: string;
    toName: string;
    postTitle: string;
    parentComment: string;
    replyAuthor: string;
    replyContent: string;
    postUrl: string;
  }
) {
  const { toEmail, toName, postTitle, parentComment, replyAuthor, replyContent, postUrl } = params;

  return await resendFetch(env, {
    from: `评论通知 ${env.RESEND_FROM_EMAIL}`,
    to: [toEmail],
    subject: `你在 momo.motues.top 上的评论有了新回复`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <p>Hi <b>${toName}</b>，</p>
        <p>${replyAuthor} 回复了你在 <b>${postTitle}</b> 中的评论：</p>
        <blockquote style="margin: 10px 0; padding: 10px; border-left: 4px solid #e2e8f0; background: #f8fafc;">
          ${parentComment}
        </blockquote>
        <p>最新回复：</p>
        <blockquote style="margin: 10px 0; padding: 10px; border-left: 4px solid #3b82f6; background: #eff6ff;">
          ${replyContent}
        </blockquote>
        <p style="margin-top: 20px;">
          <a href="${postUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">
            查看完整回复
          </a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin-top: 30px;">
        <p style="font-size: 12px; color: #999;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>
    `
  });
}

/**
 * 站长通知邮件
 */
export async function sendCommentNotification(
  env: Bindings,
  params: {
    postTitle: string;
    postUrl: string;
    commentAuthor: string;
    commentContent: string;
  }
) {
const { postTitle, postUrl, commentAuthor, commentContent } = params;

  return await resendFetch(env, {
    from: `评论提醒 ${env.RESEND_FROM_EMAIL}`,
    to: [env.EMAIL_ADDRESS],
    subject: `新评论通知：${postTitle}`,
    html: `
      <div style="font-family: sans-serif;">
        <p><b>${commentAuthor}</b> 在文章《${postTitle}》下发表了评论：</p>
        <div style="padding: 15px; border: 1px solid #ddd; border-radius: 8px;">
          ${commentContent}
        </div>
        <p><a href="${postUrl}">点击跳转到文章</a></p>
      </div>
    `
  });
}