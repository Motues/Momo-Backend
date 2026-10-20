import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import {
  deleteDormantNotice,
  findDormantNoticeByToken,
} from "../../orm/dormantNoticeService";
import { sanitizeUrl } from "../../utils/security";
import { getSetting } from "../../utils/settings";
import {
  DAY_MS,
  LINK_DORMANT_DAYS_KEY,
  isTrustActive,
  resolveDormantDays,
} from "../../utils/linkSecurity";
import LogService from "../../utils/log";

/**
 * 休眠链接提醒页（见 doc/link_security.md 第 2.7 节）。
 *
 * 邮件里的纯链接，收件人可能在任何设备/浏览器上打开，因此与邮箱验证、链接同步确认一样
 * 是**服务端渲染的中文 HTML 页**，不跳转前端、不需要登录：邮件里的令牌就是凭据。
 *
 * 三个动作：
 *  - `GET  /api/link-dormant/notice?token=`  打开提醒页（确认 / 提交新链接两个表单）
 *  - `POST /api/link-dormant/confirm?token=` 「我仍在使用」→ 恢复正常 N 天
 *  - `POST /api/link-dormant/update?token=`  提交新链接（批量更新该邮箱历史评论）
 */

const htmlEscape = (text: unknown): string =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** 结果页：与邮箱验证结果页同一套视觉（成功绿 / 失败红） */
export function dormantNoticeResultPage(success: boolean, message: string): string {
  const icon = success ? "&#10003;" : "&#10007;";
  const color = success ? "#28a745" : "#dc3545";
  const title = success ? "操作成功" : "操作失败";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 链接休眠提醒</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 48px 40px;
      max-width: 420px;
      width: 90%;
      text-align: center;
    }
    .icon { font-size: 64px; color: ${color}; margin-bottom: 16px; }
    h1 { font-size: 24px; color: #1a1a1a; margin: 0 0 12px 0; }
    p { font-size: 15px; color: #555; line-height: 1.6; margin: 0 0 24px 0; }
    .footer { font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${htmlEscape(message)}</p>
    <div class="footer">此页面由系统自动生成</div>
  </div>
</body>
</html>`;
}

/** 提醒页：显示当前链接 + 两个动作表单（确认仍在用 / 提交新链接） */
export function dormantNoticePage(options: {
  siteName: string;
  url: string;
  token: string;
  days: number;
}): string {
  const { siteName, url, token, days } = options;
  const tokenQuery = `token=${encodeURIComponent(token)}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>链接休眠提醒 - ${htmlEscape(siteName)}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      min-height: 100vh;
      padding: 40px 16px;
      box-sizing: border-box;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 36px 32px;
      max-width: 520px;
      width: 100%;
    }
    h1 { font-size: 22px; color: #1a1a1a; margin: 0 0 12px 0; }
    p { font-size: 15px; color: #555; line-height: 1.7; margin: 0 0 16px 0; }
    .link {
      padding: 10px 12px;
      background: #f5f5f5;
      border-radius: 6px;
      word-break: break-all;
      font-size: 14px;
      color: #666;
      margin-bottom: 24px;
    }
    .section { border-top: 1px solid #eee; padding-top: 20px; margin-top: 4px; }
    .section h2 { font-size: 15px; color: #333; margin: 0 0 12px 0; }
    button {
      display: inline-block;
      background-color: #007acc;
      color: #fff;
      border: none;
      padding: 11px 24px;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background-color: #0062a3; }
    input[type="url"] {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .hint { font-size: 12px; color: #999; margin-top: 20px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>链接已休眠</h1>
    <p>
      您在 <strong>${htmlEscape(siteName)}</strong> 留下的这个个人网站链接已经很久没有新的评论活动。
      为防止域名被抢注、被指向博彩或钓鱼站点，本站目前<strong>不再从评论区直接跳转</strong>它。
    </p>
    <p style="margin-bottom: 6px;">当前链接：</p>
    <div class="link">${htmlEscape(url)}</div>

    <div class="section">
      <h2>1. 这个网站我还在用</h2>
      <form method="post" action="/api/link-dormant/confirm?${tokenQuery}">
        <button type="submit">我仍在使用</button>
      </form>
    </div>

    <div class="section">
      <h2>2. 我已经换了新地址</h2>
      <form method="post" action="/api/link-dormant/update?${tokenQuery}">
        <input type="url" name="url" placeholder="https://example.com" required />
        <button type="submit">提交新链接</button>
      </form>
    </div>

    <p class="hint">
      确认后 ${days} 天内不会再标记为休眠；提交新链接会同时更新您在
      ${htmlEscape(siteName)} 历史评论里的个人网址。
    </p>
  </div>
</body>
</html>`;
}

/** 读取令牌并返回有效记录；失效/过期时直接给出结果页响应 */
async function resolveNotice(c: Context) {
  const token = String(c.req.query("token") ?? "").trim();
  if (!token) {
    return { response: c.html(dormantNoticeResultPage(false, "缺少提醒参数。")) };
  }
  const record = await findDormantNoticeByToken(token);
  if (!record) {
    return { response: c.html(dormantNoticeResultPage(false, "该提醒已失效或已处理。")) };
  }
  if (!isTrustActive(record.expires_at, Date.now())) {
    return { response: c.html(dormantNoticeResultPage(false, "该提醒已过期，请在评论区留言或等待新的提醒邮件。")) };
  }
  return { record };
}

/** GET /api/link-dormant/notice?token= */
export async function linkDormantNoticePage(c: Context): Promise<Response> {
  try {
    const resolved = await resolveNotice(c);
    if (resolved.response) return resolved.response;

    const days = resolveDormantDays(await getSetting(LINK_DORMANT_DAYS_KEY));
    const siteName = (await getSetting("site_name")) || "Momo Blog";
    return c.html(
      dormantNoticePage({
        siteName,
        url: resolved.record!.url,
        token: resolved.record!.token,
        days,
      })
    );
  } catch (error) {
    LogService.error("休眠提醒页渲染失败:", error);
    return c.html(dormantNoticeResultPage(false, "处理失败，请稍后重试。"));
  }
}

/**
 * POST /api/link-dormant/confirm?token=
 *
 * 「我仍在使用」：为该 `(邮箱, 网址)` 写一条 N 天的人工确认（来源 `self`），
 * 并**删除提醒记录** —— 到期后若他仍没来评论，会再次休眠并再发一封提醒。
 */
export async function linkDormantNoticeConfirm(c: Context): Promise<Response> {
  try {
    const resolved = await resolveNotice(c);
    if (resolved.response) return resolved.response;
    const record = resolved.record!;

    const days = resolveDormantDays(await getSetting(LINK_DORMANT_DAYS_KEY));
    const nowMs = Date.now();
    await CommentService.trustLink(
      record.email,
      record.url,
      new Date(nowMs + days * DAY_MS).toISOString(),
      new Date(nowMs).toISOString(),
      "self"
    );
    await deleteDormantNotice(record.id);
    LogService.info("评论者确认链接仍在使用", { email: record.email, url: record.url, days });

    return c.html(
      dormantNoticeResultPage(true, `确认成功！该链接已恢复正常，${days} 天内不会再标记为休眠。`)
    );
  } catch (error) {
    LogService.error("休眠提醒确认失败:", error);
    return c.html(dormantNoticeResultPage(false, "处理失败，请稍后重试。"));
  }
}

/**
 * POST /api/link-dormant/update?token=  （表单字段 `url`）
 *
 * 提交新链接：批量改掉该邮箱所有历史评论里的个人网址（与「历史链接批量更新」同一口径），
 * 并为**新链接**写一条 N 天的本人确认 —— 否则新链接会因为「最后评论时间没变」立刻又被判休眠。
 */
export async function linkDormantNoticeUpdate(c: Context): Promise<Response> {
  try {
    const resolved = await resolveNotice(c);
    if (resolved.response) return resolved.response;
    const record = resolved.record!;

    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const newUrl = sanitizeUrl(body["url"]);
    if (!newUrl || (!/^https?:\/\//i.test(newUrl))) {
      return c.html(
        dormantNoticeResultPage(false, "新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。")
      );
    }

    const updated = await CommentService.updateCommentUrlsByEmail(record.email, newUrl);
    const days = resolveDormantDays(await getSetting(LINK_DORMANT_DAYS_KEY));
    const nowMs = Date.now();
    await CommentService.trustLink(
      record.email,
      newUrl,
      new Date(nowMs + days * DAY_MS).toISOString(),
      new Date(nowMs).toISOString(),
      "self"
    );
    await deleteDormantNotice(record.id);
    LogService.info("评论者提交了新链接（休眠提醒页）", {
      email: record.email,
      oldUrl: record.url,
      newUrl,
      updated,
    });

    return c.html(
      dormantNoticeResultPage(
        true,
        updated > 0
          ? `链接更新成功！共 ${updated} 条历史评论的网址已更新。`
          : "新链接与现有链接相同，未做修改。"
      )
    );
  } catch (error) {
    LogService.error("休眠提醒改链接失败:", error);
    return c.html(dormantNoticeResultPage(false, "处理失败，请稍后重试。"));
  }
}
