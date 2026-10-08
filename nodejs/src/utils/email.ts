import * as nodemailer from 'nodemailer';
import LogService from "../utils/log";
import { getSetting } from "./settings";

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 应用自定义邮件模板：把 {{key}} 替换为转义后的值。
 * 与 Go 的 utils.applyTemplate、Worker 的 replace 链保持同一语义
 * （占位符替换 + HTML 转义），否则管理员自定义模板会把字面量 {{...}} 发到收件箱。
 */
function applyTemplate(tpl: string, placeholders: Record<string, string>): string {
  return Object.entries(placeholders).reduce(
    (html, [key, value]) => html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), htmlEscape(value)),
    tpl
  );
}

// 核心接口与通用发送函数
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export interface EmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
}

/**
 * 底层 SMTP 发送函数
 */
async function sendEmail(config: SmtpConfig, options: EmailOptions): Promise<nodemailer.SentMessageInfo> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.auth.user,
      pass: config.auth.pass,
    },
  });

  return await transporter.sendMail({
    from: options.from,
    to: options.to,
    subject: options.subject,
    html: options.html,
  });
}

// 配置加载与状态检查
async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const dbHost = await getSetting("smtp_host");
  const dbUser = await getSetting("email_user");
  const dbPass = await getSetting("email_password");

  if (dbHost && dbUser && dbPass) {
    return {
      host: dbHost,
      port: Number(await getSetting("smtp_port")) || 465,
      secure: (await getSetting("email_secure")) === "true",
      auth: { user: dbUser, pass: dbPass },
    };
  }

  return null;
}

// 服务可用性检查
export async function isEmailServiceAvailable(): Promise<boolean> {
  return (await getSmtpConfig()) !== null;
}

// 生成发件人字符串，格式："显示名称" <user@domain.com>
async function getSenderAddress(): Promise<string> {
  const siteName = await getSetting("site_name") || 'Momo Blog';
  const userEmail = await getSetting("email_user");
  return `${siteName} 评论通知 <${userEmail}>`;
}

// 检查邮件通知是否启用（从设置读取）
async function isEmailEnabled(): Promise<boolean> {
  const enabled = await getSetting("email_enabled");
  return enabled !== "false";
}

// 获取邮件模板（优先使用用户自定义模板）
async function getTemplate(key: string, fallback: string): Promise<string> {
  const custom = await getSetting(key);
  return custom || fallback;
}

