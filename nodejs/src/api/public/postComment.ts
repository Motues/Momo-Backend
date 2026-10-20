import crypto from "crypto";
import type { Context } from "hono";
import { UAParser } from "ua-parser-js";
import CommentService from "../../orm/commentService";
import { CreateCommentInput } from "../../type/prisma";
import { sendCommentReplyNotification, sendCommentNotification, isEmailServiceAvailable, checkEmailVerified, saveVerificationToken, hasUnverifiedToken, sendVerificationEmail } from "../../utils/email";
import { canPostComment, checkContent, countCodePoints, MAX_POST_SLUG, sanitizePostSlug, sanitizeHtml, sanitizeUrl, checkIpBlacklist, checkEmailBlacklist, getCommentStatus } from "../../utils/security";
import { checkCommentSpam } from "../../utils/spam";
import { checkRequestSource, isSourceDenied } from "../../utils/origin";
import { getSetting } from "../../utils/settings";
import { resolveBaseUrl } from "../../utils/baseUrl";
import { getAdminEmailList, isAdminEmail as matchesAdminEmail } from "../../utils/adminEmails";
import { resolveEmojiConfigs } from "../../utils/emoji";
import { loadEmailEmojiMap, renderEmailContent } from "../../utils/emailEmoji";
import { offerLinkSync } from "../../utils/linkSync";
import { isVerifyEnabled, checkVerifyDomain, verifyTicket } from "../../utils/verify";
import { parseMarkdown } from "../../utils/markdown";
import { getClientIP } from "../../utils/ip";
import LogService from "../../utils/log";

// 字段长度上限（与前端组件约束对齐）
const MAX_CONTENT = 2000;
const MAX_AUTHOR = 100;
const MAX_EMAIL = 254;
const MAX_URL = 500;

/**
 * 站点对外基础地址（不带尾部斜杠）：统一从 utils/baseUrl.ts 取，
 * 邮箱验证 / 链接同步确认 / 休眠链接提醒三封邮件共用同一口径。
 */
async function resolveRequestBaseUrl(c: Context): Promise<string> {
  return resolveBaseUrl({ origin: c.req.header("Origin"), host: c.req.header("Host") });
}


