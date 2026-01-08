import { Context } from 'hono';
import { UAParser } from 'ua-parser-js';
import { Bindings } from '../../bindings';
import { sendCommentNotification, sendCommentReplyNotification } from '../../utils/email';

// 检查内容，将<script>标签之间的内容删除
export function checkContent(content: string): string {
    return content.replace(/<script[\s\S]*?<\/script>/g, "");
}

export const postComment = async (c: Context<{ Bindings: Bindings }>) => {
  const data = await c.req.json();
  const userAgent = c.req.header('user-agent') || "";
  
  // 1. 获取 IP (Worker 获取 IP 的标准方式)
  const ip = c.req.header('cf-connecting-ip') || "127.0.0.1";

  // 2. 检查评论频率控制 (对应 canPostComment)
  // 这里建议使用 D1 查最近一条评论的时间，或者直接放行（如果使用了 Cloudflare WAF）
  const lastComment = await c.env.MOMO_DB.prepare(
    "SELECT pub_date FROM Comment WHERE ip_address = ? ORDER BY pub_date DESC LIMIT 1"
  ).bind(ip).first<{ pub_date: string }>();

  if (lastComment) {
    const lastTime = new Date(lastComment.pub_date).getTime();
    if (Date.now() - lastTime < 60 * 1000) { // 10秒限流示例
      return c.json({ message: "Time limit exceeded. Please wait." }, 429);
    }
  }

  // 3. 准备数据
  const content = checkContent(data.content);
  const author = checkContent(data.author);
  const uaParser = new UAParser(userAgent);
  const uaResult = uaParser.getResult();

  // 4. 写入 D1 数据库
  try {
    const { success } = await c.env.MOMO_DB.prepare(`
      INSERT INTO Comment (
        pub_date, post_slug, author, email, url, ip_address, 
        os, browser, device, user_agent, content_text, content_html, 
        parent_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      new Date().toISOString(),
      data.post_slug,
      author,
      data.email,
      data.url || null,
      ip,
      `${uaResult.os.name || ""} ${uaResult.os.version || ""}`.trim(),
      `${uaResult.browser.name || ""} ${uaResult.browser.version || ""}`.trim(),
      uaResult.device.model || uaResult.device.type || "Desktop",
      userAgent,
      content,
      content, // content_html 保持一致
      data.parent_id || null,
      "approved" // 或者从环境变量读取默认状态
    ).run();

    if (!success) throw new Error("Database insert failed");

    // 5. 发送邮件通知 (后台异步执行，不阻塞用户响应)
    if (c.env.RESEND_API_KEY) {
      c.executionCtx.waitUntil((async () => {
        try {
          if (data.parent_id) {
            // 回复逻辑：查询父评论信息
            const parentComment = await c.env.MOMO_DB.prepare(
              "SELECT author, email, content_text FROM Comment WHERE id = ?"
            ).bind(data.parent_id).first<{ author: string, email: string, content_text: string }>();

            if (parentComment && parentComment.email !== data.email) {
              await sendCommentReplyNotification(c.env, {
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
            // 新评论通知站长
            await sendCommentNotification(c.env, {
              postTitle: data.post_title,
              postUrl: data.post_url,
              commentAuthor: author,
              commentContent: content
            });
          }
        } catch (mailError) {
          console.error("Mail Notification Failed:", mailError);
        }
      })());
    }

    return c.json({ message: "Comment submitted. Awaiting moderation." });

  } catch (e: any) {
    console.error("Create Comment Error:", e);
    return c.json({ message: "Internal Server Error" }, 500);
  }
};