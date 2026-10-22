import { Context } from 'hono';
import { UAParser } from 'ua-parser-js';
import { Bindings } from '../../bindings';
import { sendCommentNotification, sendCommentReplyNotification, sendVerificationEmail, checkEmailVerified, hasUnverifiedToken, saveVerificationToken, isEmailServiceAvailable } from '../../utils/email';
import { isEmailEnabled, getSetting } from '../../utils/settings';
import { getAdminConfig, isAdminMember, normalizeEmail } from '../../utils/adminEmails';
import { requestLinkSyncIfNeeded } from './linkSyncConfirm';
import { checkRequestSource, isSourceDenied } from '../../utils/origin';
import { isVerifyEnabled, checkVerifyDomain, verifyTicket } from '../../utils/verify';
import { checkCommentSpam } from '../../utils/spam';
import { parseMarkdown } from '../../utils/markdown';
import { toMillis } from '../../utils/time';
import {
  checkContent,
  sanitizeUrl,
  sanitizePostSlug,
  countCodePoints,
  parseIpBlacklist,
  ipMatchesBlacklist,
  MAX_CONTENT,
  MAX_AUTHOR,
  MAX_EMAIL,
  MAX_URL,
  MAX_POST_SLUG,
} from '../../utils/security';

// 兼容既有导入路径（净化逻辑已统一到 utils/security）
export { checkContent } from '../../utils/security';

async function checkIpBlacklist(env: Bindings, ip: string): Promise<boolean> {
  const blacklistStr = await getSetting(env, "ip_blacklist");
  if (!blacklistStr) return false;

  const blacklist = parseIpBlacklist(blacklistStr);
  if (blacklist === null) {
    // 配置损坏：保持放行（避免因一条坏配置导致全站无法评论），但必须留下告警
    console.warn("[security] ip_blacklist 不是合法 JSON 数组，黑名单检查已被跳过，请在后台修复该配置");
    return false;
  }
  return ipMatchesBlacklist(ip, blacklist);
}

async function checkEmailBlacklist(env: Bindings, email: string): Promise<boolean> {
  const blacklistStr = await getSetting(env, "email_blacklist");
  if (!blacklistStr) return false;
  try {
    const blacklist = JSON.parse(blacklistStr);
    if (!Array.isArray(blacklist)) {
      console.warn("[security] email_blacklist 不是数组，黑名单检查已被跳过，请在后台修复该配置");
      return false;
    }
    // 不区分大小写匹配，与拉黑接口的小写归一化保持一致
    return blacklist.some((entry: unknown) => String(entry).toLowerCase() === email.toLowerCase());
  } catch {
    console.warn("[security] email_blacklist 不是合法 JSON，黑名单检查已被跳过，请在后台修复该配置");
    return false;
  }
}

async function getCommentStatus(env: Bindings): Promise<string> {
  const autoApprove = await getSetting(env, "comment_auto_approve");
  return autoApprove === "false" ? "pending" : "approved";
}

/**
 * 结果链接的基地址：优先使用手动配置的 verify_base_url，否则从请求头推断。
 * 邮箱验证、历史链接同步与休眠提醒共用同一口径（都在 `c.executionCtx.waitUntil` 里发信）。
 */
export async function resolveBaseUrl(c: Context<{ Bindings: Bindings }>): Promise<string> {
  let baseUrl = (await getSetting(c.env, "verify_base_url"))?.trim();
  if (!baseUrl) {
    const origin = c.req.header("Origin") || c.req.header("Host") || "";
    const protocol = origin.includes("localhost") || origin.includes("127.0.0.1") ? "http" : "https";
    baseUrl = origin.startsWith("http") ? origin : `${protocol}://${origin}`;
  }
  return baseUrl.replace(/\/+$/, "");
}

