import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import router from "../src/middleware/routes";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import {
  sendCommentNotification,
  sendCommentReplyNotification,
  sendDormantNoticeEmail,
  sendLinkSyncEmail,
  sendTestEmail,
  sendVerificationEmail,
} from "../src/utils/email";
import { MAIL_LOG_RETENTION_DAYS } from "../src/utils/mailLog";
import {
  api,
  json,
  loginToken,
  seedComment,
  useTrustProxy,
  resetTables,
  clearSettings,
  startFakeSmtp,
  type FakeSmtp,
} from "./helpers";

/**
 * 外发邮件日志（管理面板「邮件管理」）与**休眠链接提醒**的惰性链路。
 *
 * 这两块是同一批需求：提醒邮件是新增的第六种邮件类型，而它的「只提醒一次」状态机
 * 又是靠读取评论列表时惰性触发的（本仓库三端都没有定时任务）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = "/posts/dormant-notice";

const TOUCHED_SETTINGS = [
  "smtp_host",
  "smtp_port",
  "email_user",
  "email_password",
  "email_secure",
  "email_enabled",
  "site_name",
  "verify_base_url",
  "link_security_enabled",
  "link_dormant_days",
  "link_dormant_notice_enabled",
  "email_verify_enabled",
  "mail_log_retention_days",
  "admin_email",
  "admin_emails",
  "notify_email",
];

let smtp: FakeSmtp;

/** 惰性发信是 fire-and-forget，断言前轮询等待它落库 */
async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

const mailRows = () =>
  db.all(sql`SELECT * FROM "MailLog" ORDER BY id`) as unknown as {
    id: number;
    type: string;
    recipient: string;
    subject: string;
    status: string;
    error: string | null;
    created_at: string;
  }[];

const noticeRows = () =>
  db.all(sql`SELECT * FROM "DormantNotice" ORDER BY id`) as unknown as {
    id: number;
    email: string;
    url: string;
    last_comment_at: number;
    token: string;
    expires_at: string;
    notified_at: string;
    notify_count: number;
  }[];

/** 一条 90 天前、带网址的评论 → 会判为休眠 */
const seedDormantComment = (email = "sleepy@example.com", url = "https://sleepy.example.com") =>
  seedComment({
    post_slug: PAGE,
    author: "Sleepy",
    email,
    url,
    pub_date: Date.now() - 90 * DAY_MS,
    status: "approved",
  });

const publicComments = async () => json(await api(`/api/comments?post_slug=${PAGE}`));

/**
 * 提醒页的两个动作是**浏览器原生表单**提交（`application/x-www-form-urlencoded`），
 * 不能走 `api()` —— 那个辅助函数固定发 JSON。
 */
const postForm = (path: string, fields: Record<string, string>) =>
  router.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": "203.0.113.9",
    },
    body: new URLSearchParams(fields).toString(),
  });

beforeAll(async () => {
  smtp = await startFakeSmtp();
});

afterAll(async () => {
  await smtp.close();
});

beforeEach(async () => {
  useTrustProxy();
  resetTables();
  smtp.reset();
  await setSetting("smtp_host", "127.0.0.1");
  await setSetting("smtp_port", String(smtp.port));
  await setSetting("email_user", "sender@example.com");
  await setSetting("email_password", "p");
  await setSetting("email_secure", "false");
  await setSetting("email_enabled", "true");
  await setSetting("site_name", "测试站");
  await setSetting("verify_base_url", "https://blog.example.com");
  await setSetting("link_security_enabled", "true");
  // 休眠提醒邮件的两个前提（doc/link_security.md 第 2.7 节）：提醒开关 + 邮箱验证
  await setSetting("link_dormant_notice_enabled", "true");
  await setSetting("email_verify_enabled", "true");
  // 新评论通知发给管理员，没有管理员邮箱时那封信本来就不会发（也就没有日志）
  await setSetting("admin_emails", JSON.stringify(["admin@example.com"]));
  await setSetting("notify_email", "admin@example.com");
});

