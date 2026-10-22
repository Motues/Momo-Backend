import crypto from "crypto";
import LogService from "./log";
import { getSetting } from "./settings";
import { normalizeEmail } from "./adminEmails";
import {
  LINK_SYNC_ENABLED_KEY,
  resolveLinkSwitch,
} from "./linkSecurity";
import { VERIFY_BASE_URL_KEY, normalizeVerifyBaseUrl } from "./verifySettings";
import { isEmailServiceAvailable, isEmailIdentityVerified, sendLinkSyncEmail } from "./email";
import CommentService from "../orm/commentService";
import {
  clearPendingLinkSyncRequests,
  createLinkSyncRequest,
  findPendingLinkSyncRequest,
  pruneExpiredLinkSyncRequests,
} from "../orm/linkSyncService";

/** 确认链接的有效期：24 小时（与邮箱验证一致） */
export const LINK_SYNC_TTL_MS = 24 * 60 * 60 * 1000;

export interface LinkSyncOfferInput {
  /** 提交评论的邮箱（原值，内部归一化） */
  email: string;
  /** 提交者昵称（邮件问候语） */
  author: string;
  /** 本次提交的个人网址（已过 sanitizeUrl，非空） */
  newUrl: string;
  /** 文章标题（邮件里顺带说明） */
  postTitle: string;
  /** 站点对外基础地址（不带尾部斜杠），用于拼确认链接 */
  baseUrl: string;
}

export interface LinkSyncOfferResult {
  /** 是否真的发出了确认邮件 */
  sent: boolean;
  /** 未发送的原因（便于测试与排障） */
  reason?:
    | "disabled"
    | "no-base-url"
    | "no-smtp"
    | "email-unverified"
    | "no-url"
    | "no-history"
    | "duplicate"
    | "error";
  /** 被替换的旧网址（发信时会带上） */
  oldUrl?: string;
}

/**
 * 历史链接批量更新的**触发点**（见 doc/link_security.md 第 3.1/3.2 节）。
 *
 * 只有同时满足下面全部条件才会发出确认邮件：
 *  1. `link_sync_enabled = "true"`（fail-closed）；
 *  2. `verify_base_url`（API 地址）非空 —— 确认邮件里的链接需要它；
 *  3. SMTP 可用；
 *  4. 该邮箱已经通过邮箱验证；
 *  5. 本次提交了非空网址，且该邮箱存在**不同网址**的历史评论。
 *
 * 刻意不抛错：任何一步失败都只写日志，绝不影响评论提交本身。
 */
export async function offerLinkSync(input: LinkSyncOfferInput): Promise<LinkSyncOfferResult> {
  const email = normalizeEmail(input.email);
  if (!input.newUrl) return { sent: false, reason: "no-url" };
  if (email === "") return { sent: false, reason: "no-url" };

  try {
    if (resolveLinkSwitch(await getSetting(LINK_SYNC_ENABLED_KEY)) !== "true") {
      return { sent: false, reason: "disabled" };
    }
    // 链接同步依赖 API 地址（不再依赖 email_verify_enabled）：
    // 没有配置地址时不发信，避免邮件里出现空/错误的链接。
    if (normalizeVerifyBaseUrl(await getSetting(VERIFY_BASE_URL_KEY)) === "") {
      return { sent: false, reason: "no-base-url" };
    }
    if (!(await isEmailServiceAvailable())) {
      return { sent: false, reason: "no-smtp" };
    }
    if (!(await isEmailIdentityVerified(input.email))) {
      return { sent: false, reason: "email-unverified" };
    }

    // 该邮箱的历史评论里，网址非空且与本次不同的才算「旧链接」
    const history = await CommentService.getCommentsByEmail(email);
    const outdated = history.filter((row) => row.url.trim() !== "" && row.url !== input.newUrl);
    if (outdated.length === 0) return { sent: false, reason: "no-history" };

    const nowIso = new Date().toISOString();
    // 顺手清理过期记录，避免表无限增长
    await pruneExpiredLinkSyncRequests(nowIso);

    // 去重：同一邮箱 + 同一新网址已有未过期未确认记录时不重复发信
    if (await findPendingLinkSyncRequest(email, input.newUrl, nowIso)) {
      return { sent: false, reason: "duplicate", oldUrl: outdated[0].url };
    }

    // 同一邮箱只保留一条有效待确认记录：旧邮件里的链接立刻失效
    await clearPendingLinkSyncRequests(email);

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + LINK_SYNC_TTL_MS).toISOString();
    await createLinkSyncRequest({
      email,
      newUrl: input.newUrl,
      token,
      expiresAt,
      createdAt: nowIso,
    });

    const confirmUrl = `${input.baseUrl.replace(/\/+$/, "")}/api/link-sync/confirm?token=${encodeURIComponent(
      token
    )}&email=${encodeURIComponent(email)}`;

    await sendLinkSyncEmail({
      toEmail: input.email,
      toName: input.author,
      siteName: (await getSetting("site_name")) || "Momo Blog",
      oldUrl: outdated[0].url,
      newUrl: input.newUrl,
      postTitle: input.postTitle,
      confirmUrl,
    });

    return { sent: true, oldUrl: outdated[0].url };
  } catch (error) {
    LogService.error("链接同步确认邮件发送失败（不影响评论提交）:", error);
    return { sent: false, reason: "error" };
  }
}
