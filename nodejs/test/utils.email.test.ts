import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setSetting } from "../src/utils/settings";
import { db } from "../src/orm/client";
import { sql } from "drizzle-orm";
import {
  isEmailServiceAvailable,
  sendTestEmail,
  sendCommentNotification,
  sendCommentReplyNotification,
  sendVerificationEmail,
  checkEmailVerified,
  saveVerificationToken,
  hasUnverifiedToken,
  approvePendingComments,
} from "../src/utils/email";
import { sendEmail as sendEmailDirect } from "../src/utils/SMTP/smtp";
import {
  seedComment,
  startFakeSmtp,
  decodeMessage,
  messageHeader,
  decodeHeaderValue,
  type FakeSmtp,
} from "./helpers";

const INJECTION = "<img src=x onerror=alert(1)>";
const INJECTION_ESCAPED = "&lt;img src=x onerror=alert(1)&gt;";

describe("utils/email — 未配置 SMTP", () => {
  it("isEmailServiceAvailable 在缺少配置时为 false", async () => {
    expect(await isEmailServiceAvailable()).toBe(false);

    await setSetting("smtp_host", "127.0.0.1");
    expect(await isEmailServiceAvailable()).toBe(false); // 还缺 email_user / email_password

    await setSetting("email_user", "u@example.com");
    expect(await isEmailServiceAvailable()).toBe(false);

    await setSetting("email_password", "p");
    expect(await isEmailServiceAvailable()).toBe(true);
  });

  it("sendTestEmail 在未配置时抛出明确错误", async () => {
    db.run(sql`DELETE FROM "Settings" WHERE "key" IN ('smtp_host','email_user','email_password')`);
    await expect(sendTestEmail("a@b.com")).rejects.toThrow(/SMTP is not configured/);
  });

  it("各种通知在未配置时静默返回 null（不抛错）", async () => {
    expect(
      await sendCommentNotification({
        postTitle: "标题",
        postUrl: "https://a.com",
        commentAuthor: "作者",
        commentContent: "内容",
      })
    ).toBeNull();

    expect(
      await sendCommentReplyNotification({
        toEmail: "a@b.com",
        toName: "收件人",
        postTitle: "标题",
        parentComment: "原评论",
        replyAuthor: "回复者",
        replyContent: "回复内容",
        postUrl: "https://a.com",
      })
    ).toBeNull();

    expect(
      await sendVerificationEmail({
        toEmail: "a@b.com",
        toName: "收件人",
        postTitle: "标题",
        postSlug: "/p",
        verifyUrl: "https://a.com/verify?token=1",
      })
    ).toBeNull();
  });
});

