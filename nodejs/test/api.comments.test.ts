import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import router from "../src/middleware/routes";
import { db } from "../src/orm/client";
import { setSetting, getSetting } from "../src/utils/settings";
import { DEFAULT_AVATAR_URL } from "../src/utils/avatar";
import { hashIp, hashOrigin } from "../src/utils/verify";
import {
  api,
  json,
  seedComment,
  countComments,
  useTrustProxy,
  resetTables,
  clearSettings,
  startFakeSmtp,
  decodeMessage,
  waitFor,
  type FakeSmtp,
} from "./helpers";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** 每条用例使用独立 IP，避免 60 秒/单 IP 的评论限流互相干扰 */
let ipSequence = 0;
function uniqueIp(): string {
  ipSequence += 1;
  return `198.18.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

const TOUCHED_SETTINGS = [
  "comment_auto_approve",
  "comment_spam_keywords",
  "comment_spam_max_links",
  "comment_spam_min_length",
  "comment_spam_duplicate_window",
  "ip_blacklist",
  "email_blacklist",
  "admin_email",
  "admin_comment_key",
  "admin_comment_key_enabled",
  "comment_verify_enabled",
  "email_verify_enabled",
  "smtp_host",
  "smtp_port",
  "email_user",
  "email_password",
  "email_secure",
  "email_enabled",
  "site_name",
  "verify_base_url",
  "allow_origin",
  "comment_verify_domain_enabled",
  "avatar_enabled",
  "avatar_source",
  "avatar_custom_url",
];

/**
 * 固定签名密钥（协议 v2）：本文件需要本地伪造票据来验证「票据与来源必须同域」。
 *
 * 与 api.verify.test.ts 同样的注意事项：getSecret() 有模块级缓存且只读库一次，
 * 因此在 beforeAll 里写入，并**不**把它放进 TOUCHED_SETTINGS（否则会被清掉）。
 */
const VECTOR_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";

function b64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 本地签一张 v2 票据（origin 为空时对应「未开启域名绑定」的旧形状） */
function localTicket(ip: string, slug: string, origin?: string): string {
  const now = Date.now();
  const payload: Record<string, unknown> = {
    v: 2,
    iph: hashIp(ip, VECTOR_SECRET),
    slug,
    iat: now,
    exp: now + 300000,
    jti: "dGVzdC1qdGk",
  };
  if (origin) payload.org = hashOrigin(origin, VECTOR_SECRET);
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(crypto.createHmac("sha256", VECTOR_SECRET).update(body, "utf8").digest())}`;
}

beforeAll(async () => {
  // 必须早于任何触发 getSecret() 的调用（密钥只读库一次）
  await setSetting("comment_verify_secret", VECTOR_SECRET);
});

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_slug: "/posts/hello",
    author: "访客",
    email: "guest@example.com",
    content: "这是一条评论",
    ...overrides,
  };
}

function postComment(body: unknown, ip = uniqueIp(), headers: Record<string, string> = {}) {
  return api("/api/comments", {
    method: "POST",
    ip,
    body,
    headers: { "user-agent": DESKTOP_UA, ...headers },
  });
}

beforeEach(() => {
  useTrustProxy();
  resetTables();
});

afterEach(() => {
  clearSettings(TOUCHED_SETTINGS);
});

describe("POST /api/comments — 成功路径", () => {
  it("提交成功并落库，pub_date 为毫秒整数", async () => {
    const res = await postComment(validBody({ post_slug: "/posts/success" }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ code: 200, message: "Comment submitted successfully" });

    const row = db.get(
      sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/success'`
    ) as any;
    expect(row.author).toBe("访客");
    expect(row.email).toBe("guest@example.com");
    expect(row.content_text).toBe("这是一条评论");
    expect(row.content_html).toContain("这是一条评论");
    // 毫秒整数，不是 ISO 文本（三端口径，见 doc/data_table.md）
    expect(typeof row.pub_date).toBe("number");
    expect(Number.isInteger(row.pub_date)).toBe(true);
    expect(row.pub_date).toBeGreaterThan(1_600_000_000_000);
    expect(String(row.pub_date)).not.toContain("T");
    expect(Math.abs(row.pub_date - Date.now())).toBeLessThan(10_000);
  });

  it("默认自动审核通过（status=approved）", async () => {
    const ip = uniqueIp();
    await postComment(validBody({ post_slug: "/posts/auto" }), ip);
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/auto'`) as any;
    expect(row.status).toBe("approved");
  });

  it("comment_auto_approve=false 时进入 pending", async () => {
    await setSetting("comment_auto_approve", "false");
    await postComment(validBody({ post_slug: "/posts/pending" }));
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/pending'`) as any;
    expect(row.status).toBe("pending");
  });

  it("记录客户端 IP 与 User-Agent，并解析系统/浏览器/设备", async () => {
    const ip = uniqueIp();
    await postComment(validBody({ post_slug: "/posts/ua" }), ip);
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/ua'`) as any;
    expect(row.ip_address).toBe(ip);
    expect(row.user_agent).toBe(DESKTOP_UA);
    expect(row.os).toBe("Windows 10");
    expect(row.browser).toBe("Chrome 120.0.0.0");
    expect(row.device).toBe("");
  });

  it("移动端 UA 能解析出设备型号", async () => {
    await postComment(validBody({ post_slug: "/posts/mobile" }), uniqueIp(), {
      "user-agent": IPHONE_UA,
    });
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/mobile'`) as any;
    expect(row.os).toBe("iOS 17.0");
    expect(row.browser).toBe("Mobile Safari 17.0");
    expect(row.device).toBe("iPhone");
  });

  it("Markdown 被渲染并净化后写入 content_html", async () => {
    await postComment(validBody({ post_slug: "/posts/md", content: "你好 **世界** `code`" }));
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/md'`) as any;
    expect(row.content_text).toBe("你好 **世界** `code`");
    expect(row.content_html).toContain("<strong>世界</strong>");
    expect(row.content_html).toContain("<code>code</code>");
  });

  it("script 标签连同内容被移除（content_text 与 content_html 都不含脚本）", async () => {
    await postComment(
      validBody({ post_slug: "/posts/xss", content: "<script>alert(1)</script>hello" })
    );
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/xss'`) as any;
    expect(row.content_text).toBe("hello");
    expect(row.content_html).not.toContain("<script");
  });

  it("行内 HTML 的事件属性被剥离且被转义为文本", async () => {
    await postComment(
      validBody({
        post_slug: "/posts/xss2",
        content: 'hello <img src=x onerror="alert(1)">',
      })
    );
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/xss2'`) as any;
    expect(row.content_text).not.toContain("onerror");
    expect(row.content_html).not.toContain("<img");
    expect(row.content_html).toContain("&lt;img");
  });

  it("author 字段同样经过 XSS 过滤", async () => {
    await postComment(
      validBody({ post_slug: "/posts/author-xss", author: "<script>x</script>正常昵称" })
    );
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/author-xss'`) as any;
    expect(row.author).toBe("正常昵称");
  });

  it("url 走协议白名单：javascript: 被清空，相对路径与 https 保留", async () => {
    const ip1 = uniqueIp();
    await postComment(validBody({ post_slug: "/posts/url1", url: "javascript:alert(1)" }), ip1);
    const r1 = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/url1'`) as any;
    expect(r1.url).toBe("");

    await postComment(validBody({ post_slug: "/posts/url2", url: "/about" }));
    const r2 = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/url2'`) as any;
    expect(r2.url).toBe("/about");

    await postComment(validBody({ post_slug: "/posts/url3", url: "https://example.com/me" }));
    const r3 = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/url3'`) as any;
    expect(r3.url).toBe("https://example.com/me");
  });

  it("带 parent_id 的回复被正确写入", async () => {
    const parentId = seedComment({ post_slug: "/posts/reply", status: "approved" });
    await postComment(validBody({ post_slug: "/posts/reply", parent_id: parentId }));
    const row = db.get(
      sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/reply' AND "id" <> ${parentId}`
    ) as any;
    expect(row.parent_id).toBe(parentId);
  });

  it("缺少 post_title / post_url 等可选字段时不影响提交", async () => {
    const before = countComments();
    const res = await postComment(validBody({ post_slug: "/posts/minimal" }));
    expect(res.status).toBe(200);
    expect(countComments()).toBe(before + 1);
  });
});