afterEach(() => {
  clearSettings(TOUCHED_SETTINGS);
});

describe("外发邮件日志", () => {
  it("六种邮件类型各记一行 sent", async () => {
    await sendVerificationEmail({
      toEmail: "a@example.com",
      toName: "甲",
      postTitle: "标题",
      postSlug: PAGE,
      verifyUrl: "https://blog.example.com/verify",
    });
    await sendLinkSyncEmail({
      toEmail: "a@example.com",
      toName: "甲",
      siteName: "测试站",
      oldUrl: "https://old.example.com",
      newUrl: "https://new.example.com",
      postTitle: "",
      confirmUrl: "https://blog.example.com/sync",
    });
    await sendCommentNotification({
      postTitle: "标题",
      postUrl: "https://blog.example.com/p",
      commentAuthor: "甲",
      commentContent: "内容",
      commentContentHtml: "<p>内容</p>",
    });
    await sendCommentReplyNotification({
      toEmail: "b@example.com",
      toName: "乙",
      postTitle: "标题",
      parentComment: "父评论",
      parentCommentHtml: "<p>父评论</p>",
      replyAuthor: "甲",
      replyContent: "回复",
      replyContentHtml: "<p>回复</p>",
      postUrl: "https://blog.example.com/p",
    });
    await sendDormantNoticeEmail({
      toEmail: "c@example.com",
      toName: "丙",
      siteName: "测试站",
      dormantUrl: "https://sleepy.example.com",
      noticeUrl: "https://blog.example.com/api/link-dormant/notice?token=t",
      days: 30,
    });
    await sendTestEmail("d@example.com");

    const rows = mailRows();
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.type).sort()).toEqual([
      "comment_notify",
      "dormant_notice",
      "link_sync",
      "reply_notify",
      "test",
      "verify",
    ]);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(rows.every((r) => r.error === null)).toBe(true);
    // 主题与收件人都落库（面板要能搜索）
    const notice = rows.find((r) => r.type === "dormant_notice")!;
    expect(notice.recipient).toBe("c@example.com");
    expect(notice.subject).toContain("个人网站链接已进入休眠");
  });

  it("发送失败记 failed 并把错误照旧抛给调用方", async () => {
    // 指向一个没人监听的端口 → ECONNREFUSED
    await setSetting("smtp_port", "1");

    await expect(sendTestEmail("fail@example.com")).rejects.toThrow();

    const rows = mailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toBeTruthy();
    expect(rows[0].type).toBe("test");
  });

  it("SMTP 未配置导致的「跳过」不记日志", async () => {
    await setSetting("smtp_host", "");
    await setSetting("email_user", "");
    await setSetting("email_password", "");

    const info = await sendDormantNoticeEmail({
      toEmail: "c@example.com",
      toName: "丙",
      siteName: "测试站",
      dormantUrl: "https://sleepy.example.com",
      noticeUrl: "https://blog.example.com/x",
      days: 30,
    });
    expect(info).toBeNull();
    expect(mailRows()).toHaveLength(0);
  });

  it("邮件通知关闭时同样跳过（不记日志）", async () => {
    await setSetting("email_enabled", "false");
    const info = await sendDormantNoticeEmail({
      toEmail: "c@example.com",
      toName: "丙",
      siteName: "测试站",
      dormantUrl: "https://sleepy.example.com",
      noticeUrl: "https://blog.example.com/x",
      days: 30,
    });
    expect(info).toBeNull();
    expect(mailRows()).toHaveLength(0);
  });

  it("写入时顺手清理超过保留期的旧日志", async () => {
    const old = new Date(Date.now() - (MAIL_LOG_RETENTION_DAYS + 1) * DAY_MS).toISOString();
    db.run(sql`
      INSERT INTO "MailLog" ("type", "recipient", "subject", "status", "error", "created_at")
      VALUES ('test', 'old@example.com', '旧邮件', 'sent', NULL, ${old})
    `);
    expect(mailRows()).toHaveLength(1);

    await sendTestEmail("new@example.com");

    const rows = mailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("new@example.com");
  });

  it("自定义保留天数：设置为 7 天时清理 7 天以前的行", async () => {
    await setSetting("mail_log_retention_days", "7");
    db.run(sql`
      INSERT INTO "MailLog" ("type", "recipient", "subject", "status", "error", "created_at")
      VALUES ('test', 'old@example.com', '旧邮件', 'sent', NULL,
        ${new Date(Date.now() - 8 * DAY_MS).toISOString()})
    `);

    await sendTestEmail("new@example.com");

    const rows = mailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("new@example.com");
  });

  it("保留天数设置为 0 时永久保留，不清理任何行", async () => {
    await setSetting("mail_log_retention_days", "0");
    db.run(sql`
      INSERT INTO "MailLog" ("type", "recipient", "subject", "status", "error", "created_at")
      VALUES ('test', 'ancient@example.com', '很久以前', 'sent', NULL,
        ${new Date(Date.now() - 3000 * DAY_MS).toISOString()})
    `);

    await sendTestEmail("new@example.com");

    expect(mailRows().map((row) => row.recipient).sort()).toEqual([
      "ancient@example.com",
      "new@example.com",
    ]);
  });
});