describe("utils/email — 已配置 SMTP（本地假服务器）", () => {
  let smtp: FakeSmtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(smtp.port));
    await setSetting("email_user", "sender@example.com");
    await setSetting("email_password", "mail-password");
    await setSetting("email_secure", "false");
    await setSetting("email_enabled", "true");
    await setSetting("site_name", "测试站点");
    await setSetting("admin_email", "admin@example.com");
    await setSetting("verify_base_url", "https://example.com");
  });

  afterAll(async () => {
    await smtp.close();
  });

  afterEach(() => {
    smtp.reset();
  });

  it("isEmailServiceAvailable 为 true", async () => {
    expect(await isEmailServiceAvailable()).toBe(true);
  });

  it("sendTestEmail 能投递并带上站点名", async () => {
    await sendTestEmail("someone@example.com");
    expect(smtp.messages).toHaveLength(1);
    const decoded = decodeMessage(smtp.messages[0]);
    expect(smtp.messages[0]).toContain("To: someone@example.com");
    expect(decodeHeaderValue(messageHeader(smtp.messages[0], "Subject"))).toContain("SMTP 配置验证");
    expect(decoded).toContain("测试站点");
  });

  it("sendCommentNotification 使用默认模板并对用户输入做 HTML 转义", async () => {
    db.run(sql`DELETE FROM "Settings" WHERE "key" = 'notification_template'`);
    smtp.reset();

    await sendCommentNotification({
      postTitle: "标题 <b>x</b>",
      postUrl: "https://example.com/p?x=1&y=2",
      commentAuthor: INJECTION,
      commentContent: "5 < 6 & 7 > 2",
    });

    expect(smtp.messages).toHaveLength(1);
    const raw = smtp.messages[0];
    const body = decodeMessage(raw);

    expect(raw).toContain("To: admin@example.com");
    expect(decodeHeaderValue(messageHeader(raw, "Subject"))).toContain("测试站点");
    // 注入被转义，不会出现可执行标签
    expect(body).toContain(INJECTION_ESCAPED);
    expect(body).not.toContain(INJECTION);
    // 正文中的特殊字符被转义
    expect(body).toContain("5 &lt; 6 &amp; 7 &gt; 2");
    // 标题与链接同样被转义
    expect(body).toContain("标题 &lt;b&gt;x&lt;/b&gt;");
    expect(body).toContain("https://example.com/p?x=1&amp;y=2");
  });

  it("自定义 notification_template 被原样使用（占位符不会替换，与 Go/Worker 不一致）", async () => {
    await setSetting("notification_template", "T: {{commentAuthor}}|{{postTitle}}|{{postUrl}}");
    smtp.reset();

    await sendCommentNotification({
      postTitle: "标题",
      postUrl: "https://example.com",
      commentAuthor: INJECTION,
      commentContent: "内容",
    });

    const body = decodeMessage(smtp.messages[0]);
    // Node 端当前实现：模板直接作为最终 HTML，既不替换占位符也不转义
    // Go/Worker 端会把 {{commentAuthor}} 等替换为转义后的值
    expect(body).toBe("T: {{commentAuthor}}|{{postTitle}}|{{postUrl}}");
    expect(body).not.toContain(INJECTION_ESCAPED);
    expect(body).not.toContain(INJECTION);
    db.run(sql`DELETE FROM "Settings" WHERE "key" = 'notification_template'`);
  });

  it("sendCommentReplyNotification 使用默认模板并转义全部字段", async () => {
    db.run(sql`DELETE FROM "Settings" WHERE "key" = 'reply_template'`);
    smtp.reset();

    await sendCommentReplyNotification({
      toEmail: "parent@example.com",
      toName: INJECTION,
      postTitle: INJECTION,
      parentComment: INJECTION,
      replyAuthor: INJECTION,
      replyContent: INJECTION,
      postUrl: 'https://example.com/?q="x"',
    });

    const raw = smtp.messages[0];
    const body = decodeMessage(raw);
    expect(raw).toContain("To: parent@example.com");
    expect(decodeHeaderValue(messageHeader(raw, "Subject"))).toContain("测试站点");
    expect(body).toContain(INJECTION_ESCAPED);
    expect(body).not.toContain(INJECTION);
    expect(body).toContain("https://example.com/?q=&quot;x&quot;");
  });

  it("自定义 reply_template 同样被原样使用", async () => {
    await setSetting("reply_template", "R: {{toName}}|{{replyContent}}");
    smtp.reset();

    await sendCommentReplyNotification({
      toEmail: "parent@example.com",
      toName: "收件人",
      postTitle: "标题",
      parentComment: "原评论",
      replyAuthor: "回复者",
      replyContent: "回复内容",
      postUrl: "https://example.com",
    });

    expect(decodeMessage(smtp.messages[0])).toBe("R: {{toName}}|{{replyContent}}");
    db.run(sql`DELETE FROM "Settings" WHERE "key" = 'reply_template'`);
  });

  it("sendVerificationEmail 转义收件人昵称、站点名、标题与验证链接", async () => {
    smtp.reset();
    await sendVerificationEmail({
      toEmail: "new@example.com",
      toName: INJECTION,
      postTitle: "标题 <b>x</b>",
      postSlug: "/p",
      verifyUrl: 'https://example.com/verify?token=1&email="a"',
    });

    const body = decodeMessage(smtp.messages[0]);
    expect(smtp.messages[0]).toContain("To: new@example.com");
    expect(body).toContain(INJECTION_ESCAPED);
    expect(body).not.toContain(INJECTION);
    expect(body).toContain("标题 &lt;b&gt;x&lt;/b&gt;");
    expect(body).toContain("&amp;email=&quot;a&quot;");
  });

  it("email_enabled=false 时所有通知都跳过（返回 null）", async () => {
    await setSetting("email_enabled", "false");
    try {
      expect(
        await sendCommentNotification({
          postTitle: "标题",
          postUrl: "https://a.com",
          commentAuthor: "作者",
          commentContent: "内容",
        })
      ).toBeNull();
      expect(
        await sendCommentReplyNotification({
          toEmail: "a@b.com",
          toName: "收件人",
          postTitle: "标题",
          parentComment: "原评论",
          replyAuthor: "回复者",
          replyContent: "回复内容",
          postUrl: "https://a.com",
        })
      ).toBeNull();
      await expect(sendTestEmail("a@b.com")).rejects.toThrow(/currently disabled/);
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await setSetting("email_enabled", "true");
    }
  });

  it("未配置 admin_email 时新评论通知被跳过", async () => {    await setSetting("admin_email", "");
    try {
      expect(
        await sendCommentNotification({
          postTitle: "标题",
          postUrl: "https://a.com",
          commentAuthor: "作者",
          commentContent: "内容",
        })
      ).toBeNull();
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await setSetting("admin_email", "admin@example.com");
    }
  });

  it("email_enabled=false 时验证邮件也被跳过", async () => {
    await setSetting("email_enabled", "false");
    try {
      expect(
        await sendVerificationEmail({
          toEmail: "a@b.com",
          toName: "收件人",
          postTitle: "标题",
          postSlug: "/p",
          verifyUrl: "https://a.com/v",
        })
      ).toBeNull();
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await setSetting("email_enabled", "true");
    }
  });

  it("SMTP 不可达时通知与验证邮件都静默返回 null（不抛错）", async () => {
    // 借一个「刚关闭」的端口模拟 SMTP 不可达，连接会被立刻拒绝
    const temp = await startFakeSmtp();
    const deadPort = temp.port;
    await temp.close();
    await setSetting("smtp_port", String(deadPort));
    try {
      expect(
        await sendCommentNotification({
          postTitle: "标题",
          postUrl: "https://a.com",
          commentAuthor: "作者",
          commentContent: "内容",
        })
      ).toBeNull();
      expect(
        await sendCommentReplyNotification({
          toEmail: "a@b.com",
          toName: "收件人",
          postTitle: "标题",
          parentComment: "原评论",
          replyAuthor: "回复者",
          replyContent: "回复内容",
          postUrl: "https://a.com",
        })
      ).toBeNull();
      expect(
        await sendVerificationEmail({
          toEmail: "a@b.com",
          toName: "收件人",
          postTitle: "标题",
          postSlug: "/p",
          verifyUrl: "https://a.com/v",
        })
      ).toBeNull();
    } finally {
      await setSetting("smtp_port", String(smtp.port));
    }
  });
});