// 业务发送函数
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
  const config = await getSmtpConfig();

  if (!config) {
    LogService.warn('邮件发送跳过：SMTP 服务未配置好');
    return null;
  }

  if (!(await isEmailEnabled())) {
    LogService.info('邮件发送跳过：邮件通知功能已关闭');
    return null;
  }

  try {
    const template = await getTemplate("reply_template", "");
    const htmlContent = template
      ? applyTemplate(template, {
          toName,
          replyAuthor,
          postTitle,
          parentComment,
          replyContent,
          postUrl,
        })
      : `
        <div style="background-color: #f4f7f9; padding: 20px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); border: 1px solid #e1e4e8;">

            <div style="padding: 30px;">
              <h2 style="margin-top: 0; color: #333; font-size: 18px;">Hi ${htmlEscape(toName)}，</h2>
              <p style="color: #555; line-height: 1.6;">
                <strong>${htmlEscape(replyAuthor)}</strong> 回复了您在 <span style="color: #007acc;">《${htmlEscape(postTitle)}》</span> 中的评论：
              </p>

              <div style="margin: 20px 0; padding: 12px 16px; border-left: 4px solid #dfe3e8; background-color: #fcfcfc; color: #555; font-size: 14px;">
                ${htmlEscape(parentComment)}
              </div>

              <p style="color: #333; font-weight: bold; margin-bottom: 8px;">最新回复：</p>

              <div style="margin-bottom: 30px; padding: 16px; border-radius: 6px; background-color: #f0f7ff; border-left: 4px solid #007acc; color: #2c3e50; line-height: 1.6;">
                ${htmlEscape(replyContent)}
              </div>

              <div style="text-align: center;">
                <a href="${htmlEscape(postUrl)}"
                   style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; box-shadow: 0 2px 5px rgba(0,122,204,0.2);">
                  点击查看回复
                </a>
              </div>
            </div>

            <div style="background-color: #fafbfc; padding: 15px 30px; border-top: 1px solid #eeeeee; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #999;">
                此邮件由系统自动发送，请勿直接回复。<br>
              </p>
            </div>
          </div>
        </div>`;

    const info = await sendEmail(config, {
      from: await getSenderAddress(),
      to: toEmail,
      subject: `您在 ${await getSetting("site_name") || 'Momo Blog'} 上的评论有了新回复`,
      html: htmlContent,
    });

    LogService.info('评论回复通知邮件已发送:', info.messageId);
    return info;
  } catch (error) {
    LogService.error('评论回复通知邮件发送失败:', error);
    return null;
  }
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
  const config = await getSmtpConfig();

  if (!config) {
    LogService.warn('邮件发送跳过：SMTP 服务未配置好');
    return null;
  }

  if (!(await isEmailEnabled())) {
    LogService.info('邮件发送跳过：邮件通知功能已关闭');
    return null;
  }

  // 检查是否配置了管理员接收邮箱
  const adminEmail = await getSetting("admin_email");
  if (!adminEmail) {
    LogService.warn('管理员邮箱未配置，无法发送通知');
    return null;
  }

  try {
    const template = await getTemplate("notification_template", "");
    const htmlContent = template
      ? applyTemplate(template, {
          postTitle,
          commentAuthor,
          commentContent,
          postUrl,
        })
      : `
        <div style="background-color: #f6f8fa; padding: 40px 20px; min-height: 100%; font-family: 'PingFang SC', 'Microsoft YaHei', Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.05); overflow: hidden;">

            <div style="height: 4px; background: linear-gradient(90deg, #007acc, #00c6ff);"></div>

            <div style="padding: 32px;">
              <h2 style="margin: 0 0 16px 0; color: #1a1a1a; font-size: 20px; line-height: 1.4;">
                有人在您的文章下发表了评论
              </h2>

              <p style="color: #555; font-size: 15px; margin-bottom: 24px; line-height: 1.6;">
                <strong style="color: #007acc;">${htmlEscape(commentAuthor)}</strong> 评论了您的文章
                <b style="color: #1a1a1a;">《${htmlEscape(postTitle)}》</b>：
              </p>

              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; border: 1px dashed #e1e4e8; margin-bottom: 32px;">
                <div style="color: #444; font-size: 15px; line-height: 1.8; word-break: break-all;">
                  ${htmlEscape(commentContent)}
                </div>
              </div>

              <div style="text-align: center;">
                <a href="${htmlEscape(postUrl)}"
                   style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 32px; text-decoration: none; border-radius: 50px; font-weight: 500; font-size: 15px; transition: all 0.3s ease;">
                  立即前往查看
                </a>
              </div>
            </div>

            <div style="background-color: #fafbfc; padding: 20px; text-align: center; border-top: 1px solid #f0f0f0;">
              <p style="margin: 0; font-size: 13px; color: #99aab5; line-height: 1.5;">
                此邮件由系统自动发送，请勿直接回复。
              </p>
            </div>
          </div>
        </div>`;

    const info = await sendEmail(config, {
      from: await getSenderAddress(),
      to: adminEmail,
      subject: `您在 ${await getSetting("site_name") || 'Momo Blog'} 上有新的评论`,
      html: htmlContent,
    });

    LogService.info('新评论通知邮件已发送:', info.messageId);
    return info;
  } catch (error) {
    LogService.error('新评论通知邮件发送失败:', error);
    return null;
  }
}

// ---- 邮箱验证相关 ----
import { db, schema } from "../orm/client";
import { eq, and, gte } from "drizzle-orm";

/**
 * 检查邮箱是否已验证
 */
export async function checkEmailVerified(email: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.emailVerifications)
    .where(
      and(
        eq(schema.emailVerifications.email, email),
        eq(schema.emailVerifications.verified, 1)
      )
    )
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * 保存验证令牌
 */
