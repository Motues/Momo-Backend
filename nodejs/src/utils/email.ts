import * as nodemailer from 'nodemailer';
import LogService from "../utils/log";
import { getSetting } from "./settings";
import { getNotifyEmail } from "./adminEmails";
import { formatMailRecipients, logMail, type MailLogType } from "./mailLog";

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 应用自定义邮件模板：把 {{key}} 替换为转义后的值。
 * 与 Go 的 utils.applyTemplate、Worker 的 replace 链保持同一语义
 * （占位符替换 + HTML 转义），否则管理员自定义模板会把字面量 {{...}} 发到收件箱。
 *
 * `rawPlaceholders` 是**不转义**的占位符（`{{commentContentHtml}}` 等渲染后的 HTML）：
 * 它们的内容来自本站自己净化的 `content_html`，注入的 `<img>` 也只走白名单，
 * 与评论区的渲染边界一致（见 doc/mail.md 第 2/3 节）。两批占位符名字不重叠，
 * 但为了可读性仍然先替换转义批、再替换原样批。
 */
function applyTemplate(
  tpl: string,
  placeholders: Record<string, string>,
  rawPlaceholders: Record<string, string> = {}
): string {
  let html = Object.entries(placeholders).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), htmlEscape(value)),
    tpl
  );
  for (const [key, value] of Object.entries(rawPlaceholders)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value ?? '');
  }
  return html;
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
  /** 邮件类型（写外发邮件日志用，见 utils/mailLog.ts） */
  type: MailLogType;
}