describe("utils/SMTP — 底层 sendEmail", () => {
  let smtp: FakeSmtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });

  afterAll(async () => {
    await smtp.close();
  });

  afterEach(() => {
    smtp.reset();
  });

  it("能连通并投递纯文本 + HTML 内容", async () => {
    const info = await sendEmailDirect(
      {
        host: "127.0.0.1",
        port: smtp.port,
        secure: false,
        auth: { user: "u@example.com", pass: "p" },
      },
      {
        from: "Sender <u@example.com>",
        to: ["to1@example.com", "to2@example.com"],
        subject: "底层发送测试",
        text: "plain body marker",
        html: "<p>html body marker</p>",
      }
    );

    expect(info.messageId).toBeTruthy();
    expect(info.accepted).toEqual(["to1@example.com", "to2@example.com"]);
    expect(smtp.messages).toHaveLength(1);
    const decoded = decodeMessage(smtp.messages[0]);
    expect(decoded).toContain("html body marker");
    expect(smtp.messages[0]).toContain("to1@example.com");
  });

  it("连接失败时向上抛出错误（由调用方决定如何处理）", async () => {
    const temp = await startFakeSmtp();
    const deadPort = temp.port;
    await temp.close();

    await expect(
      sendEmailDirect(
        {
          host: "127.0.0.1",
          port: deadPort,
          secure: false,
          auth: { user: "u@example.com", pass: "p" },
        },
        { from: "u@example.com", to: "a@b.com", subject: "x", html: "<p>x</p>" }
      )
    ).rejects.toThrow();
  });
});