export const postComment = async (c: Context<{ Bindings: Bindings }>) => {
  const data = await c.req.json();
  const userAgent = c.req.header('user-agent') || "";

  // 1. 必填字段校验（含类型）
  if (
    typeof data?.post_slug !== "string" ||
    typeof data?.author !== "string" ||
    typeof data?.email !== "string" ||
    typeof data?.content !== "string" ||
    !data.post_slug.trim() ||
    !data.author.trim() ||
    !data.email.trim() ||
    !data.content.trim()
  ) {
    return c.json({ code: 400, message: "post_slug, author, email, and content are required" }, 400);
  }

  // 1.1 长度上限校验：避免 MB 级内容触发 CPU 时长与存储风险
  const overLimit =
    countCodePoints(data.post_slug) > MAX_POST_SLUG ||
    data.author.length > MAX_AUTHOR ||
    data.email.length > MAX_EMAIL ||
    data.content.length > MAX_CONTENT ||
    (typeof data.url === "string" && data.url.length > MAX_URL);
  if (overLimit) {
    return c.json({
      code: 400,
      message: `Field too long (content ≤ ${MAX_CONTENT}, author ≤ ${MAX_AUTHOR}, email ≤ ${MAX_EMAIL}, url ≤ ${MAX_URL}, post_slug ≤ ${MAX_POST_SLUG})`,
    }, 400);
  }

  // 1.2 来源域名绑定（comment_verify_domain_enabled）：
  // 与下面的通用来源校验共用同一份白名单，但语义更严 —— allow_origin 未配置或为 `*` 时
  // **不跳过**（fail-closed），而且要求票据与本请求同域。
  //
  // 刻意排在通用来源校验**之前**：开启域名绑定时它是更严的那道闸门，让被拒请求统一拿到
  // 域名的 reason（DOMAIN_NOT_ALLOWED）而不是笼统的 ORIGIN_NOT_ALLOWED，便于博主区分
  // 「白名单没配好」与「别的站点在滥用」。位置同样早于限流 / 黑名单 / 发信路径。
  const domain = await checkVerifyDomain(c.env, {
    origin: c.req.header("origin"),
    referer: c.req.header("referer"),
    postUrl: data.post_url,
  });
  if (!domain.ok) {
    console.warn(`[security] 拒绝来源未授权的评论提交（域名校验）：${domain.decision}`, domain.origin, data.post_slug);
    return c.json({
      code: 403,
      message: "Request source is not allowed. Add this site to the allow-origin list in the dashboard.",
      reason: "DOMAIN_NOT_ALLOWED",
    }, 403);
  }

  // 1.3 服务端来源校验：CORS 只是浏览器机制，挡不住「对方站点在自己的服务端转发」。
  // allow_origin 配置成白名单（非空且不含 *）时，写接口只接受来自白名单的提交请求；
  // 判定必须早于限流 / 黑名单 / 人机验证与**一切发信路径**（验证邮件、站长通知、回复通知），
  // 否则白名单外的站点照样能借本站 SMTP 发信。口径见 doc/vectors/origin-v1.json。
  const sourceDecision = checkRequestSource({
    allowOrigin: await getSetting(c.env, "allow_origin"),
    origin: c.req.header("origin"),
    referer: c.req.header("referer"),
    postUrl: data.post_url,
  });
  if (isSourceDenied(sourceDecision)) {
    console.warn(`[security] 拒绝来源未授权的评论提交：${sourceDecision}`, data.post_slug);
    return c.json({
      code: 403,
      message: "Request source is not allowed. Add this site to the allow-origin list in the dashboard.",
      reason: "ORIGIN_NOT_ALLOWED",
    }, 403);
  }

  // 2. 获取 IP：cf-connecting-ip 由 Cloudflare 在边缘覆写，客户端无法伪造。
  // 注意：设置项 trust_proxy 仅对 Node/Go 生效（它们可能直连或位于自建代理后），
  // Worker 始终使用 Cloudflare 提供的该请求头。
  const ip = c.req.header('cf-connecting-ip') || "127.0.0.1";

  // 3. 管理员身份判定（口径见 doc/admin_emails.md）：命中管理员列表（admin_emails，
  //    列表为空时回落旧键 admin_email）即为博主；成员判定 = admins.includes(normalize(email))。
  // 必须早于限流与黑名单检查，因为管理员邮箱不受 60 秒评论冷却限制。
  const adminConfig = await getAdminConfig(c.env);
  const isAdminEmail = isAdminMember(adminConfig.admins, data.email);

  // 4. 检查评论频率控制（管理员邮箱不限流）
  if (!isAdminEmail) {
    const lastComment = await c.env.MOMO_DB.prepare(
      "SELECT pub_date FROM Comment WHERE ip_address = ? ORDER BY pub_date DESC LIMIT 1"
    ).bind(ip).first<{ pub_date: unknown }>();

    if (lastComment) {
      // pub_date 统一为毫秒整数；toMillis 同时兼容历史 ISO 字符串
      const lastTime = toMillis(lastComment.pub_date);
      if (lastTime !== null && Date.now() - lastTime < 60 * 1000) {
        return c.json({ code: 429, message: "Time limit exceeded. Please wait." }, 429);
      }
    }
  }

  // 3. 检查 IP 黑名单
  if (await checkIpBlacklist(c.env, ip)) {
    return c.json({ code: 403, message: "Your IP has been blocked" }, 403);
  }

  // 4. 检查邮箱黑名单
  if (data.email && await checkEmailBlacklist(c.env, data.email)) {
    return c.json({ code: 403, message: "Your email has been blocked" }, 403);
  }

  // 5. 管理员评论密钥验证（adminEmail 已在上方读取）
  const adminCommentKey = await getSetting(c.env, "admin_comment_key") || "";
  const adminCommentKeyEnabled = await getSetting(c.env, "admin_comment_key_enabled") || "false";
  let isAdminVerified = false;
  if (isAdminEmail && adminCommentKey && adminCommentKeyEnabled === "true") {
    if (data.admin_key === adminCommentKey) {
      isAdminVerified = true;
    } else {
      return c.json({ code: 403, message: "Invalid admin key" }, 403);
    }
  }

  // 5.1 无感验证票据校验（管理员密钥已通过的博主不受影响）
  if (!isAdminVerified && await isVerifyEnabled(c.env)) {
    // 票据里的 slug 是**净化后**的值（见 verifySolution 里签发票据时传入的 sanitizePostSlug），
    // 所以这里必须用同一套净化规则处理后才能比对 —— 否则只要文章标识里含有
    // checkContent 会改写的片段（例如 <script>…</script>），签出的票据就永远兑不掉，
    // 真人会持续收到假 VERIFY_REQUIRED。
    //
    // 注意只对「票据比对」用净化值：评论落库仍用原始 data.post_slug，
    // 因为读取端是按原始 slug 查询的，改动存储口径会让评论查不出来。
    const ticketOk = await verifyTicket(c.env, data.verify_ticket, ip, sanitizePostSlug(data.post_slug), domain.orgHash);
    if (!ticketOk) {
      return c.json({
        code: 403,
        message: "Human verification failed or expired",
        reason: "VERIFY_REQUIRED",
      }, 403);
    }
  }

  // 6. 准备数据 - 所有用户输入均需净化
  const content = checkContent(data.content);
  const author = checkContent(data.author);
  // url 走协议白名单（只允许 http/https/mailto 与相对路径）
  const url = sanitizeUrl(data.url);
  const postTitle = checkContent(typeof data.post_title === "string" ? data.post_title : '');
  const postUrl = sanitizeUrl(data.post_url);
  const uaParser = new UAParser(userAgent);
  const uaResult = uaParser.getResult();

  // 审核自动化：只有在「本来会直接通过」时才跑垃圾规则 ——
  // comment_auto_approve = "false" 时全部评论都要人工审核，规则判定没有意义；
  // 博主（管理员密钥已验证）的评论直接通过，不受规则影响。
  let status = isAdminVerified ? "approved" : await getCommentStatus(c.env);
  if (!isAdminVerified && status === "approved") {
    const spamReason = await checkCommentSpam(c.env, { content, author, url, ip });
    if (spamReason) {
      status = "pending";
      console.log("评论被审核自动化判为垃圾，已转入待审核:", spamReason, data.post_slug);
    }
  }

  // 邮箱验证检查
  let needsVerification = false;
  const emailVerifyEnabled = await getSetting(c.env, "email_verify_enabled");
  // 前置条件与 Node/Go 对齐：SMTP 三项配置齐全才置 pending，
  // 否则会把评论卡在「待审核」却永远发不出验证邮件
  if (emailVerifyEnabled === "true" && !isAdminVerified && (await isEmailServiceAvailable(c.env))) {
    const isVerified = await checkEmailVerified(c.env, data.email);
    if (!isVerified) {
      needsVerification = true;
      status = "pending";

      if (!(await hasUnverifiedToken(c.env, data.email))) {
        const token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await saveVerificationToken(c.env, data.email, token, expiresAt, data.post_slug, postTitle);

        const verifyUrl = `${await resolveBaseUrl(c)}/api/verify-email/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(data.email)}`;

        c.executionCtx.waitUntil((async () => {
          try {
            await sendVerificationEmail(c.env, {
              toEmail: data.email,
              toName: author,
              postTitle: postTitle,
              postSlug: data.post_slug,
              verifyUrl,
            });
          } catch (e) {
            console.error("验证邮件发送失败:", e);
          }
        })());
      }
    }
  }

  // 6. 写入 D1 数据库
  try {
    // content_html 既落库也用于通知邮件的「渲染后正文」（doc/mail.md）
    const contentHtml = await parseMarkdown(content);
    const { success } = await c.env.MOMO_DB.prepare(`
      INSERT INTO Comment (
        pub_date, post_slug, author, email, url, ip_address,
        os, browser, device, user_agent, content_text, content_html,
        parent_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      // pub_date 统一为毫秒整数（与 Node/Go 一致，见 utils/migrations.ts）
      Date.now(),
      data.post_slug,
      author,
      data.email,
      url,
      ip,
      `${uaResult.os.name || ""} ${uaResult.os.version || ""}`.trim(),
      `${uaResult.browser.name || ""} ${uaResult.browser.version || ""}`.trim(),
      uaResult.device.model || uaResult.device.type || "Desktop",
      userAgent,
      content,
      contentHtml,
      data.parent_id || null,
      status
    ).run();

    if (!success) throw new Error("Database insert failed");

    // 5. 发送邮件通知 (后台异步执行，不阻塞用户响应)
    if (await isEmailEnabled(c.env)) {
      console.log("Sending email notification...");
      c.executionCtx.waitUntil((async () => {
        try {
          if (data.parent_id) {
            // 回复逻辑：查询父评论信息（含渲染后的 HTML，供 {{parentCommentHtml}} 使用）
            const parentComment = await c.env.MOMO_DB.prepare(
              "SELECT author, email, content_text, content_html FROM Comment WHERE id = ?"
            ).bind(data.parent_id).first<{ author: string, email: string, content_text: string, content_html: string }>();

            if (parentComment && parentComment.email !== data.email) {
              await sendCommentReplyNotification(c.env, {
                toEmail: parentComment.email,
                toName: parentComment.author,
                postTitle: postTitle,
                parentComment: parentComment.content_text,
                parentCommentHtml: parentComment.content_html,
                replyAuthor: author,
                replyContent: content,
                replyContentHtml: contentHtml,
                postUrl: postUrl,
              });
            }
          } else {
            // 新评论通知站长（收件人 = 解析后的 notify_email）
            await sendCommentNotification(c.env, {
              postTitle: postTitle,
              postUrl: postUrl,
              commentAuthor: author,
              commentContent: content,
              commentContentHtml: contentHtml,
            });
          }
        } catch (mailError) {
          console.error("Mail Notification Failed:", mailError);
        }
      })());
    }else{
      console.log("No SMTP configuration found. Skipping email notification.");
    }

    // 5.1 历史链接批量更新（doc/link_security.md 第 3 节）：满足全部条件才写待确认记录 + 异步发确认邮件，
    // 不阻塞评论提交，也不改任何历史评论。
    await requestLinkSyncIfNeeded(
      c.env,
      {
        email: normalizeEmail(data.email),
        newUrl: url,
        author,
        postTitle,
        postUrl,
        baseUrl: await resolveBaseUrl(c),
      },
      (promise) => c.executionCtx.waitUntil(promise)
    );

    return c.json({
      code: 200,
      message: needsVerification
        ? "Comment submitted! Verification email sent. Please check your inbox."
        : "Comment submitted"
    });

  } catch (e: any) {
    console.error("Create Comment Error:", e);
    return c.json({ code: 500, message: "Internal Server Error" }, 500);
  }
};