export async function saveVerificationToken(
  email: string,
  token: string,
  expiresAt: string,
  postSlug?: string,
  postTitle?: string
): Promise<void> {
  await db
    .insert(schema.emailVerifications)
    .values({
      email,
      token,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      verified: 0,
      post_slug: postSlug || null,
      post_title: postTitle || null,
    })
    .run();
}

/**
 * 检查邮箱是否存在未过期的未验证令牌（避免重复发送）
 */
export async function hasUnverifiedToken(email: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.emailVerifications)
    .where(
      and(
        eq(schema.emailVerifications.email, email),
        eq(schema.emailVerifications.verified, 0),
        gte(schema.emailVerifications.expires_at, new Date().toISOString())
      )
    )
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * 批准某邮箱的所有待审核评论
 */
export async function approvePendingComments(email: string): Promise<number> {
  const result = await db
    .update(schema.comments)
    .set({ status: "approved" })
    .where(
      and(
        eq(schema.comments.email, email),
        eq(schema.comments.status, "pending")
      )
    )
    .run();
  return result.changes || 0;
}

/**
 * 发送验证邮件
 */
export async function sendVerificationEmail({
  toEmail,
  toName,
  postTitle,
  postSlug,
  verifyUrl,
}: {
  toEmail: string;
  toName: string;
  postTitle: string;
  postSlug: string;
  verifyUrl: string;
}) {
  const config = await getSmtpConfig();
  if (!config) {
    LogService.warn("验证邮件发送跳过：SMTP 服务未配置好");
    return null;
  }

  if (!(await isEmailEnabled())) {
    LogService.info("验证邮件发送跳过：邮件通知功能已关闭");
    return null;
  }

  try {
    const siteName = (await getSetting("site_name")) || "Momo Blog";

    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;">
        <h2 style="color: #333; margin-top: 0;">验证您的邮箱地址</h2>
        <p style="color: #555; line-height: 1.6;">
          Hi ${htmlEscape(toName)}，<br><br>
          您在 <strong>${htmlEscape(siteName)}</strong> 的文章
          <strong>《${htmlEscape(postTitle)}》</strong> 中提交了评论。
        </p>
        <p style="color: #555; line-height: 1.6;">
          请访问以下链接验证您的邮箱（或复制到浏览器打开）：
        </p>
        <p style="margin: 24px 0; padding: 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 14px; color: #0066cc;">
          ${htmlEscape(verifyUrl)}
        </p>
        <p style="color: #999; font-size: 13px;">此链接 24 小时内有效。如果您没有提交评论，请忽略此邮件。</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>`;

    const info = await sendEmail(config, {
      from: await getSenderAddress(),
      to: toEmail,
      subject: `请验证您在 ${htmlEscape(siteName)} 上的评论邮箱`,
      html: htmlContent,
    });

    LogService.info("验证邮件已发送:", info.messageId);
    return info;
  } catch (error) {
    LogService.error("验证邮件发送失败:", error);
    return null;
  }
}

export async function sendTestEmail(toEmail: string): Promise<void> {
  const config = await getSmtpConfig();
  if (!config) {
    throw new Error('SMTP is not configured. ');
  }

  if (!(await isEmailEnabled())) {
    throw new Error('The email notification feature is currently disabled. ');
  }

  const siteName = await getSetting("site_name") || 'Momo Blog';

  await sendEmail(config, {
    from: await getSenderAddress(),
    to: toEmail,
    subject: `SMTP 配置验证`,
    html: `<div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;">
      <h2 style="color: #333; margin-top: 0;">SMTP 配置测试</h2>
      <p style="color: #555; line-height: 1.6;">这是一封来自 <strong>${siteName}</strong> 的测试邮件。</p>
      <p style="color: #555; line-height: 1.6;">如果收到此邮件，说明 SMTP 配置正确，邮件通知功能可以正常使用。</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿直接回复。</p>
    </div>`,
  });

  LogService.info('测试邮件已发送至:', toEmail);
}