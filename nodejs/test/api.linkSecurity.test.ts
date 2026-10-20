import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
/** 按邮件主题筛选：验证邮件是异步发出，可能迟到相邻用例，计数断言必须免受干扰 */
function mailsWithSubject(messages: string[], keyword: string): string[] {
  // RFC 2047 的分段编码会把主题切在任意位置（"上有新的" + "评论"），
  // 比较前先去掉全部空白，避免断言被「编码分段」这种无关细节左右
  const flat = (value: string) => value.replace(/\s+/g, "");
  return messages.filter((raw) =>
    flat(decodeHeaderValue(messageHeader(raw, "Subject"))).includes(flat(keyword))
  );
}

import {
  api,
  json,
  seedComment,
  useTrustProxy,
  resetTables,
  clearSettings,
  startFakeSmtp,
  decodeMessage,
  decodeHeaderValue,
  messageHeader,
  type FakeSmtp,
} from "./helpers";

/**
 * 链接安全审查 + 多管理员邮箱 + 表情多来源的 HTTP 级验收。
 *
 * 覆盖三块「跨端行为」：
 *  1. 多管理员邮箱：列表内的人都享有博主特权，通知只发解析后的 notify_email；
 *  2. 休眠链接：按邮箱最近一次评论实时推导，边界是「严格大于 N 天」；
 *  3. 历史链接批量更新：确认邮件 → 确认端点 → 批量改写 url（幂等、一次性令牌）。
 */

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本文件统一操作的文章标识：所有种子评论都落在这一页，便于一次读回 */
const PAGE = "/posts/link-security";

/** seedComment 的本地包装：默认落到本文件操作的页面 */
function seed(options: Parameters<typeof seedComment>[0] = {}) {
  return seedComment({ post_slug: PAGE, ...options });
}