describe("utils/email — 邮箱验证数据库辅助函数", () => {
  const email = "verify@example.com";

  it("checkEmailVerified 只认 verified=1 的记录", async () => {
    expect(await checkEmailVerified(email)).toBe(false);
    await saveVerificationToken(email, "token-unverified", new Date(Date.now() + 86400000).toISOString(), "/p", "标题");
    expect(await checkEmailVerified(email)).toBe(false);

    db.run(sql`UPDATE "EmailVerification" SET "verified" = 1 WHERE "email" = ${email}`);
    expect(await checkEmailVerified(email)).toBe(true);
    expect(await checkEmailVerified("other@example.com")).toBe(false);
  });

  it("saveVerificationToken 写入 post_slug / post_title 且默认未验证", async () => {
    await saveVerificationToken(
      "fields@example.com",
      "token-fields",
      new Date(Date.now() + 86400000).toISOString(),
      "/posts/x",
      "文章标题"
    );
    const row = db.get(
      sql`SELECT * FROM "EmailVerification" WHERE "token" = 'token-fields'`
    ) as any;
    expect(row.email).toBe("fields@example.com");
    expect(row.verified).toBe(0);
    expect(row.post_slug).toBe("/posts/x");
    expect(row.post_title).toBe("文章标题");
    expect(typeof row.created_at).toBe("string");
    expect(row.verified_at).toBeNull();
  });

  it("saveVerificationToken 可省略文章信息（写入 NULL）", async () => {
    await saveVerificationToken(
      "noinfo@example.com",
      "token-noinfo",
      new Date(Date.now() + 86400000).toISOString()
    );
    const row = db.get(
      sql`SELECT * FROM "EmailVerification" WHERE "token" = 'token-noinfo'`
    ) as any;
    expect(row.post_slug).toBeNull();
    expect(row.post_title).toBeNull();
  });

  it("hasUnverifiedToken 区分未过期与已过期令牌", async () => {
    const fresh = "fresh@example.com";
    const stale = "stale@example.com";

    await saveVerificationToken(fresh, "token-fresh", new Date(Date.now() + 3600_000).toISOString());
    await saveVerificationToken(stale, "token-stale", new Date(Date.now() - 3600_000).toISOString());

    expect(await hasUnverifiedToken(fresh)).toBe(true);
    expect(await hasUnverifiedToken(stale)).toBe(false);
    expect(await hasUnverifiedToken("nobody@example.com")).toBe(false);
  });

  it("已验证的令牌不算未验证令牌", async () => {
    const used = "used@example.com";
    await saveVerificationToken(used, "token-used", new Date(Date.now() + 3600_000).toISOString());
    db.run(sql`UPDATE "EmailVerification" SET "verified" = 1 WHERE "email" = ${used}`);
    expect(await hasUnverifiedToken(used)).toBe(false);
  });

  it("approvePendingComments 只批准该邮箱的 pending 评论", async () => {
    const target = "pending@example.com";
    const pending1 = seedComment({ email: target, status: "pending" });
    const pending2 = seedComment({ email: target, status: "pending" });
    const approved = seedComment({ email: target, status: "approved" });
    const other = seedComment({ email: "other@example.com", status: "pending" });
    const deleted = seedComment({ email: target, status: "deleted" });

    const changed = await approvePendingComments(target);
    expect(changed).toBe(2);

    const statusOf = (id: number) =>
      (db.get(sql`SELECT "status" FROM "Comment" WHERE "id" = ${id}`) as { status: string }).status;
    expect(statusOf(pending1)).toBe("approved");
    expect(statusOf(pending2)).toBe("approved");
    expect(statusOf(approved)).toBe("approved");
    expect(statusOf(other)).toBe("pending");
    expect(statusOf(deleted)).toBe("deleted");
  });

  it("approvePendingComments 无待审评论时返回 0", async () => {
    expect(await approvePendingComments("nobody@example.com")).toBe(0);
  });
});
