import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import {
  findLinkSyncRequest,
  markLinkSyncRequestConfirmed,
} from "../../orm/linkSyncService";
import { verificationResultPage } from "./verifyEmail";
import LogService from "../../utils/log";

/**
 * 历史链接批量更新的**确认端点**（见 doc/link_security.md 第 3.4 节）。
 *
 * `GET /api/link-sync/confirm?token=&email=`
 *
 * 为什么不放在前端路由里：确认链接是邮件里的纯链接，收件人可能在任何设备/浏览器上打开，
 * 而且这里要做的是**服务端写操作**。与邮箱验证端点同一模型：邮件链接即凭据，不需要登录。
 * 令牌一次性（确认后不可重放）、24 小时过期。
 */
export default async (c: Context): Promise<Response> => {
  const token = c.req.query("token");
  const email = c.req.query("email");

  if (!token || !email) {
    return c.html(verificationResultPage(false, "缺少确认参数"));
  }

  try {
    const record = await findLinkSyncRequest(token, email);
    if (!record) {
      return c.html(verificationResultPage(false, "确认链接无效"));
    }

    if (record.confirmed === 1) {
      return c.html(verificationResultPage(true, "该链接同步已完成"));
    }

    if (Date.now() > new Date(record.expires_at).getTime()) {
      return c.html(
        verificationResultPage(false, "确认链接已过期，请重新提交评论以获取新的确认邮件")
      );
    }

    // 批量更新：只改「本来就有网址、且与目标网址不同」的历史评论（幂等）
    const updated = await CommentService.updateCommentUrlsByEmail(record.email, record.new_url);
    await markLinkSyncRequestConfirmed(record.id);

    LogService.info("历史链接批量更新完成", {
      email: record.email,
      updated,
      newUrl: record.new_url,
    });

    return c.html(
      verificationResultPage(true, `链接同步完成！共 ${updated} 条历史评论的网址已更新`)
    );
  } catch (error) {
    LogService.error("链接同步确认失败:", error);
    return c.html(verificationResultPage(false, "确认处理失败，请稍后重试"));
  }
};