let ipSequence = 0;
function uniqueIp(): string {
  ipSequence += 1;
  return `198.19.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

const TOUCHED_SETTINGS = [
  "admin_email",
  "admin_emails",
  "notify_email",
  "admin_comment_key",
  "admin_comment_key_enabled",
  "comment_auto_approve",
  "email_verify_enabled",
  "verify_base_url",
  "email_enabled",
  "email_user",
  "email_password",
  "email_secure",
  "email_host",
  "smtp_host",
  "smtp_port",
  "site_name",
  "emoji_enabled",
  "emoji_cdn_url",
  "emoji_cdn_urls",
  "link_security_enabled",
  "link_dormant_days",
  "link_sync_enabled",
  "link_dormant_notice_enabled",
  "allow_origin",
  "blogger_badge_enabled",
];

function postComment(body: Record<string, unknown>, ip = uniqueIp()) {
  return api("/api/comments", {
    method: "POST",
    ip,
    body,
    headers: { "user-agent": DESKTOP_UA },
  });
}

function commentBody(overrides: Record<string, unknown> = {}) {
  return {
    post_slug: "/posts/link-security",
    author: "访客",
    email: "guest@example.com",
    content: "这是一条评论",
    ...overrides,
  };
}

async function getComments(query = "post_slug=/posts/link-security&nested=true") {
  const res = await api(`/api/comments?${query}`);
  return json<any>(res);
}

/** 直接把某个邮箱标记为「已通过邮箱验证」 */
function markEmailVerified(email: string, verified = 1) {
  db.run(sql`
    INSERT INTO "EmailVerification" ("email", "token", "expires_at", "verified", "created_at")
    VALUES (${email}, ${`tok-${email}-${Math.random()}`}, ${new Date(Date.now() + DAY_MS).toISOString()}, ${verified}, ${new Date().toISOString()})
  `);
}

function linkSyncRows(): any[] {
  return db.all(sql`SELECT * FROM "LinkSyncRequest" ORDER BY id`) as any[];
}

function commentUrls(email: string): string[] {
  const rows = db.all(
    sql`SELECT url FROM "Comment" WHERE email = ${email} ORDER BY id`
  ) as any[];
  return rows.map((row) => row.url);
}

beforeEach(() => {
  useTrustProxy();
  resetTables();
});

afterEach(() => {
  clearSettings(TOUCHED_SETTINGS);
});

describe("多管理员邮箱", () => {
  it("列表里的第二个邮箱同样享有博主特权（免 60 秒冷却 + 密钥可用）", async () => {
    await setSetting("admin_emails", JSON.stringify(["first@example.com", "second@example.com"]));
    await setSetting("admin_comment_key", "k-123");
    await setSetting("admin_comment_key_enabled", "true");
    await setSetting("comment_auto_approve", "false");

    // 同一个 IP 连发两条：普通访客会被 60 秒冷却拦住，管理员不会
    const ip = "198.19.250.250";
    const first = await postComment(
      commentBody({ email: "guest@example.com", content: "第一条" }),
      ip
    );
    expect(first.status).toBe(200);

    const res = await postComment(
      commentBody({ email: " Second@Example.com ", content: "第二条", admin_key: "k-123" }),
      ip
    );
    const body = await json<any>(res);
    expect(res.status).toBe(200);
    expect(body.message).toContain("successfully");

    // 归一化后命中列表 → 评论直接 approved，且下发 isBlogger
    const list = await getComments();
    const comment = list.data.comments.find((c: any) => c.contentText === "第二条");
    expect(comment.isBlogger).toBe(true);
  });

  it("普通访客在 60 秒内连发会被限流（对照）", async () => {
    const ip = "198.19.250.251";
    await postComment(commentBody({ email: "guest@example.com", content: "第一条" }), ip);
    const res = await postComment(
      commentBody({ email: "guest2@example.com", content: "第二条" }),
      ip
    );
    expect(res.status).toBe(429);
  });

  it("不在列表里的邮箱不是博主，也不下发哈希", async () => {
    await setSetting("admin_emails", JSON.stringify(["admin@example.com"]));
    seed({ email: "guest@example.com", content_text: "普通访客", content_html: "<p>普通访客</p>" });

    const list = await getComments();
    expect(list.data.comments[0].isBlogger).toBe(false);
    expect(list.data.admin_email_hashes).toEqual([]);
    expect(list.data.admin_email_hash).toBe("");
  });

  it("密钥功能开启时下发每个管理员邮箱的哈希（+ 兼容的单个哈希）", async () => {
    await setSetting("admin_emails", JSON.stringify(["a@example.com", "b@example.com"]));
    await setSetting("notify_email", "b@example.com");
    await setSetting("admin_comment_key", "k");
    await setSetting("admin_comment_key_enabled", "true");

    const list = await getComments();
    const crypto = await import("node:crypto");
    const hash = (email: string) =>
      crypto.createHash("sha256").update(email).digest("hex");

    expect(list.data.admin_email_hashes).toEqual([hash("a@example.com"), hash("b@example.com")]);
    // 兼容字段 = 通知收件人的哈希
    expect(list.data.admin_email_hash).toBe(hash("b@example.com"));
    expect(list.data.admin_email_hash).toBe(list.data.admin_email_hashes[1]);
  });

  it("旧键 admin_email 仍然兼容（未配置 admin_emails 时即单元素列表）", async () => {
    await setSetting("admin_email", "legacy@example.com");
    seed({ email: "legacy@example.com", content_text: "旧键博主", content_html: "<p>旧键博主</p>" });

    const list = await getComments();
    expect(list.data.comments[0].isBlogger).toBe(true);
  });
});

describe("表情多来源下发", () => {
  it("下发 emoji_cdn_urls 数组，并保留 emoji_cdn_url = 第一个地址", async () => {
    const urls = ["https://a.example.com/owo.json", "https://b.example.com/owo.json"];
    await setSetting("emoji_cdn_urls", JSON.stringify(urls));

    const list = await getComments();
    expect(list.data.emoji_cdn_urls).toEqual(urls);
    expect(list.data.emoji_cdn_url).toBe(urls[0]);
  });

  it("数组为空时回落旧键；旧键也为空时回落默认源", async () => {
    await setSetting("emoji_cdn_urls", "[]");
    await setSetting("emoji_cdn_url", "https://legacy.example.com/owo.json");
    let list = await getComments();
    expect(list.data.emoji_cdn_urls).toEqual(["https://legacy.example.com/owo.json"]);

    await setSetting("emoji_cdn_url", "");
    list = await getComments();
    expect(list.data.emoji_cdn_urls).toEqual(["https://open.motues.top/emoji/owo.json"]);
  });
});

describe("休眠链接（urlDormant）", () => {
  it("功能关闭时一律 false，且不查询", async () => {
    seed({ email: "a@example.com", url: "https://a.example.com", pub_date: Date.now() - 90 * DAY_MS });
    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(false);
  });

  it("超过 N 天没来评论：标记为休眠", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seed({ email: "a@example.com", url: "https://a.example.com", pub_date: Date.now() - 31 * DAY_MS });

    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(true);
  });

  it("刚好 N 天不算休眠（严格大于）", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seed({ email: "a@example.com", url: "https://a.example.com", pub_date: Date.now() - 30 * DAY_MS + 60000 });

    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(false);
  });

  it("没有个人网址的评论永不标记", async () => {
    await setSetting("link_security_enabled", "true");
    seed({ email: "a@example.com", url: null, pub_date: Date.now() - 90 * DAY_MS });

    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(false);
  });

  it("跨文章统计：同一个人在别的文章评论过，本文章的链接也解除休眠", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seed({
      email: "a@example.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 90 * DAY_MS,
      post_slug: "/posts/link-security",
    });
    // 最近在另一篇文章评论过
    seed({
      email: "a@example.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 60 * 1000,
      post_slug: "/posts/other",
    });

    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(false);
  });

  it("待审核（pending）的评论也算「来过」，同样解除休眠", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seed({
      email: "a@example.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 90 * DAY_MS,
      status: "approved",
    });
    seed({
      email: "a@example.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 60 * 1000,
      status: "pending",
    });

    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(false);
  });

  it("rejected / deleted 的评论不算「来过」", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seed({
      email: "a@example.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 90 * DAY_MS,
      status: "approved",
    });
    seed({
      email: "a@example.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 60 * 1000,
      status: "deleted",
    });

    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(true);
  });

  it("邮箱归一化：大小写不同的同一邮箱视为同一个人", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "30");
    seed({
      email: "A@Example.com",
      url: "https://a.example.com",
      pub_date: Date.now() - 90 * DAY_MS,
    });
    seed({
      email: " a@example.COM ",
      url: "https://a.example.com",
      pub_date: Date.now() - 60 * 1000,
      post_slug: "/posts/other",
    });

    const list = await getComments();
    expect(list.data.comments[0].urlDormant).toBe(false);
  });

  it("天数脏值按默认 30 天处理", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "abc");
    seed({ email: "a@example.com", url: "https://a.example.com", pub_date: Date.now() - 31 * DAY_MS });
    seed({ email: "b@example.com", url: "https://b.example.com", pub_date: Date.now() - 10 * DAY_MS });

    const list = await getComments();
    const a = list.data.comments.find((c: any) => c.url === "https://a.example.com");
    const b = list.data.comments.find((c: any) => c.url === "https://b.example.com");
    expect(a.urlDormant).toBe(true);
    expect(b.urlDormant).toBe(false);
  });
});

describe("历史链接批量更新（确认邮件 + 确认端点）", () => {
  let smtp: FakeSmtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });

  afterAll(async () => {
    await smtp.close();
  });

  beforeEach(async () => {
    smtp.reset();
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(smtp.port));
    await setSetting("email_user", "sender@example.com");
    await setSetting("email_password", "p");
    await setSetting("email_secure", "false");
    await setSetting("email_enabled", "true");
    await setSetting("site_name", "测试站");
  });

  async function enableLinkSync() {
    await setSetting("link_sync_enabled", "true");
    await setSetting("email_verify_enabled", "true");
    await setSetting("notify_email", "admin@example.com");
  }

  it("开关关闭时不发信、不建记录", async () => {
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    expect(linkSyncRows()).toHaveLength(0);
    expect(mailsWithSubject(smtp.messages, "确认更新")).toHaveLength(0);
  });

  it("缺少邮箱验证功能时不发信（需求里的硬前提）", async () => {
    await setSetting("link_sync_enabled", "true");
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    expect(linkSyncRows()).toHaveLength(0);
  });

  it("邮箱未验证时不发信", async () => {
    await enableLinkSync();
    seed({ email: "a@example.com", url: "https://old.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    expect(linkSyncRows()).toHaveLength(0);
  });

  it("验证记录与提交邮箱的大小写/空格不同，仍按归一化身份触发", async () => {
    await enableLinkSync();
    // 验证记录按原始大小写存；历史评论与本次提交的写法也各不相同
    markEmailVerified("Alice@Example.com");
    seed({ email: "alice@example.com", url: "https://old.example.com" });

    await postComment(
      commentBody({ email: "  alice@EXAMPLE.com  ", url: "https://new.example.com" })
    );

    expect(linkSyncRows()).toHaveLength(1);
    expect(linkSyncRows()[0].email).toBe("alice@example.com");
    expect(mailsWithSubject(smtp.messages, "确认更新")).toHaveLength(1);
  });

  it("没有历史网址时不发信", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: null });

    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    expect(linkSyncRows()).toHaveLength(0);
  });

  it("网址与历史相同（无旧链接）时不发信", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://same.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://same.example.com" }));
    expect(linkSyncRows()).toHaveLength(0);
  });

  it("满足全部条件时发确认邮件并落一条待确认记录", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));

    const rows = linkSyncRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("a@example.com");
    expect(rows[0].new_url).toBe("https://new.example.com");
    expect(rows[0].confirmed).toBe(0);

    expect(mailsWithSubject(smtp.messages, "确认更新")).toHaveLength(1);
    const raw = mailsWithSubject(smtp.messages, "确认更新")[0];
    const body = decodeMessage(raw);
    expect(messageHeader(raw, "To")).toContain("a@example.com");
    expect(body).toContain("/api/link-sync/confirm?token=");
    expect(body).toContain("https://new.example.com");
    expect(body).toContain("https://old.example.com");
  });

  it("确认端点会把该邮箱所有历史评论的网址改成新网址，并标记已确认", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });
    seed({ email: "a@example.com", url: "https://older.example.com" });
    seed({ email: "a@example.com", url: null });
    seed({ email: "other@example.com", url: "https://other.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    const row = linkSyncRows()[0];

    const res = await api(
      `/api/link-sync/confirm?token=${encodeURIComponent(row.token)}&email=${encodeURIComponent(row.email)}`
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("链接同步完成");

    // 三条历史评论里，两条有旧网址被改写；没有网址的那条保持为空；
    // 最后一条是本次 POST 新建的评论（本来就是新网址）
    expect(commentUrls("a@example.com")).toEqual([
      "https://new.example.com",
      "https://new.example.com",
      null,
      "https://new.example.com",
    ]);
    // 别人的链接不受影响
    expect(commentUrls("other@example.com")).toEqual(["https://other.example.com"]);
    // 令牌一次性
    expect(linkSyncRows()[0].confirmed).toBe(1);
  });

  it("重复确认返回「已完成」，不会二次改写", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });
    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    const row = linkSyncRows()[0];
    const url = `/api/link-sync/confirm?token=${encodeURIComponent(row.token)}&email=${encodeURIComponent(row.email)}`;

    await api(url);
    // 确认后再把某条评论改回旧网址，重复确认不应再动它
    db.run(sql`UPDATE "Comment" SET url = 'https://tampered.example.com' WHERE email = 'a@example.com'`);

    const res = await api(url);
    const html = await res.text();
    expect(html).toContain("该链接同步已完成");
    expect(commentUrls("a@example.com")[0]).toBe("https://tampered.example.com");
  });

  it("令牌无效 / 过期 / 缺参数分别返回对应文案", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });
    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    const row = linkSyncRows()[0];

    let res = await api("/api/link-sync/confirm");
    expect(await res.text()).toContain("缺少确认参数");

    res = await api("/api/link-sync/confirm?token=nope&email=a@example.com");
    expect(await res.text()).toContain("确认链接无效");

    // token 正确但 email 不匹配
    res = await api(`/api/link-sync/confirm?token=${row.token}&email=other@example.com`);
    expect(await res.text()).toContain("确认链接无效");

    // 过期
    db.run(
      sql`UPDATE "LinkSyncRequest" SET expires_at = ${new Date(Date.now() - 1000).toISOString()} WHERE id = ${row.id}`
    );
    res = await api(`/api/link-sync/confirm?token=${row.token}&email=${row.email}`);
    expect(await res.text()).toContain("确认链接已过期");
    // 过期不会改写任何评论
    expect(commentUrls("a@example.com")).toContain("https://old.example.com");
  });

  it("同一邮箱 + 同一新网址不会重复发信", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    expect(mailsWithSubject(smtp.messages, "确认更新")).toHaveLength(1);
    expect(linkSyncRows()).toHaveLength(1);

    // 再提交一次同样的新网址（换 IP 绕过 60 秒冷却）
    await postComment(commentBody({ email: "a@example.com", url: "https://new.example.com" }));
    expect(mailsWithSubject(smtp.messages, "确认更新")).toHaveLength(1);
    expect(linkSyncRows()).toHaveLength(1);
  });

  it("提交另一个新网址时作废旧记录（旧邮件里的链接立刻失效）", async () => {
    await enableLinkSync();
    markEmailVerified("a@example.com");
    seed({ email: "a@example.com", url: "https://old.example.com" });

    await postComment(commentBody({ email: "a@example.com", url: "https://new-a.example.com" }));
    const first = linkSyncRows()[0];

    await postComment(commentBody({ email: "a@example.com", url: "https://new-b.example.com" }));
    const rows = linkSyncRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].new_url).toBe("https://new-b.example.com");

    const res = await api(
      `/api/link-sync/confirm?token=${first.token}&email=${first.email}`
    );
    expect(await res.text()).toContain("确认链接无效");
  });
});

describe("通知邮件收件人（notify_email）", () => {
  let smtp: FakeSmtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });

  afterAll(async () => {
    await smtp.close();
  });

  beforeEach(async () => {
    smtp.reset();
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(smtp.port));
    await setSetting("email_user", "sender@example.com");
    await setSetting("email_password", "p");
    await setSetting("email_secure", "false");
    await setSetting("email_enabled", "true");
    await setSetting("site_name", "测试站");
  });

  it("新评论通知只发给 notify_email", async () => {
    await setSetting(
      "admin_emails",
      JSON.stringify(["a@example.com", "b@example.com", "c@example.com"])
    );
    await setSetting("notify_email", "b@example.com");

    await postComment(commentBody({ email: "guest@example.com", content: "通知测试" }));

    const notifyMails = mailsWithSubject(smtp.messages, "上有新的评论");
    expect(notifyMails).toHaveLength(1);
    expect(messageHeader(notifyMails[0], "To")).toContain("b@example.com");
    expect(messageHeader(notifyMails[0], "To")).not.toContain("a@example.com");
  });

  it("通知邮箱未配置时回落管理员列表第一个", async () => {
    await setSetting("admin_emails", JSON.stringify(["a@example.com", "b@example.com"]));

    await postComment(commentBody({ email: "guest@example.com", content: "通知测试" }));

    const notifyMails = mailsWithSubject(smtp.messages, "上有新的评论");
    expect(notifyMails).toHaveLength(1);
    expect(messageHeader(notifyMails[0], "To")).toContain("a@example.com");
  });

  it("邮件正文包含渲染后的 HTML（链接与 Markdown 图片原样进信）", async () => {
    await setSetting("notify_email", "admin@example.com");
    await setSetting("admin_emails", JSON.stringify(["admin@example.com"]));

    await postComment(
      commentBody({
        email: "guest@example.com",
        content: "看这个 [链接](https://example.com/x) 和 ![图](https://img.example.com/a.png)",
      })
    );

    const body = decodeMessage(mailsWithSubject(smtp.messages, "上有新的评论")[0]);
    expect(body).toContain("https://example.com/x");
    expect(body).toContain("https://img.example.com/a.png");
    expect(body).toContain("<img");
  });

  it("自定义模板里的 {{commentContentHtml}} 不转义、{{commentContent}} 仍然转义", async () => {
    await setSetting("admin_emails", JSON.stringify(["admin@example.com"]));
    await setSetting(
      "notification_template",
      "<div>HTML={{commentContentHtml}}|TEXT={{commentContent}}</div>"
    );

    await postComment(
      commentBody({ email: "guest@example.com", content: "**粗体** <b>标签</b>" })
    );

    const body = decodeMessage(mailsWithSubject(smtp.messages, "上有新的评论")[0]);
    // HTML 占位符原样插入（含 <strong>）
    expect(body).toContain("<strong>粗体</strong>");
    // 纯文本占位符被转义
    expect(body).toContain("&lt;b&gt;标签&lt;/b&gt;");
  });
});