describe("POST /api/comments — 必填与类型校验", () => {
  it.each(["post_slug", "author", "email", "content"])("缺少 %s 返回 400", async (field) => {
    const body = validBody();
    delete body[field];
    const res = await postComment(body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      code: 400,
      message: "post_slug, author, email, and content are required",
    });
  });

  it("空请求体返回 400", async () => {
    const res = await postComment({});
    expect(res.status).toBe(400);
  });

  it("字段为空串或纯空白返回 400", async () => {
    for (const value of ["", "   ", "\t\n"]) {
      const res = await postComment(validBody({ content: value }));
      expect(res.status, JSON.stringify(value)).toBe(400);
    }
  });

  it("字段类型不是字符串返回 400（避免后续处理抛错）", async () => {
    for (const body of [
      { post_slug: 1 },
      { author: ["a"] },
      { email: { a: 1 } },
      { content: null },
      { content: 123 },
    ]) {
      const res = await postComment(validBody(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("请求体不是合法 JSON 时返回 500（被兜底捕获）", async () => {
    const res = await router.request("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": uniqueIp() },
      body: "{not-json",
    });
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ code: 500, message: "Internal server error" });
  });

  it("邮箱格式错误仍被接受（当前实现不做邮箱格式校验，与 Go/Worker 一致）", async () => {
    const res = await postComment(validBody({ post_slug: "/posts/bad-email", email: "not-an-email" }));
    expect(res.status).toBe(200);
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/bad-email'`) as any;
    expect(row.email).toBe("not-an-email");
  });
});