describe("GET /admin/mails", () => {
  async function seedLogs() {
    const now = Date.now();
    const rows: [string, string, string, string, string | null, number][] = [
      ["verify", "a@example.com", "请验证邮箱", "sent", null, 0],
      ["dormant_notice", "b@example.com", "链接已进入休眠", "failed", "ECONNREFUSED", 60_000],
      ["dormant_notice", "c@example.com", "链接已进入休眠", "sent", null, 120_000],
      ["test", "admin@example.com", "SMTP 配置验证", "sent", null, 180_000],
    ];
    for (const [type, recipient, subject, status, error, back] of rows) {
      db.run(sql`
        INSERT INTO "MailLog" ("type", "recipient", "subject", "status", "error", "created_at")
        VALUES (${type}, ${recipient}, ${subject}, ${status}, ${error}, ${new Date(now - back).toISOString()})
      `);
    }
  }

  it("缺少 token 返回 401", async () => {
    expect((await api("/admin/mails")).status).toBe(401);
  });

  it("默认按时间倒序返回，并带上保留天数", async () => {
    await seedLogs();
    const token = await loginToken();
    const body = await json(await api("/admin/mails", { token }));

    expect(body.code).toBe(200);
    expect(body.data.total).toBe(4);
    expect(body.data.retentionDays).toBe(MAIL_LOG_RETENTION_DAYS);
    expect(body.data.list[0].recipient).toBe("a@example.com"); // 最新
    expect(body.data.list[0].error).toBe("");
  });

  it("保留天数可自定义：7 天窗口外的行不再返回，retentionDays 同步", async () => {
    const now = Date.now();
    for (const [recipient, back] of [
      ["old@example.com", 10 * DAY_MS],
      ["new@example.com", 1 * DAY_MS],
    ] as const) {
      db.run(sql`
        INSERT INTO "MailLog" ("type", "recipient", "subject", "status", "error", "created_at")
        VALUES ('test', ${recipient}, '主题', 'sent', NULL, ${new Date(now - back).toISOString()})
      `);
    }
    await setSetting("mail_log_retention_days", "7");

    const token = await loginToken();
    const body = await json(await api("/admin/mails", { token }));
    expect(body.data.retentionDays).toBe(7);
    expect(body.data.total).toBe(1);
    expect(body.data.list[0].recipient).toBe("new@example.com");
  });

  it("保留天数为 0 表示永久保留：不设时间下限，返回全部历史", async () => {
    db.run(sql`
      INSERT INTO "MailLog" ("type", "recipient", "subject", "status", "error", "created_at")
      VALUES ('test', 'ancient@example.com', '主题', 'sent', NULL,
        ${new Date(Date.now() - 3000 * DAY_MS).toISOString()})
    `);
    await setSetting("mail_log_retention_days", "0");

    const token = await loginToken();
    const body = await json(await api("/admin/mails", { token }));
    expect(body.data.retentionDays).toBe(0);
    expect(body.data.total).toBe(1);
    expect(body.data.list[0].recipient).toBe("ancient@example.com");
  });

  it("status / type / search 筛选与分页", async () => {
    await seedLogs();
    const token = await loginToken();

    const failed = await json(await api("/admin/mails?status=failed", { token }));
    expect(failed.data.list.map((m: any) => m.recipient)).toEqual(["b@example.com"]);
    expect(failed.data.list[0].error).toContain("ECONNREFUSED");

    const dormant = await json(await api("/admin/mails?type=dormant_notice", { token }));
    expect(dormant.data.total).toBe(2);

    const searched = await json(await api("/admin/mails?search=ADMIN@", { token }));
    expect(searched.data.list.map((m: any) => m.type)).toEqual(["test"]);

    const paged = await json(await api("/admin/mails?pageSize=2&page=2", { token }));
    expect(paged.data.list).toHaveLength(2);
    expect(paged.data.page).toBe(2);
    expect(paged.data.pageSize).toBe(2);
  });

  it("无法识别的 status / type 不筛选（大小写不敏感）", async () => {
    await seedLogs();
    const token = await loginToken();
    const body = await json(await api("/admin/mails?status=maybe&type=nope", { token }));
    expect(body.data.total).toBe(4);

    const upper = await json(await api("/admin/mails?status=SENT", { token }));
    expect(upper.data.total).toBe(3);
    const upperType = await json(await api("/admin/mails?type=DORMANT_NOTICE", { token }));
    expect(upperType.data.total).toBe(2);
  });

  it("只返回保留期内的记录", async () => {
    const old = new Date(Date.now() - (MAIL_LOG_RETENTION_DAYS + 2) * DAY_MS).toISOString();
    db.run(sql`
      INSERT INTO "MailLog" ("type", "recipient", "subject", "status", "created_at")
      VALUES ('test', 'old@example.com', '旧', 'sent', ${old})
    `);
    const token = await loginToken();
    const body = await json(await api("/admin/mails", { token }));
    expect(body.data.total).toBe(0);
  });
});

