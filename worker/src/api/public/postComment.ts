import { Context } from 'hono';
import { UAParser } from 'ua-parser-js';
import { Bindings } from '../../bindings';
import { sendCommentNotification, sendCommentReplyNotification, sendVerificationEmail, checkEmailVerified, hasUnverifiedToken, saveVerificationToken, isEmailServiceAvailable } from '../../utils/email';
import { isEmailEnabled, getSetting } from '../../utils/settings';
import { isVerifyEnabled, verifyTicket } from '../../utils/verify';
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

  // 2. 获取 IP：cf-connecting-ip 由 Cloudflare 在边缘覆写，客户端无法伪造。
  // 注意：设置项 trust_proxy 仅对 Node/Go 生效（它们可能直连或位于自建代理后），
  // Worker 始终使用 Cloudflare 提供的该请求头。
  const ip = c.req.header('cf-connecting-ip') || "127.0.0.1";

  // 3. 管理员身份判定（只依赖 admin_email）：
  // 必须早于限流与黑名单检查，因为管理员邮箱不受 60 秒评论冷却限制。
  const adminEmail = await getSetting(c.env, "admin_email") || "";
  const isAdminEmail = !!adminEmail && data.email === adminEmail;

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
    const ticketOk = await verifyTicket(c.env, data.verify_ticket, ip, sanitizePostSlug(data.post_slug));
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

        // 优先使用手动配置的验证地址，否则从请求头推断
        let baseUrl = await getSetting(c.env, "verify_base_url");
        if (!baseUrl) {
          const origin = c.req.header("Origin") || c.req.header("Host") || "";
          const protocol = origin.includes("localhost") || origin.includes("127.0.0.1") ? "http" : "https";
          baseUrl = origin.startsWith("http") ? origin : `${protocol}://${origin}`;
        }
        const verifyUrl = `${baseUrl.replace(/\/+$/, "")}/api/verify-email/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(data.email)}`;

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
      await parseMarkdown(content),
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
            // 回复逻辑：查询父评论信息
            const parentComment = await c.env.MOMO_DB.prepare(
              "SELECT author, email, content_text FROM Comment WHERE id = ?"
            ).bind(data.parent_id).first<{ author: string, email: string, content_text: string }>();

            if (parentComment && parentComment.email !== data.email) {
              await sendCommentReplyNotification(c.env, {
                toEmail: parentComment.email,
                toName: parentComment.author,
                postTitle: postTitle,
                parentComment: parentComment.content_text,
                replyAuthor: author,
                replyContent: content,
                postUrl: postUrl,
              });
            }
          } else {
            // 新评论通知站长
            await sendCommentNotification(c.env, {
              postTitle: postTitle,
              postUrl: postUrl,
              commentAuthor: author,
              commentContent: content
            });
          }
        } catch (mailError) {
          console.error("Mail Notification Failed:", mailError);
        }
      })());
    }else{
      console.log("No SMTP configuration found. Skipping email notification.");
    }

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
