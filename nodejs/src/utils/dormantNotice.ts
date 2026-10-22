import crypto from "crypto";
import { getSetting } from "./settings";
import LogService from "./log";
import { sendDormantNoticeEmail } from "./email";
import {
  DAY_MS,
  LINK_DORMANT_DAYS_KEY,
  LINK_DORMANT_NOTICE_ENABLED_KEY,
  LINK_SECURITY_ENABLED_KEY,
  isTrustActive,
  linkTrustKey,
  needDormantNotice,
  resolveDormantDays,
  shouldSendDormantNotice,
} from "./linkSecurity";
import {
  getDormantNoticesByEmailUrls,
  upsertDormantNotice,
} from "../orm/dormantNoticeService";
import { VERIFY_BASE_URL_KEY } from "./verifySettings";

/**
 * 休眠链接的**惰性提醒**（见 doc/link_security.md 第 2.7 节）。
 *
 * 本仓库三端都没有定时任务，休眠是「读取公开评论列表时实时推导」的 —— 因此提醒也挂在这里：
 * 某条链接刚进入休眠且还没提醒过时，异步发一封提醒邮件（评论者可以确认仍在用、或提交新链接），
 * 并落一条 `DormantNotice` 记录，保证**同一个休眠周期只提醒一次**。
 *
 * 调用方**不要 await**：提醒失败绝不能影响评论列表的响应。
 */

export interface DormantLinkCandidate {
  /** 归一化后的邮箱 */
  email: string;
  /** 评论者昵称（邮件问候语） */
  author: string;
  /** 触发休眠的网址（trim 后） */
  url: string;
  /** 该邮箱「最后一条评论」的毫秒时间戳；查不到时不该出现在这里 */
  lastCommentAt: number | null;
}

/**
 * 单个请求最多发几封提醒邮件。
 *
 * 老站点第一次开启这个功能时，历史上可能一下子有几十条链接同时「已经休眠」——
 * 不设上限就会在第一次有人访问评论区时群发几十封邮件（容易被 SMTP 判成垃圾发信）。
 * 上限之内的先发，其余留给后续请求（状态机保证不会重复提醒同一次休眠）。
 */
const MAX_DORMANT_NOTICES_PER_REQUEST = 3;

/**
 * 给这批「当前休眠」的链接发提醒邮件。
 *
 * - 同一个 `(邮箱, 网址)` 只处理一次；查不到最后评论时间的直接跳过（那种情况本就不会判为休眠）；
 * - **发信前提**（doc/link_security.md 第 2.7 节）：总开关 + 提醒开关 + API 地址非空才发信，
 *   任一不满足直接返回（不查记录、不落记录）—— 「打开开关后第一次访问评论区才开始提醒」；
 *   不再依赖 `email_verify_enabled`；
 * - 发信函数在 SMTP 未配置 / 邮件通知关闭 / 发送失败时返回 `null` → **不落记录**，下次读取重试；
 * - 只有真正发出去（拿到返回）才 upsert 记录：换新令牌、刷新有效期、`notify_count` +1。
 */
export async function notifyDormantLinks(
  candidates: DormantLinkCandidate[],
  baseUrl: string
): Promise<void> {
  if (!baseUrl || candidates.length === 0) return;

  const [securityEnabled, noticeEnabled, apiBaseUrl] = await Promise.all([
    getSetting(LINK_SECURITY_ENABLED_KEY),
    getSetting(LINK_DORMANT_NOTICE_ENABLED_KEY),
    getSetting(VERIFY_BASE_URL_KEY),
  ]);
  if (!shouldSendDormantNotice({ securityEnabled, noticeEnabled, apiBaseUrl })) {
    return;
  }

  // 同一 (邮箱, 网址) 去重；顺便丢掉信息不全的项
  const unique = new Map<string, DormantLinkCandidate>();
  for (const item of candidates) {
    const email = String(item.email ?? "").trim().toLowerCase();
    const url = String(item.url ?? "").trim();
    if (!email || !url) continue;
    if (item.lastCommentAt === null || item.lastCommentAt === undefined) continue;
    unique.set(linkTrustKey(email, url), { ...item, email, url });
  }
  if (unique.size === 0) return;

  const records = await getDormantNoticesByEmailUrls(Array.from(unique.values()));
  const nowMs = Date.now();
  const days = resolveDormantDays(await getSetting(LINK_DORMANT_DAYS_KEY));
  const siteName = (await getSetting("site_name")) || "Momo Blog";

  // 先筛出「这次该发」的，再按上限截断（避免第一次访问时群发）
  const pending: DormantLinkCandidate[] = [];
  for (const [key, item] of unique) {
    const record = records.get(key);
    const shouldNotify = needDormantNotice({
      dormant: true,
      hasRecord: record !== undefined,
      // 「记录已过期」与人工确认同一套严格判定（格式不符一律算过期）
      recordExpired: record ? !isTrustActive(record.expires_at, nowMs) : false,
      recordLastCommentAt: record ? record.last_comment_at : null,
      currentLastCommentAt: Number(item.lastCommentAt),
    });
    if (shouldNotify) pending.push(item);
  }

  for (const item of pending.slice(0, MAX_DORMANT_NOTICES_PER_REQUEST)) {
    const token = crypto.randomUUID();
    const expiresAt = new Date(nowMs + days * DAY_MS).toISOString();
    const noticeUrl = `${baseUrl.replace(/\/+$/, "")}/api/link-dormant/notice?token=${encodeURIComponent(token)}`;

    const info = await sendDormantNoticeEmail({
      toEmail: item.email,
      toName: item.author,
      siteName,
      dormantUrl: item.url,
      noticeUrl,
      days,
    });
    if (!info) continue; // 跳过或失败：不落记录，下次读取再试

    await upsertDormantNotice({
      email: item.email,
      url: item.url,
      lastCommentAt: Number(item.lastCommentAt),
      token,
      expiresAt,
      notifiedAt: new Date(nowMs).toISOString(),
    });
    LogService.info("休眠链接提醒已发送", { email: item.email, url: item.url, days });
  }
}