describe("休眠链接提醒（惰性链路）", () => {
  it("读取公开评论列表时发一封提醒并落记录", async () => {
    seedDormantComment();
    await publicComments();

    expect(await waitFor(() => mailRows().length === 1)).toBe(true);
    expect(mailRows()[0].type).toBe("dormant_notice");
    expect(mailRows()[0].status).toBe("sent");
    expect(mailRows()[0].recipient).toBe("sleepy@example.com");
    expect(smtp.messages).toHaveLength(1);

    const notices = noticeRows();
    expect(notices).toHaveLength(1);
    expect(notices[0].email).toBe("sleepy@example.com");
    expect(notices[0].url).toBe("https://sleepy.example.com");
    expect(notices[0].notify_count).toBe(1);
    // 提醒页地址用的是配置的站点基址
    expect(smtp.messages[0]).toContain("https://blog.example.com/api/link-dormant/notice");
  });

  it("同一个休眠周期只提醒一次", async () => {
    seedDormantComment();
    await publicComments();
    expect(await waitFor(() => noticeRows().length === 1)).toBe(true);

    await publicComments();
    await publicComments();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mailRows()).toHaveLength(1);
    expect(noticeRows()[0].notify_count).toBe(1);
  });

  it("他后来又评论过（新的休眠周期）会再提醒一次", async () => {
    seedDormantComment();
    await publicComments();
    expect(await waitFor(() => noticeRows().length === 1)).toBe(true);

    // 又评论了一条（但仍然是 90 天前的老时间线之外：这里直接把时间放到更近，制造新的「最后评论时间」）
    seedComment({
      post_slug: PAGE,
      author: "Sleepy",
      email: "sleepy@example.com",
      url: "https://sleepy.example.com",
      pub_date: Date.now() - 40 * DAY_MS,
      status: "approved",
    });

    await publicComments();
    expect(await waitFor(() => noticeRows()[0]?.notify_count === 2)).toBe(true);
    expect(mailRows()).toHaveLength(2);
  });

  it("提醒记录过期后会再提醒一次", async () => {
    seedDormantComment();
    await publicComments();
    expect(await waitFor(() => noticeRows().length === 1)).toBe(true);

    const expired = new Date(Date.now() - 1000).toISOString();
    db.run(sql`UPDATE "DormantNotice" SET "expires_at" = ${expired}`);

    await publicComments();
    expect(await waitFor(() => noticeRows()[0]?.notify_count === 2)).toBe(true);
  });

  it("单个请求最多发 3 封提醒（避免开启功能时群发）", async () => {
    for (let i = 0; i < 5; i++) {
      seedComment({
        post_slug: PAGE,
        author: `休眠${i}`,
        email: `dormant${i}@example.com`,
        url: `https://dormant${i}.example.com`,
        pub_date: Date.now() - 90 * DAY_MS,
        status: "approved",
      });
    }

    await publicComments();
    expect(await waitFor(() => mailRows().length === 3)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mailRows()).toHaveLength(3);
    expect(noticeRows()).toHaveLength(3);

    // 后续请求把剩下的补上（状态机保证不重复）
    await publicComments();
    expect(await waitFor(() => mailRows().length === 5)).toBe(true);
    expect(noticeRows()).toHaveLength(5);
  });

  it("功能关闭时不发信、不落记录，评论列表照常返回", async () => {
    seedDormantComment();
    await setSetting("link_security_enabled", "false");

    const body = await publicComments();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(body.code).toBe(200);
    expect(body.data.comments[0].urlDormant).toBe(false);
    expect(mailRows()).toHaveLength(0);
    expect(noticeRows()).toHaveLength(0);
  });

  it("未配置 SMTP 时不发信也不落记录（下次读取会重试）", async () => {
    seedDormantComment();
    await setSetting("smtp_host", "");
    await setSetting("email_user", "");
    await setSetting("email_password", "");

    const body = await publicComments();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(body.code).toBe(200);
    expect(mailRows()).toHaveLength(0);
    expect(noticeRows()).toHaveLength(0);
  });

  it("休眠提醒开关关闭时不发信、不落记录（休眠标记照常）", async () => {
    seedDormantComment();
    await setSetting("link_dormant_notice_enabled", "false");

    const body = await publicComments();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(body.code).toBe(200);
    expect(body.data.comments[0].urlDormant).toBe(true);
    expect(mailRows()).toHaveLength(0);
    expect(noticeRows()).toHaveLength(0);
  });

  it("邮箱验证关闭时即使提醒开关打开也不发信（硬前提）", async () => {
    seedDormantComment();
    await setSetting("link_dormant_notice_enabled", "true");
    await setSetting("email_verify_enabled", "false");

    const body = await publicComments();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(body.code).toBe(200);
    expect(body.data.comments[0].urlDormant).toBe(true);
    expect(mailRows()).toHaveLength(0);
    expect(noticeRows()).toHaveLength(0);
  });
});