/**
 * 底层 SMTP 发送函数。
 *
 * **所有**邮件都从这里发出，因此外发邮件日志（面板「邮件管理」）也统一在这里记：
 * 成功记 `sent`、失败记 `failed` 并把错误照旧抛给调用方（记日志不改变发送语义）。
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

  const recipient = formatMailRecipients(options.to);
  try {
    const info = await transporter.sendMail({
      from: options.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
    });
    await logMail({ type: options.type, recipient, subject: options.subject, status: "sent" });
    return info;
  } catch (error) {
    await logMail({ type: options.type, recipient, subject: options.subject, status: "failed", error });
    throw error;
  }
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
  parentCommentHtml,
  replyAuthor,
  replyContent,
  replyContentHtml,
  postUrl,
}: {
  toEmail: string;
  toName: string;
  postTitle: string;
  /** 原评论纯文本（转义后放进 {{parentComment}}） */
  parentComment: string;
  /** 原评论渲染后的 HTML（原样放进 {{parentCommentHtml}}） */
  parentCommentHtml?: string;
  replyAuthor: string;
  /** 回复纯文本（转义后放进 {{replyContent}}） */
  replyContent: string;
  /** 回复渲染后的 HTML（原样放进 {{replyContentHtml}}） */
  replyContentHtml?: string;
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
    const parentHtml = parentCommentHtml || htmlEscape(parentComment).replace(/\r?\n/g, '<br>');
    const replyHtml = replyContentHtml || htmlEscape(replyContent).replace(/\r?\n/g, '<br>');
    const template = await getTemplate("reply_template", "");
    // 面板预览（dashboard/src/utils/mailTemplates.js）照抄了下面这份默认模板：
    // 改动默认模板时请同步更新，见 doc/mail.md 第 7 节。
    const htmlContent = template
      ? applyTemplate(
          template,
          {
            toName,
            replyAuthor,
            postTitle,
            parentComment,
            replyContent,
            postUrl,
          },
          {
            parentCommentHtml: parentHtml,
            replyContentHtml: replyHtml,
          }
        )
      : `
        <div style="background-color: #f4f7f9; padding: 20px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); border: 1px solid #e1e4e8;">

            <div style="padding: 30px;">
              <h2 style="margin-top: 0; color: #333; font-size: 18px;">Hi ${htmlEscape(toName)}，</h2>
              <p style="color: #555; line-height: 1.6;">
                <strong>${htmlEscape(replyAuthor)}</strong> 回复了您在 <span style="color: #007acc;">《${htmlEscape(postTitle)}》</span> 中的评论：
              </p>

              <div style="margin: 20px 0; padding: 12px 16px; border-left: 4px solid #dfe3e8; background-color: #fcfcfc; color: #555; font-size: 14px;">
                ${parentHtml}
              </div>

              <p style="color: #333; font-weight: bold; margin-bottom: 8px;">最新回复：</p>

              <div style="margin-bottom: 30px; padding: 16px; border-radius: 6px; background-color: #f0f7ff; border-left: 4px solid #007acc; color: #2c3e50; line-height: 1.6; word-break: break-word;">
                ${replyHtml}
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
      type: "reply_notify",
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
  commentContentHtml,
}: {
  postTitle: string;
  postUrl: string;
  commentAuthor: string;
  /** 评论纯文本（转义后放进 {{commentContent}}） */
  commentContent: string;
  /** 评论渲染后的 HTML（原样放进 {{commentContentHtml}}） */
  commentContentHtml?: string;
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

  // 通知收件人是**解析后的** notify_email（必须命中管理员列表，见 doc/admin_emails.md 第 6 节）
  const adminEmail = await getNotifyEmail();
  if (!adminEmail) {
    LogService.warn('管理员邮箱未配置，无法发送通知');
    return null;
  }

  try {
    const contentHtml = commentContentHtml || htmlEscape(commentContent).replace(/\r?\n/g, '<br>');
    const template = await getTemplate("notification_template", "");
    // 面板预览（dashboard/src/utils/mailTemplates.js）照抄了下面这份默认模板：
    // 改动默认模板时请同步更新，见 doc/mail.md 第 7 节。
    const htmlContent = template
      ? applyTemplate(
          template,
          {
            postTitle,
            commentAuthor,
            commentContent,
            postUrl,
          },
          {
            commentContentHtml: contentHtml,
          }
        )
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
                <div style="color: #444; font-size: 15px; line-height: 1.8; word-break: break-word;">
                  ${contentHtml}
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
      type: "comment_notify",
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
import { eq, and, gte, sql } from "drizzle-orm";
import { normalizeEmail } from "./adminEmails";

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
 * 链接安全审查专用的「邮箱已验证」判定：按**归一化邮箱**（trim + 小写）匹配。
 *
 * 与 `checkEmailVerified` 的精确匹配刻意不同：`doc/link_security.md` 把「邮箱」定义为
 * `lower(trim(email))` 这个身份标识，历史评论的查找与批量改写也都用归一化比较，
 * 因此提交评论时邮箱的大小写/两侧空格不应该让「是否发确认邮件」的判定漏掉。
 * 既有邮箱验证流程（评论转待审核、验证后自动通过）的精确语义保持不变。
 */
export async function isEmailIdentityVerified(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (normalized === "") return false;
  const rows = await db
    .select({ id: schema.emailVerifications.id })
    .from(schema.emailVerifications)
    .where(
      and(
        sql`lower(trim(${schema.emailVerifications.email})) = ${normalized}`,
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
      type: "verify",
    });

    LogService.info("验证邮件已发送:", info.messageId);
    return info;
  } catch (error) {
    LogService.error("验证邮件发送失败:", error);
    return null;
  }
}

/**
 * 历史链接批量更新的**确认邮件**（见 doc/link_security.md 第 3.2 节）。
 *
 * 没有自定义模板：这封邮件是安全确认信，正文结构固定，避免管理员改坏关键信息。
 * 收件人就是提交新网址的那位评论者；只有能收到这封信的人才能确认改动。
 */
export async function sendLinkSyncEmail({
  toEmail,
  toName,
  siteName,
  oldUrl,
  newUrl,
  postTitle,
  confirmUrl,
}: {
  toEmail: string;
  toName: string;
  siteName: string;
  /** 该邮箱历史上出现过的一个旧网址（仅用于说明「会改哪些链接」） */
  oldUrl: string;
  newUrl: string;
  postTitle: string;
  confirmUrl: string;
}): Promise<nodemailer.SentMessageInfo | null> {
  const config = await getSmtpConfig();
  if (!config) {
    LogService.warn("链接同步确认邮件发送跳过：SMTP 服务未配置好");
    return null;
  }
  if (!(await isEmailEnabled())) {
    LogService.info("链接同步确认邮件发送跳过：邮件通知功能已关闭");
    return null;
  }

  try {
    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;">
        <h2 style="color: #333; margin-top: 0;">确认更新您的历史评论链接</h2>
        <p style="color: #555; line-height: 1.6;">
          Hi ${htmlEscape(toName)}，<br><br>
          您在 <strong>${htmlEscape(siteName)}</strong> 提交了一个新的个人网址，
          系统将把它同步到您以前发表的所有评论（只改「个人网站」字段，不改评论正文）。
        </p>
        <p style="color: #555; line-height: 1.6; margin-bottom: 4px;">新网址：</p>
        <p style="margin: 0 0 12px 0; padding: 10px 12px; background: #f0f7ff; border-radius: 4px; word-break: break-all; font-size: 14px; color: #0066cc;">
          ${htmlEscape(newUrl)}
        </p>
        ${oldUrl ? `<p style="color: #555; line-height: 1.6; margin-bottom: 4px;">将被替换的旧网址：</p>
        <p style="margin: 0 0 12px 0; padding: 10px 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 14px; color: #666;">
          ${htmlEscape(oldUrl)}
        </p>` : ""}
        ${postTitle ? `<p style="color: #999; font-size: 13px;">（最近一次评论：《${htmlEscape(postTitle)}》）</p>` : ""}
        <p style="color: #555; line-height: 1.6;">请点击下面的按钮确认（或把链接复制到浏览器打开）：</p>
        <p style="text-align: center; margin: 24px 0;">
          <a href="${htmlEscape(confirmUrl)}"
             style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px;">
            确认同步链接
          </a>
        </p>
        <p style="margin: 0 0 16px 0; padding: 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 13px; color: #0066cc;">
          ${htmlEscape(confirmUrl)}
        </p>
        <p style="color: #999; font-size: 13px;">
          此链接 24 小时内有效。如果您没有提交新网址，请忽略此邮件，您的历史评论不会被修改。
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>`;

    const info = await sendEmail(config, {
      from: await getSenderAddress(),
      to: toEmail,
      subject: `确认更新您在 ${siteName} 上的历史评论链接`,
      html: htmlContent,
      type: "link_sync",
    });

    LogService.info("链接同步确认邮件已发送:", info.messageId);
    return info;
  } catch (error) {
    LogService.error("链接同步确认邮件发送失败:", error);
    return null;
  }
}