export default async (c: Context): Promise<Response> => {
  try {
    const data = await c.req.json();
    const ip = getClientIP(c);

    // 必填字段校验（同时校验类型，避免非字符串导致后续处理抛错）
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
      return c.json(
        { code: 400, message: "post_slug, author, email, and content are required" },
        400
      );
    }

    // 长度上限校验：避免 MB 级内容导致数据库膨胀与 Markdown 渲染 CPU 放大
    const overLimit =
      countCodePoints(data.post_slug) > MAX_POST_SLUG ||
      data.author.length > MAX_AUTHOR ||
      data.email.length > MAX_EMAIL ||
      data.content.length > MAX_CONTENT ||
      (typeof data.url === "string" && data.url.length > MAX_URL);
    if (overLimit) {
      return c.json(
        {
          code: 400,
          message: `Field too long (content ≤ ${MAX_CONTENT}, author ≤ ${MAX_AUTHOR}, email ≤ ${MAX_EMAIL}, url ≤ ${MAX_URL}, post_slug ≤ ${MAX_POST_SLUG})`,
        },
        400
      );
    }

    // 来源域名绑定（comment_verify_domain_enabled）：
    // 与下面的通用来源校验共用同一份白名单，但语义更严 —— allow_origin 未配置或为 `*` 时
    // **不跳过**（fail-closed），而且要求票据与本请求同域。
    //
    // 刻意排在通用来源校验**之前**：开启域名绑定时它是更严的那道闸门，让被拒请求统一拿到
    // 域名的 reason（DOMAIN_NOT_ALLOWED）而不是笼统的 ORIGIN_NOT_ALLOWED，便于博主区分
    // 「白名单没配好」与「别的站点在滥用」。位置同样早于限流 / 黑名单 / 发信路径。
    const domain = await checkVerifyDomain({
      origin: c.req.header("origin"),
      referer: c.req.header("referer"),
      postUrl: data.post_url,
    });
    if (!domain.ok) {
      LogService.warn("拒绝来源未授权的评论提交（域名校验）", {
        decision: domain.decision,
        origin: domain.origin,
        post_slug: data.post_slug,
      });
      return c.json(
        {
          code: 403,
          message: "Request source is not allowed. Add this site to the allow-origin list in the dashboard.",
          reason: "DOMAIN_NOT_ALLOWED",
        },
        403
      );
    }

    // 服务端来源校验：CORS 只是浏览器机制，挡不住「对方站点在自己的服务端转发」。
    // allow_origin 配置成白名单（非空且不含 *）时，写接口只接受来自白名单的提交请求；
    // 判定必须早于限流 / 黑名单 / 人机验证与**一切发信路径**（验证邮件、站长通知、回复通知），
    // 否则白名单外的站点照样能借本站 SMTP 发信。口径见 doc/vectors/origin-v1.json。
    const sourceDecision = checkRequestSource({
      allowOrigin: await getSetting("allow_origin"),
      origin: c.req.header("origin"),
      referer: c.req.header("referer"),
      postUrl: data.post_url,
    });
    if (isSourceDenied(sourceDecision)) {
      LogService.warn("拒绝来源未授权的评论提交", { decision: sourceDecision, post_slug: data.post_slug });
      return c.json(
        {
          code: 403,
          message: "Request source is not allowed. Add this site to the allow-origin list in the dashboard.",
          reason: "ORIGIN_NOT_ALLOWED",
        },
        403
      );
    }

    // 管理员身份判定（只依赖管理员邮箱列表，见 doc/admin_emails.md 第 5 节）：
    // 必须早于限流与黑名单检查，因为管理员邮箱不受 60 秒评论冷却限制。
    const adminEmails = await getAdminEmailList();
    const isAdmin = matchesAdminEmail(data.email, adminEmails);

    // 检查评论时间（管理员邮箱不限流）
    if (!isAdmin && !(await canPostComment(ip))) {
      return c.json({ code: 429, message: "Time limit exceeded" }, 429);
    }

    // 检查 IP 黑名单
    if (await checkIpBlacklist(ip)) {
      return c.json({ code: 403, message: "Your IP has been blocked" }, 403);
    }

    // 检查邮箱黑名单
    if (data.email && (await checkEmailBlacklist(data.email))) {
      return c.json({ code: 403, message: "Your email has been blocked" }, 403);
    }

    // 管理员评论密钥验证（管理员列表已在上方读取）
    const adminCommentKey = (await getSetting("admin_comment_key")) || "";
    const adminCommentKeyEnabled =
      (await getSetting("admin_comment_key_enabled")) || "false";
    let isAdminVerified = false;
    if (isAdmin && adminCommentKey && adminCommentKeyEnabled === "true") {
      if (data.admin_key === adminCommentKey) {
        isAdminVerified = true;
      } else {
        return c.json({ code: 403, message: "Invalid admin key" }, 403);
      }
    }

    // 无感验证票据校验（管理员密钥已通过的博主不受影响）
    if (!isAdminVerified && (await isVerifyEnabled())) {
      // 票据里的 slug 是**净化后**的值（见 verifySolution.ts 的 createTicket 调用），
      // 所以这里必须用同一套净化规则处理后才能比对 —— 否则只要文章标识里含有
      // checkContent 会改写的片段（例如 <script>…</script>），签出的票据就永远兑不掉，
      // 真人会持续收到假 VERIFY_REQUIRED。
      //
      // 注意只对「票据比对」用净化值：评论落库仍用原始 post_slug，
      // 因为读取端是按原始 post_slug 查询的，改动存储口径会让评论查不出来。
      const ticketSlug = sanitizePostSlug(data.post_slug);
      const ticketOk = await verifyTicket(data.verify_ticket, ip, ticketSlug, domain.orgHash);
      if (!ticketOk) {
        return c.json(
          {
            code: 403,
            message: "Human verification failed or expired",
            reason: "VERIFY_REQUIRED",
          },
          403
        );
      }
    }

    // 对所有用户输入进行 XSS 检查
    const content = checkContent(data.content);
    const author = checkContent(data.author);
    // url 走协议白名单（只允许 http/https/mailto 与相对路径）
    const url = sanitizeUrl(data.url);
    const postTitle = checkContent(typeof data.post_title === "string" ? data.post_title : "");
    const postUrl = sanitizeUrl(data.post_url);
    const uaParser = new UAParser(c.req.header("user-agent") ?? "");
    const uaResult = uaParser.getResult();

    // 审核自动化：只有在「本来会直接通过」时才跑垃圾规则 ——
    // comment_auto_approve = "false" 时全部评论都要人工审核，规则判定没有意义；
    // 博主（管理员密钥已验证）的评论直接通过，不受规则影响。
    let status = isAdminVerified ? "approved" : await getCommentStatus();
    if (!isAdminVerified && status === "approved") {
      const spamReason = await checkCommentSpam({
        content,
        author,
        url,
        ip,
      });
      if (spamReason) {
        status = "pending";
        LogService.info("评论被审核自动化判为垃圾，已转入待审核", {
          reason: spamReason,
          post_slug: data.post_slug,
          email: data.email,
        });
      }
    }

    const commentData: CreateCommentInput = {
      pub_date: Date.now(),
      post_slug: data.post_slug,
      author: author,
      email: data.email,
      url: url,
      ip_address: ip,
      os: (uaResult.os.name || "") + " " + (uaResult.os.version || ""),
      browser: (uaResult.browser.name || "") + " " + (uaResult.browser.version || ""),
      device: uaResult.device.model || uaResult.device.type || uaResult.device.vendor || "",
      user_agent: c.req.header("user-agent") || "",
      content_text: content,
      content_html: sanitizeHtml(await parseMarkdown(content)),
      parent_id: data.parent_id ?? null,
      status,
    };

    // 邮箱验证检查
    let needsVerification = false;
    const emailVerifyEnabled = await getSetting("email_verify_enabled");
    if (emailVerifyEnabled === "true" && !isAdminVerified && (await isEmailServiceAvailable())) {
      const isVerified = await checkEmailVerified(data.email);
      if (!isVerified) {
        needsVerification = true;
        commentData.status = "pending";

        // 避免重复发送验证邮件（已有未过期的未验证令牌）
        if (!(await hasUnverifiedToken(data.email))) {
          const token = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          await saveVerificationToken(data.email, token, expiresAt, data.post_slug, postTitle);

          // 优先使用手动配置的验证地址，否则从请求头推断
          const baseUrl = await resolveRequestBaseUrl(c);
          const verifyUrl = `${baseUrl}/api/verify-email/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(data.email)}`;

          // 异步发送验证邮件
          sendVerificationEmail({
            toEmail: data.email,
            toName: author,
            postTitle: postTitle,
            postSlug: data.post_slug,
            verifyUrl,
          }).catch((e) => LogService.error("验证邮件发送失败:", e));
        }
      }
    }

    const comment = await CommentService.createComment(commentData);

    // 发送邮件通知（不影响评论结果）
    try {
      if (await isEmailServiceAvailable()) {
        // 通知邮件发的是**渲染后的 HTML**（Markdown 图片/链接 + 表情包小图），
        // 表情短代码由发信路径按配置来源拉取后水合，见 doc/mail.md
        const emojiConfig = resolveEmojiConfigs(
          await getSetting("emoji_cdn_urls"),
          await getSetting("emoji_cdn_url"),
          await getSetting("emoji_enabled")
        );
        const emojiImages =
          emojiConfig.enabled === "false" ? null : await loadEmailEmojiMap(emojiConfig.urls);

        if (data.parent_id) {
          LogService.info("Reply comment", { Name: comment.author, Email: comment.email });
          const parentComment = await CommentService.getCommentById(data.parent_id);
          if (parentComment && parentComment.email !== data.email) {
            await sendCommentReplyNotification({
              toEmail: parentComment.email,
              toName: parentComment.author,
              postTitle: postTitle,
              parentComment: parentComment.content_text,
              parentCommentHtml: renderEmailContent(
                parentComment.content_html,
                parentComment.content_text,
                emojiImages
              ),
              replyAuthor: author,
              replyContent: content,
              replyContentHtml: renderEmailContent(
                comment.content_html,
                comment.content_text,
                emojiImages
              ),
              postUrl: postUrl,
            });
          }
        } else {
          LogService.info("New comment", { Name: comment.author, Email: comment.email });
          await sendCommentNotification({
            postTitle: postTitle,
            postUrl: postUrl,
            commentAuthor: author,
            commentContent: content,
            commentContentHtml: renderEmailContent(
              comment.content_html,
              comment.content_text,
              emojiImages
            ),
          });
        }
      }
    } catch (e) {
      LogService.error("邮件发送失败（不影响评论提交）:", e);
    }

    // 历史链接批量更新：如果这位评论者（同邮箱、已验证）提交了新的个人网址，
    // 发一封确认邮件，确认后才把他所有历史评论的旧网址改成新网址。
    // 任何失败都不影响评论提交（见 doc/link_security.md 第 3 节）。
    if (url) {
      await offerLinkSync({
        email: data.email,
        author,
        newUrl: url,
        postTitle,
        baseUrl: await resolveRequestBaseUrl(c),
      });
    }

    return c.json({
      code: 200,
      message: needsVerification
        ? "Comment submitted! Verification email sent. Please check your inbox."
        : "Comment submitted successfully",
    });
  } catch (error) {
    LogService.error("评论提交异常:", error);
    return c.json(
      { code: 500, message: "Internal server error" },
      500
    );
  }
};