describe("休眠链接提醒页（邮件里的三个端点）", () => {
  /** 造一条提醒记录，返回令牌 */
  async function prepare(): Promise<string> {
    seedDormantComment();
    await publicComments();
    await waitFor(() => noticeRows().length === 1);
    return noticeRows()[0].token;
  }

  it("提醒页含当前链接与两个表单", async () => {
    const token = await prepare();
    const res = await api(`/api/link-dormant/notice?token=${token}`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("链接已休眠");
    expect(html).toContain("https://sleepy.example.com");
    expect(html).toContain(`/api/link-dormant/confirm?token=${token}`);
    expect(html).toContain(`/api/link-dormant/update?token=${token}`);
    expect(html).toContain("我仍在使用");
    expect(html).toContain("提交新链接");
  });

  it("缺少 token / 未知 token → 对应的失败文案", async () => {
    expect(await (await api("/api/link-dormant/notice")).text()).toContain("缺少提醒参数。");
    expect(await (await api("/api/link-dormant/notice?token=nope")).text()).toContain(
      "该提醒已失效或已处理。"
    );
  });

  it("过期的提醒页给出过期文案", async () => {
    const token = await prepare();
    db.run(sql`UPDATE "DormantNotice" SET "expires_at" = ${new Date(Date.now() - 1000).toISOString()}`);

    expect(await (await api(`/api/link-dormant/notice?token=${token}`)).text()).toContain(
      "该提醒已过期，请在评论区留言或等待新的提醒邮件。"
    );
  });

  it("「我仍在使用」→ 恢复正常，同一令牌随即失效", async () => {
    const token = await prepare();

    const res = await api(`/api/link-dormant/confirm?token=${token}`, { method: "POST" });
    const html = await res.text();
    expect(html).toContain("确认成功！");
    expect(noticeRows()).toHaveLength(0);

    // 链接恢复：公开评论列表不再标记休眠
    const body = await publicComments();
    expect(body.data.comments[0].urlDormant).toBe(false);

    // 同一个令牌再用 → 失效
    expect(await (await api(`/api/link-dormant/confirm?token=${token}`, { method: "POST" })).text()).toContain(
      "该提醒已失效或已处理。"
    );
  });

  it("提交新链接 → 批量更新历史评论并恢复，且旧提醒记录被清掉", async () => {
    const token = await prepare();
    // 该邮箱的另一条历史评论（也带旧网址）
    seedComment({
      post_slug: "/posts/other",
      author: "Sleepy",
      email: "sleepy@example.com",
      url: "https://sleepy.example.com",
      pub_date: Date.now() - 80 * DAY_MS,
      status: "approved",
    });

    const res = await postForm(`/api/link-dormant/update?token=${token}`, {
      url: "https://new.example.com",
    });
    const html = await res.text();
    expect(html).toContain("链接更新成功！共 2 条历史评论的网址已更新。");

    const urls = db.all(sql`SELECT url FROM "Comment" ORDER BY id`) as { url: string }[];
    expect(urls.map((u) => u.url)).toEqual(["https://new.example.com", "https://new.example.com"]);
    expect(noticeRows()).toHaveLength(0);
  });

  it("新链接与现有相同 → 提示未做修改", async () => {
    const token = await prepare();
    const res = await postForm(`/api/link-dormant/update?token=${token}`, {
      url: "https://sleepy.example.com",
    });
    expect(await res.text()).toContain("新链接与现有链接相同，未做修改。");
  });

  it("非法新链接（javascript: / 空 / mailto）→ 失败文案且不改任何评论", async () => {
    const token = await prepare();
    for (const bad of ["javascript:alert(1)", "", "mailto:a@b.com", "//host/path"]) {
      const res = await postForm(`/api/link-dormant/update?token=${token}`, { url: bad });
      expect(await res.text(), bad).toContain(
        "新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。"
      );
    }
    const urls = db.all(sql`SELECT url FROM "Comment"`) as { url: string }[];
    expect(urls.every((u) => u.url === "https://sleepy.example.com")).toBe(true);
    expect(noticeRows()).toHaveLength(1);
  });
});