describe("POST /api/comments — 长度上限", () => {
  it("content 超过 2000 字符返回 400", async () => {
    const res = await postComment(validBody({ content: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.message).toContain("Field too long");
  });

  it("content 正好 2000 字符可通过（边界）", async () => {
    const res = await postComment(validBody({ post_slug: "/posts/max-content", content: "x".repeat(2000) }));
    expect(res.status).toBe(200);
  });

  it("author 超过 100、email 超过 254、url 超过 500、post_slug 超过 200 都返回 400", async () => {
    const cases: Record<string, unknown>[] = [
      { author: "a".repeat(101) },
      { email: `${"a".repeat(250)}@ex.com` },
      { url: `https://example.com/${"a".repeat(500)}` },
      { post_slug: `/${"a".repeat(200)}` },
    ];
    for (const overrides of cases) {
      const res = await postComment(validBody(overrides));
      expect(res.status, JSON.stringify(overrides).slice(0, 40)).toBe(400);
    }
  });

  it("author 正好 100 字符、url 正好 500 字符可通过（边界）", async () => {
    const res = await postComment(
      validBody({
        post_slug: "/posts/max-fields",
        author: "a".repeat(100),
        url: `/${"a".repeat(499)}`,
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/comments — 限流与黑名单", () => {
  it("同一 IP 60 秒内第二次提交返回 429", async () => {
    const ip = uniqueIp();
    expect((await postComment(validBody({ post_slug: "/posts/rl" }), ip)).status).toBe(200);

    const second = await postComment(validBody({ post_slug: "/posts/rl" }), ip);
    expect(second.status).toBe(429);
    expect(await json(second)).toEqual({ code: 429, message: "Time limit exceeded" });
  });

  it("不同 IP 之间互不限流", async () => {
    expect((await postComment(validBody({ post_slug: "/posts/rl-a" }), uniqueIp())).status).toBe(200);
    expect((await postComment(validBody({ post_slug: "/posts/rl-b" }), uniqueIp())).status).toBe(200);
  });

  it("管理员邮箱不限流：同一 IP 60 秒内可连续提交", async () => {
    await setSetting("admin_email", "admin@example.com");
    const ip = uniqueIp();

    expect(
      (await postComment(validBody({ post_slug: "/posts/admin-rl", email: "admin@example.com" }), ip)).status
    ).toBe(200);
    expect(
      (await postComment(validBody({ post_slug: "/posts/admin-rl", email: "admin@example.com" }), ip)).status
    ).toBe(200);
  });

  it("未配置 admin_email 时普通邮箱仍受限流约束", async () => {
    const ip = uniqueIp();

    expect(
      (await postComment(validBody({ post_slug: "/posts/plain-rl", email: "admin@example.com" }), ip)).status
    ).toBe(200);
    expect(
      (await postComment(validBody({ post_slug: "/posts/plain-rl", email: "admin@example.com" }), ip)).status
    ).toBe(429);
  });

  it("IP 在黑名单中返回 403", async () => {
    const ip = uniqueIp();
    await setSetting("ip_blacklist", JSON.stringify([ip]));
    const res = await postComment(validBody({ post_slug: "/posts/ip-blocked" }), ip);
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 403, message: "Your IP has been blocked" });
  });

  it("CIDR 黑名单命中网段内任意 IP", async () => {
    await setSetting("ip_blacklist", JSON.stringify(["198.18.0.0/15"]));
    const res = await postComment(validBody({ post_slug: "/posts/cidr" }), "198.18.200.5");
    expect(res.status).toBe(403);
  });

  it("邮箱黑名单命中返回 403（大小写不敏感）", async () => {
    await setSetting("email_blacklist", JSON.stringify(["blocked@example.com"]));
    const res = await postComment(
      validBody({ post_slug: "/posts/mail-blocked", email: "BLOCKED@Example.com" })
    );
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: 403, message: "Your email has been blocked" });
  });
});

describe("POST /api/comments — 人机验证与博主密钥", () => {
  it("开启人机验证但未携带票据时返回 403 VERIFY_REQUIRED", async () => {
    await setSetting("comment_verify_enabled", "true");
    const res = await postComment(validBody({ post_slug: "/posts/verify" }));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe(403);
    expect(body.reason).toBe("VERIFY_REQUIRED");
  });

  it("博主邮箱缺少/错误 admin_key 时返回 403", async () => {
    await setSetting("admin_email", "admin@example.com");
    await setSetting("admin_comment_key", "k-123");
    await setSetting("admin_comment_key_enabled", "true");

    const missing = await postComment(
      validBody({ post_slug: "/posts/admin", email: "admin@example.com" })
    );
    expect(missing.status).toBe(403);
    expect(await json(missing)).toEqual({ code: 403, message: "Invalid admin key" });

    const wrong = await postComment(
      validBody({ post_slug: "/posts/admin", email: "admin@example.com", admin_key: "nope" })
    );
    expect(wrong.status).toBe(403);
  });

  it("博主密钥正确时直接 approved，且跳过人机验证", async () => {
    await setSetting("admin_email", "admin@example.com");
    await setSetting("admin_comment_key", "k-123");
    await setSetting("admin_comment_key_enabled", "true");
    await setSetting("comment_auto_approve", "false");
    await setSetting("comment_verify_enabled", "true");

    const res = await postComment(
      validBody({
        post_slug: "/posts/admin-ok",
        email: "admin@example.com",
        admin_key: "k-123",
      })
    );
    expect(res.status).toBe(200);
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/admin-ok'`) as any;
    expect(row.status).toBe("approved");
  });

  it("普通邮箱即使带了 admin_key 也仍然进入 pending", async () => {
    await setSetting("admin_email", "admin@example.com");
    await setSetting("admin_comment_key", "k-123");
    await setSetting("admin_comment_key_enabled", "true");
    await setSetting("comment_auto_approve", "false");

    await postComment(validBody({ post_slug: "/posts/normal", admin_key: "k-123" }));
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/normal'`) as any;
    expect(row.status).toBe("pending");
  });
});

describe("GET /api/comments", () => {
  it("缺少 post_slug 返回 400", async () => {
    const res = await api("/api/comments", { ip: uniqueIp() });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ code: 400, message: "post_slug is required" });
  });

  it("post_slug 为空串同样返回 400", async () => {
    const res = await api("/api/comments?post_slug=", { ip: uniqueIp() });
    expect(res.status).toBe(400);
  });

  it("只返回该文章下 approved 的评论", async () => {
    const slug = "/posts/list-approved";
    seedComment({ post_slug: slug, status: "approved", content_text: "通过的" });
    seedComment({ post_slug: slug, status: "pending", content_text: "待审的" });
    seedComment({ post_slug: slug, status: "rejected", content_text: "拒绝的" });
    seedComment({ post_slug: slug, status: "deleted", content_text: "删除的" });
    seedComment({ post_slug: "/posts/other-slug", status: "approved", content_text: "别的文章" });

    const res = await api(`/api/comments?post_slug=${encodeURIComponent(slug)}`, { ip: uniqueIp() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.comments).toHaveLength(1);
    expect(body.data.comments[0].contentText).toBe("通过的");
    expect(body.data.pagination.totalPage).toBe(1);
  });

  it("未知文章返回空列表而不是 404", async () => {
    const res = await api("/api/comments?post_slug=/posts/nobody", { ip: uniqueIp() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.comments).toEqual([]);
    expect(body.data.pagination.totalPage).toBe(1);
  });

  it("头像按 avatar_source 生成：custom / qq / 默认回落（doc/avatar.md）", async () => {
    const slug = "/posts/avatar-source";
    seedComment({ post_slug: slug, status: "approved", author: "张三", email: "张三@example.com" });
    seedComment({ post_slug: slug, status: "approved", author: "QQ", email: "12345@qq.com" });

    setSetting("avatar_source", "custom");
    setSetting(
      "avatar_custom_url",
      "https://cdn.example.com/avatar/{hash}.png?email={email}&name={author}"
    );

    const customBody = await json(
      await api(`/api/comments?post_slug=${encodeURIComponent(slug)}&nested=false`, { ip: uniqueIp() })
    );
    const zhang = customBody.data.comments.find((c: any) => c.author === "张三");
    const qq = customBody.data.comments.find((c: any) => c.author === "QQ");
    expect(zhang.avatar).toBe(
      "https://cdn.example.com/avatar/3f848e3f116808796c3e9bc7a7e2cc44.png?email=%E5%BC%A0%E4%B8%89%40example.com&name=%E5%BC%A0%E4%B8%89"
    );
    expect(qq.avatar).toBe(
      "https://cdn.example.com/avatar/dc7b50de81883385a28ec3d2b0e62fd7.png?email=12345%40qq.com&name=QQ"
    );

    // qq 预设：QQ 邮箱走 qlogo，其余邮箱回落默认源
    setSetting("avatar_source", "qq");
    const qqBody = await json(
      await api(`/api/comments?post_slug=${encodeURIComponent(slug)}&nested=false`, { ip: uniqueIp() })
    );
    const qqResult = qqBody.data.comments.find((c: any) => c.author === "QQ");
    const zhangResult = qqBody.data.comments.find((c: any) => c.author === "张三");
    expect(qqResult.avatar).toBe("https://q1.qlogo.cn/g?b=qq&nk=12345&s=100");
    expect(zhangResult.avatar).toContain("open.motues.top/avatar?");
  });

  it("avatar_enabled=false：所有评论统一下发内置默认头像（不丢已存配置）", async () => {
    const slug = "/posts/avatar-disabled";
    seedComment({ post_slug: slug, status: "approved", author: "张三", email: "张三@example.com" });
    seedComment({ post_slug: slug, status: "approved", author: "QQ", email: "12345@qq.com" });
    setSetting("avatar_source", "custom");
    setSetting("avatar_custom_url", "https://cdn.example.com/{hash}");
    setSetting("avatar_enabled", "false");

    const body = await json(
      await api(`/api/comments?post_slug=${encodeURIComponent(slug)}&nested=false`, { ip: uniqueIp() })
    );
    expect(body.data.comments).toHaveLength(2);
    for (const comment of body.data.comments) {
      expect(comment.avatar).toBe(DEFAULT_AVATAR_URL);
    }
    // 关闭只影响下发结果，来源配置仍然保留
    expect(await getSetting("avatar_source")).toBe("custom");
    expect(await getSetting("avatar_custom_url")).toBe("https://cdn.example.com/{hash}");
  });


  it("默认 nested=true，回复被挂到父评论下", async () => {
    const slug = "/posts/nested";
    const parent = seedComment({ post_slug: slug, status: "approved", content_text: "父评论" });
    seedComment({
      post_slug: slug,
      status: "approved",
      parent_id: parent,
      content_text: "子评论",
    });

    const res = await api(`/api/comments?post_slug=${encodeURIComponent(slug)}`, { ip: uniqueIp() });
    const body = await json(res);
    expect(body.data.comments).toHaveLength(1);
    expect(body.data.comments[0].contentText).toBe("父评论");
    expect(body.data.comments[0].replies).toHaveLength(1);
    expect(body.data.comments[0].replies[0].contentText).toBe("子评论");
  });

  it("nested=false 时返回平铺列表", async () => {
    const slug = "/posts/flat";
    const parent = seedComment({ post_slug: slug, status: "approved", content_text: "父" });
    seedComment({ post_slug: slug, status: "approved", parent_id: parent, content_text: "子" });

    const res = await api(
      `/api/comments?post_slug=${encodeURIComponent(slug)}&nested=false`,
      { ip: uniqueIp() }
    );
    const body = await json(res);
    expect(body.data.comments).toHaveLength(2);
    expect(body.data.comments[1].parentId).toBe(parent);
  });

  it("分页参数被 clamp：page=0 → 1，limit=999 → 50", async () => {
    const slug = "/posts/paging";
    for (let i = 0; i < 3; i++) seedComment({ post_slug: slug, status: "approved" });

    const res = await api(
      `/api/comments?post_slug=${encodeURIComponent(slug)}&page=0&limit=999&nested=false`,
      { ip: uniqueIp() }
    );
    const body = await json(res);
    expect(body.data.pagination.page).toBe(1);
    expect(body.data.pagination.limit).toBe(50);
  });

  it("分页只截取当前页数据", async () => {
    const slug = "/posts/paging2";
    for (let i = 1; i <= 5; i++) {
      seedComment({ post_slug: slug, status: "approved", content_text: `第${i}条` });
    }
    const res = await api(
      `/api/comments?post_slug=${encodeURIComponent(slug)}&page=2&limit=2&nested=false`,
      { ip: uniqueIp() }
    );
    const body = await json(res);
    expect(body.data.comments).toHaveLength(2);
    expect(body.data.pagination).toEqual({ page: 2, limit: 2, totalPage: 3 });
  });

  it("下发博主徽章 / 占位符 / 蜜罐等前端配置字段", async () => {
    await setSetting("blogger_badge_enabled", "true");
    await setSetting("blogger_badge_text", "博主");
    await setSetting("placeholder_name", "昵称");

    const res = await api("/api/comments?post_slug=/posts/config", { ip: uniqueIp() });
    const body = await json(res);
    expect(body.data.blogger_badge_enabled).toBe("true");
    expect(body.data.blogger_badge_text).toBe("博主");
    expect(body.data.placeholder_name).toBe("昵称");
    expect(body.data.admin_comment_key_configured).toBe("false");
    expect(body.data.admin_email_hash).toBe("");
  });

  it("同一 IP 每分钟最多 120 次列表请求，第 121 次返回 429", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 120; i++) {
      const res = await api("/api/comments?post_slug=/posts/ratelimit", { ip });
      expect(res.status, `第 ${i + 1} 次`).toBe(200);
    }
    const blocked = await api("/api/comments?post_slug=/posts/ratelimit", { ip });
    expect(blocked.status).toBe(429);
    expect(await json(blocked)).toEqual({
      code: 429,
      message: "Too many requests. Please slow down.",
    });

    // 换一个 IP 不受影响
    expect((await api("/api/comments?post_slug=/posts/ratelimit", { ip: uniqueIp() })).status).toBe(200);
  });
});

describe("POST /api/comments — 邮件通知与邮箱验证（本地假 SMTP）", () => {
  let smtp: FakeSmtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });

  // 注意：文件级的 afterEach 会清空 smtp_* 设置，因此这里每个用例前都要重新写入
  beforeEach(async () => {
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(smtp.port));
    await setSetting("email_user", "sender@example.com");
    await setSetting("email_password", "p");
    await setSetting("email_secure", "false");
    await setSetting("email_enabled", "true");
    await setSetting("site_name", "测试站点");
    await setSetting("admin_email", "admin@example.com");
  });

  afterAll(async () => {
    await smtp.close();
  });

  afterEach(() => {
    smtp.reset();
  });

  it("新评论会向 admin_email 发送通知邮件", async () => {
    const res = await postComment(
      validBody({ post_slug: "/posts/notify", content: "通知正文", post_title: "文章标题" })
    );
    expect(res.status).toBe(200);

    expect(smtp.messages).toHaveLength(1);
    const raw = smtp.messages[0];
    expect(raw).toContain("To: admin@example.com");
    expect(decodeMessage(raw)).toContain("通知正文");
  });

  it("回复他人评论会向被回复者发送通知，回复自己不发", async () => {
    const parentId = seedComment({
      post_slug: "/posts/reply-mail",
      email: "parent@example.com",
      author: "父评论作者",
      content_text: "原评论内容",
    });

    const reply = await postComment(
      validBody({
        post_slug: "/posts/reply-mail",
        parent_id: parentId,
        email: "replier@example.com",
        content: "这是回复",
      })
    );
    expect(reply.status).toBe(200);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain("To: parent@example.com");
    expect(decodeMessage(smtp.messages[0])).toContain("这是回复");

    // 回复自己：parentComment.email === 提交邮箱 → 不发信
    smtp.reset();
    const selfParent = seedComment({
      post_slug: "/posts/self-reply",
      email: "self@example.com",
      content_text: "自己的评论",
    });
    const selfReply = await postComment(
      validBody({ post_slug: "/posts/self-reply", parent_id: selfParent, email: "self@example.com" })
    );
    expect(selfReply.status).toBe(200);
    expect(smtp.messages).toHaveLength(0);
  });

  it("email_verify_enabled=true 且邮箱未验证时，评论进入 pending 并发送验证邮件", async () => {
    await setSetting("email_verify_enabled", "true");
    await setSetting("verify_base_url", "https://example.com");
    const email = "unverified@example.com";
    const res = await postComment(validBody({ post_slug: "/posts/email-verify", email }));
    expect(res.status).toBe(200);
    expect((await json(res)).message).toContain("Verification email sent");

    const row = db.get(
      sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/email-verify'`
    ) as any;
    expect(row.status).toBe("pending");

    const token = db.get(
      sql`SELECT * FROM "EmailVerification" WHERE "email" = ${email}`
    ) as any;
    expect(token).toBeTruthy();
    expect(token.verified).toBe(0);
    expect(token.post_slug).toBe("/posts/email-verify");

    // 验证邮件是「发射后不管」，轮询等待其到达（管理员通知会先同步送达）
    expect(await waitFor(() => smtp.messages.some((m) => m.includes(`To: ${email}`)))).toBe(true);
    const verification = smtp.messages.find((m) => m.includes(`To: ${email}`)) as string;
    const body = decodeMessage(verification);
    expect(body).toContain("https://example.com/api/verify-email/verify");
    expect(body).toContain(`token=${encodeURIComponent(token.token)}`);
    expect(body).toContain("unverified%40example.com");
  });

  it("已有未过期验证令牌时不重复发送验证邮件", async () => {
    await setSetting("email_verify_enabled", "true");
    const email = "repeat@example.com";
    await postComment(validBody({ post_slug: "/posts/repeat-1", email }));
    expect(await waitFor(() => smtp.messages.some((m) => m.includes(`To: ${email}`)))).toBe(true);

    smtp.reset();
    // 换一个 IP 规避 60 秒评论限流，邮箱仍是同一个
    const second = await postComment(validBody({ post_slug: "/posts/repeat-2", email }), uniqueIp());
    expect(second.status).toBe(200);

    const tokens = db.all(
      sql`SELECT * FROM "EmailVerification" WHERE "email" = ${email}`
    ) as any[];
    expect(tokens).toHaveLength(1);
    // 给等待留出余量，确认确实没有第二封「验证邮件」
    // （新评论的管理员通知仍会正常发送，收件人是 admin@example.com）
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(smtp.messages.every((m) => !m.includes(`To: ${email}`))).toBe(true);
  });

  it("已验证邮箱不再进入 pending，也不发送验证邮件", async () => {
    await setSetting("email_verify_enabled", "true");
    const email = "verified@example.com";
    db.run(sql`
      INSERT INTO "EmailVerification" ("email","token","expires_at","verified","created_at","verified_at")
      VALUES (${email},'token-verified',${new Date(Date.now() + 86400000).toISOString()},1,${new Date().toISOString()},${new Date().toISOString()})
    `);

    const res = await postComment(validBody({ post_slug: "/posts/verified-mail", email }));
    expect(res.status).toBe(200);
    expect((await json(res)).message).toBe("Comment submitted successfully");

    const row = db.get(
      sql`SELECT * FROM "Comment" WHERE "post_slug" = '/posts/verified-mail'`
    ) as any;
    expect(row.status).toBe("approved");
    // 只发管理员通知，不给评论者发验证邮件
    expect(smtp.messages.every((m) => !m.includes(`To: ${email}`))).toBe(true);
    expect(smtp.messages.some((m) => m.includes("To: admin@example.com"))).toBe(true);
  });

  it("邮件验证开关关闭时即便 SMTP 可用也不生成令牌", async () => {
    const res = await postComment(
      validBody({ post_slug: "/posts/no-email-verify", email: "plain@example.com" })
    );
    expect(res.status).toBe(200);
    expect((await json(res)).message).toBe("Comment submitted successfully");
    const tokens = db.all(
      sql`SELECT * FROM "EmailVerification" WHERE "email" = 'plain@example.com'`
    ) as any[];
    expect(tokens).toHaveLength(0);
  });
});