/**
 * 休眠链接提醒邮件（见 doc/link_security.md 第 2.7 节）。
 *
 * 某位评论者很久没再来评论、其个人网址被判为休眠时发一封：告诉他自己不再从评论区跳转该链接，
 * 并给出提醒页 —— 他可以在那里确认「我仍在使用」（恢复正常 N 天）或直接提交新链接。
 *
 * SMTP 未配置 / 邮件通知关闭时返回 `null`（调用方据此**不落提醒记录**，下次读取会重试）。
 */
export async function sendDormantNoticeEmail({
  toEmail,
  toName,
  siteName,
  dormantUrl,
  noticeUrl,
  days,
}: {
  toEmail: string;
  toName: string;
  siteName: string;
  dormantUrl: string;
  noticeUrl: string;
  days: number;
}): Promise<nodemailer.SentMessageInfo | null> {
  const config = await getSmtpConfig();
  if (!config) {
    LogService.warn("休眠链接提醒邮件发送跳过：SMTP 服务未配置好");
    return null;
  }
  if (!(await isEmailEnabled())) {
    LogService.info("休眠链接提醒邮件发送跳过：邮件通知功能已关闭");
    return null;
  }

  try {
    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;">
        <h2 style="color: #333; margin-top: 0;">您的个人网站链接已进入休眠</h2>
        <p style="color: #555; line-height: 1.6;">
          Hi ${htmlEscape(toName)}，<br><br>
          您在 <strong>${htmlEscape(siteName)}</strong> 留下的这个个人网站链接已经很久没有新的评论活动。
          为防止域名被抢注、被指向博彩或钓鱼站点，本站已<strong>不再从评论区直接跳转</strong>它。
        </p>
        <p style="color: #555; line-height: 1.6; margin-bottom: 4px;">链接地址：</p>
        <p style="margin: 0 0 16px 0; padding: 10px 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 14px; color: #666;">
          ${htmlEscape(dormantUrl)}
        </p>
        <p style="color: #555; line-height: 1.6;">
          如果这个网站您还在使用，点下面的按钮确认一次即可<strong>恢复正常</strong>；
          如果已经换到了新地址，也可以在同一页面里直接提交新链接（会同步更新您在
          ${htmlEscape(siteName)} 的历史评论）。
        </p>
        <p style="text-align: center; margin: 24px 0;">
          <a href="${htmlEscape(noticeUrl)}"
             style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px;">
            查看并确认
          </a>
        </p>
        <p style="margin: 0 0 16px 0; padding: 12px; background: #f5f5f5; border-radius: 4px; word-break: break-all; font-size: 13px; color: #0066cc;">
          ${htmlEscape(noticeUrl)}
        </p>
        <p style="color: #999; font-size: 13px;">
          此链接 ${days} 天内有效。如果您已不再使用该链接，忽略本邮件即可。
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #999; font-size: 12px;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>`;

    const info = await sendEmail(config, {
      from: await getSenderAddress(),
      to: toEmail,
      subject: `您在 ${siteName} 的个人网站链接已进入休眠`,
      html: htmlContent,
      type: "dormant_notice",
    });

    LogService.info("休眠链接提醒邮件已发送:", info.messageId);
    return info;
  } catch (error) {
    LogService.error("休眠链接提醒邮件发送失败:", error);
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
    type: "test",
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