/**
 * 审核自动化：与「评论自动通过」合并为一个开关 ——
 * 开启时命中垃圾规则转待审核、未命中直接通过；关闭时全部待审核。
 */
describe("POST /api/comments — 审核自动化（垃圾规则）", () => {
  /** 9 个码点，长于默认最短长度（5），用于隔离「太短」规则 */
  const NORMAL = "这是一条正常的评论";

  const statusOf = (slug: string) =>
    (db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = ${slug}`) as any)?.status;

  it("默认不启用任何规则：短评论与多链接都直接通过", async () => {
    await postComment(validBody({ post_slug: "/posts/spam-default-ok", content: NORMAL }));
    expect(statusOf("/posts/spam-default-ok")).toBe("approved");

    await postComment(validBody({ post_slug: "/posts/spam-default-short", content: "好文" }));
    expect(statusOf("/posts/spam-default-short")).toBe("approved");

    await postComment(
      validBody({
        post_slug: "/posts/spam-default-links",
        content: "看这里 https://a.com https://b.com https://c.com https://d.com",
      })
    );
    expect(statusOf("/posts/spam-default-links")).toBe("approved");
  });

  it("开启最短长度规则后，正文短于阈值进入待审核", async () => {
    await setSetting("comment_spam_min_length", "5");
    await postComment(validBody({ post_slug: "/posts/spam-short", content: "好文" }));
    expect(statusOf("/posts/spam-short")).toBe("pending");
  });

  it("命中敏感关键词进入待审核", async () => {
    await setSetting("comment_spam_keywords", '["加微信"]');
    await postComment(
      validBody({ post_slug: "/posts/spam-keyword", content: "快来加微信看更多" })
    );
    expect(statusOf("/posts/spam-keyword")).toBe("pending");
  });

  it("昵称命中关键词同样进入待审核", async () => {
    await setSetting("comment_spam_keywords", '["casino"]');
    await postComment(
      validBody({ post_slug: "/posts/spam-author", author: "Casino 代理", content: NORMAL })
    );
    expect(statusOf("/posts/spam-author")).toBe("pending");
  });

  it("网址字段命中关键词进入待审核", async () => {
    await setSetting("comment_spam_keywords", '["casino"]');
    await postComment(
      validBody({
        post_slug: "/posts/spam-url",
        content: NORMAL,
        url: "https://casino.example.com",
      })
    );
    expect(statusOf("/posts/spam-url")).toBe("pending");
  });

  it("未命中关键词时正常通过", async () => {
    await setSetting("comment_spam_keywords", '["加微信","casino"]');
    await postComment(validBody({ post_slug: "/posts/spam-clean", content: NORMAL }));
    expect(statusOf("/posts/spam-clean")).toBe("approved");
  });

  it("关键词配置损坏时放行（fail-open）", async () => {
    await setSetting("comment_spam_keywords", "{oops");
    await postComment(validBody({ post_slug: "/posts/spam-broken-kw", content: NORMAL }));
    expect(statusOf("/posts/spam-broken-kw")).toBe("approved");
  });

  it("链接数超过阈值进入待审核", async () => {
    await setSetting("comment_spam_max_links", "3");
    await postComment(
      validBody({
        post_slug: "/posts/spam-links",
        content: "看这里 https://a.com https://b.com https://c.com https://d.com",
      })
    );
    expect(statusOf("/posts/spam-links")).toBe("pending");
  });

  it("链接数等于阈值时放行", async () => {
    await setSetting("comment_spam_max_links", "3");
    await postComment(
      validBody({
        post_slug: "/posts/spam-links-eq",
        content: "看这里 https://a.com https://b.com https://c.com",
      })
    );
    expect(statusOf("/posts/spam-links-eq")).toBe("approved");
  });

  it("个人网址字段计入链接数", async () => {
    await setSetting("comment_spam_max_links", "3");
    await postComment(
      validBody({
        post_slug: "/posts/spam-links-url",
        content: "看这里 https://a.com https://b.com https://c.com",
        url: "https://me.example.com",
      })
    );
    expect(statusOf("/posts/spam-links-url")).toBe("pending");
  });

  it("阈值为 0 时该条规则不生效", async () => {
    await setSetting("comment_spam_max_links", "0");
    await setSetting("comment_spam_min_length", "0");
    await postComment(
      validBody({
        post_slug: "/posts/spam-rules-off",
        content: "看这里 https://a.com https://b.com https://c.com https://d.com https://e.com",
      })
    );
    expect(statusOf("/posts/spam-rules-off")).toBe("approved");
  });

  it("同一 IP 在时间窗内提交相同正文进入待审核", async () => {
    await setSetting("comment_spam_duplicate_window", "10");
    const ip = uniqueIp();
    seedComment({
      post_slug: "/posts/dup",
      author: "老访客",
      email: "old@example.com",
      content_text: NORMAL,
      status: "approved",
      // 60 秒冷却之外、10 分钟窗口之内的历史评论
      pub_date: Date.now() - 120_000,
      ip_address: ip,
    });

    await postComment(validBody({ post_slug: "/posts/dup-new", content: NORMAL }), ip);
    expect(statusOf("/posts/dup-new")).toBe("pending");
  });

  it("时间窗外的相同正文不算重复", async () => {
    await setSetting("comment_spam_duplicate_window", "10");
    const ip = uniqueIp();
    seedComment({
      post_slug: "/posts/dup-old",
      author: "老访客",
      email: "old@example.com",
      content_text: NORMAL,
      status: "approved",
      pub_date: Date.now() - 11 * 60_000,
      ip_address: ip,
    });

    await postComment(validBody({ post_slug: "/posts/dup-old-new", content: NORMAL }), ip);
    expect(statusOf("/posts/dup-old-new")).toBe("approved");
  });

  it("其他 IP 的相同正文不算重复", async () => {
    await setSetting("comment_spam_duplicate_window", "10");
    seedComment({
      post_slug: "/posts/dup-other",
      author: "老访客",
      email: "old@example.com",
      content_text: NORMAL,
      status: "approved",
      pub_date: Date.now() - 120_000,
      ip_address: uniqueIp(),
    });

    await postComment(validBody({ post_slug: "/posts/dup-other-new", content: NORMAL }), uniqueIp());
    expect(statusOf("/posts/dup-other-new")).toBe("approved");
  });

  it("重复窗口为 0（默认）时关闭重复检测", async () => {
    await setSetting("comment_spam_duplicate_window", "0");
    const ip = uniqueIp();
    seedComment({
      post_slug: "/posts/dup-off",
      author: "老访客",
      email: "old@example.com",
      content_text: NORMAL,
      status: "approved",
      pub_date: Date.now() - 120_000,
      ip_address: ip,
    });

    await postComment(validBody({ post_slug: "/posts/dup-off-new", content: NORMAL }), ip);
    expect(statusOf("/posts/dup-off-new")).toBe("approved");
  });

  it("关闭自动通过时规则不参与判定（全部待审核）", async () => {
    await setSetting("comment_auto_approve", "false");
    await postComment(validBody({ post_slug: "/posts/spam-auto-off", content: NORMAL }));
    expect(statusOf("/posts/spam-auto-off")).toBe("pending");
  });

  it("管理员密钥验证后的博主评论不受规则影响", async () => {
    await setSetting("admin_email", "admin@example.com");
    await setSetting("admin_comment_key", "secret-key");
    await setSetting("admin_comment_key_enabled", "true");
    await setSetting("comment_spam_keywords", '["加微信"]');

    // 正文同时命中关键词且短于默认阈值，博主仍应直接通过
    const res = await postComment(
      validBody({
        post_slug: "/posts/spam-admin",
        author: "博主",
        email: "admin@example.com",
        content: "加微信",
        admin_key: "secret-key",
      })
    );
    expect(res.status).toBe(200);
    expect(statusOf("/posts/spam-admin")).toBe("approved");
  });
});

/**
 * 服务端来源校验：allow_origin 配置成白名单后，写接口必须自己拦下白名单外的提交。
 *
 * 这里带上本地假 SMTP：CORS 时代对方站点即使被浏览器拦下响应，请求照样会落库并发信，
 * 所以「被拒的请求不得落库、不得发信」是这道闸门的核心断言。
 */
describe("POST /api/comments — 服务端来源校验", () => {
  const countOf = (slug: string) =>
    (db.get(sql`SELECT COUNT(*) as count FROM "Comment" WHERE "post_slug" = ${slug}`) as any).count;

  let smtp: FakeSmtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });

  beforeEach(async () => {
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(smtp.port));
    await setSetting("email_user", "sender@example.com");
    await setSetting("email_password", "p");
    await setSetting("email_secure", "false");
    await setSetting("email_enabled", "true");
    await setSetting("admin_email", "admin@example.com");
  });

  afterAll(async () => {
    await smtp.close();
  });

  afterEach(() => {
    smtp.reset();
  });

  it("Origin 在白名单内时正常提交", async () => {
    await setSetting("allow_origin", "https://blog.example.com");

    const res = await postComment(
      validBody({ post_slug: "/posts/origin-ok", post_url: "https://blog.example.com/posts/demo" }),
      uniqueIp(),
      { origin: "https://blog.example.com" }
    );

    expect(res.status).toBe(200);
    expect(countOf("/posts/origin-ok")).toBe(1);
  });

  it("Origin 不在白名单内时返回 403，且不落库、不发信", async () => {
    await setSetting("allow_origin", "https://blog.example.com");

    const res = await postComment(
      validBody({ post_slug: "/posts/origin-denied", post_url: "https://luoxuedev.top/blog/aosp" }),
      uniqueIp(),
      { origin: "https://luoxuedev.top", referer: "https://luoxuedev.top/blog/aosp" }
    );

    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe(403);
    expect(body.reason).toBe("ORIGIN_NOT_ALLOWED");
    expect(countOf("/posts/origin-denied")).toBe(0);
    expect(smtp.messages).toHaveLength(0);
  });

  it("服务端转发（无 Origin/Referer，post_url 指向白名单站点）仍然放行", async () => {
    await setSetting("allow_origin", "https://blog.example.com");

    const res = await postComment(
      validBody({ post_slug: "/posts/origin-proxy", post_url: "https://blog.example.com/posts/demo" })
    );

    expect(res.status).toBe(200);
    expect(smtp.messages).toHaveLength(1);
  });

  it("服务端转发但 post_url 指向未授权站点时拒绝（本次事件形态）", async () => {
    await setSetting("allow_origin", "https://blog.example.com");

    const res = await postComment(
      validBody({ post_slug: "/posts/origin-proxy-denied", post_url: "https://luoxuedev.top/blog/aosp" })
    );

    expect(res.status).toBe(403);
    expect(countOf("/posts/origin-proxy-denied")).toBe(0);
    expect(smtp.messages).toHaveLength(0);
  });

  it("三个来源都没有时拒绝", async () => {
    await setSetting("allow_origin", "https://blog.example.com");

    const res = await postComment(validBody({ post_slug: "/posts/origin-none" }));

    expect(res.status).toBe(403);
    expect(countOf("/posts/origin-none")).toBe(0);
  });

  it("Origin 命中但 post_url 指向别处时拒绝", async () => {
    await setSetting("allow_origin", "https://blog.example.com");

    const res = await postComment(
      validBody({ post_slug: "/posts/origin-mixed", post_url: "https://evil.example/x" }),
      uniqueIp(),
      { origin: "https://blog.example.com" }
    );

    expect(res.status).toBe(403);
    expect(countOf("/posts/origin-mixed")).toBe(0);
  });

  it("allow_origin 未配置时不启用服务端校验（行为与旧版本一致）", async () => {
    const res = await postComment(validBody({ post_slug: "/posts/origin-off" }), uniqueIp(), {
      origin: "https://anywhere.example",
    });

    expect(res.status).toBe(200);
    expect(countOf("/posts/origin-off")).toBe(1);
  });

  it("allow_origin 为 * 时不启用服务端校验", async () => {
    await setSetting("allow_origin", "*");

    const res = await postComment(validBody({ post_slug: "/posts/origin-star" }), uniqueIp(), {
      origin: "https://anywhere.example",
    });

    expect(res.status).toBe(200);
  });

  it("不带 scheme 的白名单条目按主机名匹配", async () => {
    await setSetting("allow_origin", "blog.example.com");

    const res = await postComment(validBody({ post_slug: "/posts/origin-host-only" }), uniqueIp(), {
      origin: "https://blog.example.com",
    });

    expect(res.status).toBe(200);
  });

  it("来源校验早于限流：冷却期内的白名单外请求返回 403 而不是 429", async () => {
    await setSetting("allow_origin", "https://blog.example.com");
    const ip = uniqueIp();
    seedComment({ post_slug: "/posts/origin-throttle", ip_address: ip, pub_date: Date.now() });

    const denied = await postComment(validBody({ post_slug: "/posts/origin-throttle" }), ip, {
      origin: "https://evil.example",
    });
    expect(denied.status).toBe(403);
    expect((await json(denied)).reason).toBe("ORIGIN_NOT_ALLOWED");

    // 白名单内来源才会走到限流，命中 60 秒冷却
    const throttled = await postComment(validBody({ post_slug: "/posts/origin-throttle" }), ip, {
      origin: "https://blog.example.com",
    });
    expect(throttled.status).toBe(429);
  });
});

/**
 * 来源域名绑定（comment_verify_domain_enabled）：挑战 → 票据 → 评论提交 是同一条域名链。
 *
 * 与上面的普通来源校验的区别：
 *  - `allow_origin` 未配置或为 `*` 时 **不跳过**，而是 fail-closed；
 *  - 票据里的 org 必须与本次请求的来源一致，否则即使票据本身有效也要拒绝。
 */
describe("POST /api/comments — 来源域名绑定", () => {
  const ORIGIN_A = "https://blog.example.com";
  const ORIGIN_B = "https://www.example.com";

  const countOf = (slug: string) =>
    (db.get(sql`SELECT COUNT(*) as count FROM "Comment" WHERE "post_slug" = ${slug}`) as any).count;

  let smtp: FakeSmtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });

  afterAll(async () => {
    await smtp.close();
  });

  beforeEach(async () => {
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(smtp.port));
    await setSetting("email_user", "sender@example.com");
    await setSetting("email_password", "p");
    await setSetting("email_secure", "false");
    await setSetting("email_enabled", "true");
    await setSetting("admin_email", "admin@example.com");
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_domain_enabled", "true");
    await setSetting("allow_origin", `${ORIGIN_A},${ORIGIN_B}`);
    smtp.reset();
  });

  it("关闭域名绑定时不看来源（与旧行为一致）", async () => {
    await setSetting("comment_verify_domain_enabled", "false");
    await setSetting("allow_origin", "");
    // 连无感验证一起关掉，单独观察域名校验的开关语义
    await setSetting("comment_verify_enabled", "false");

    const res = await postComment(validBody({ post_slug: "/posts/lock-comment-off" }), uniqueIp(), {
      origin: "https://anywhere.example",
    });
    expect(res.status).toBe(200);
    expect(countOf("/posts/lock-comment-off")).toBe(1);
  });

  it("开启但白名单未配置：403 DOMAIN_NOT_ALLOWED，不落库、不发信", async () => {
    await setSetting("allow_origin", "");

    const res = await postComment(validBody({ post_slug: "/posts/lock-comment-nwl" }), uniqueIp(), {
      origin: ORIGIN_A,
    });

    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("DOMAIN_NOT_ALLOWED");
    expect(countOf("/posts/lock-comment-nwl")).toBe(0);
    expect(smtp.messages).toHaveLength(0);
  });

  it("开启且 allow_origin=* ：同样 fail-closed（普通来源校验在这里会放行）", async () => {
    await setSetting("allow_origin", "*");

    const res = await postComment(validBody({ post_slug: "/posts/lock-comment-star" }), uniqueIp(), {
      origin: ORIGIN_A,
    });

    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("DOMAIN_NOT_ALLOWED");
    expect(countOf("/posts/lock-comment-star")).toBe(0);
  });

  it("同域票据 + 同域请求：正常落库", async () => {
    const ip = uniqueIp();
    const slug = "/posts/lock-comment-ok";

    const res = await postComment(
      validBody({ post_slug: slug, verify_ticket: localTicket(ip, slug, ORIGIN_A) }),
      ip,
      { origin: ORIGIN_A }
    );

    expect(res.status).toBe(200);
    expect(countOf(slug)).toBe(1);
  });

  it("票据来自另一个（同样在白名单内的）域名时拒绝为 VERIFY_REQUIRED", async () => {
    const ip = uniqueIp();
    const slug = "/posts/lock-comment-cross";

    const res = await postComment(
      validBody({ post_slug: slug, verify_ticket: localTicket(ip, slug, ORIGIN_B) }),
      ip,
      { origin: ORIGIN_A }
    );

    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("VERIFY_REQUIRED");
    expect(countOf(slug)).toBe(0);
  });

  it("白名单外的域名即使带有效票据也被拒（连票据都不该用）", async () => {
    const ip = uniqueIp();
    const slug = "/posts/lock-comment-evil";

    const res = await postComment(
      validBody({ post_slug: slug, verify_ticket: localTicket(ip, slug, "https://luoxuedev.top") }),
      ip,
      { origin: "https://luoxuedev.top", referer: "https://luoxuedev.top/blog/aosp" }
    );

    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("DOMAIN_NOT_ALLOWED");
    expect(countOf(slug)).toBe(0);
    expect(smtp.messages).toHaveLength(0);
  });

  it("域名校验早于限流：冷却期内的白名单外请求返回 403 而不是 429", async () => {
    const ip = uniqueIp();
    seedComment({ post_slug: "/posts/lock-comment-throttle", ip_address: ip, pub_date: Date.now() });

    const denied = await postComment(
      validBody({ post_slug: "/posts/lock-comment-throttle" }),
      ip,
      { origin: "https://evil.example" }
    );
    expect(denied.status).toBe(403);
    expect((await json(denied)).reason).toBe("DOMAIN_NOT_ALLOWED");

    // 白名单内来源才会走到限流，命中 60 秒冷却
    const throttled = await postComment(
      validBody({ post_slug: "/posts/lock-comment-throttle" }),
      ip,
      { origin: ORIGIN_A }
    );
    expect(throttled.status).toBe(429);
  });
});
