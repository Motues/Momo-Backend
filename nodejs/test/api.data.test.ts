import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import router from "../src/middleware/routes";
import { db } from "../src/orm/client";
import { setSetting, getSetting, getAllSettings } from "../src/utils/settings";
import { isTrustProxyEnabled } from "../src/utils/ip";
import { api, json, loginToken, seedComment, useTrustProxy, resetTables, clearSettings } from "./helpers";

const RESET_KEYS = [
  "site_name",
  "admin_email",
  "admin_name",
  "admin_password",
  "comment_verify_secret",
  "smtp_host",
  "smtp_port",
  "email_user",
  "email_password",
  "email_secure",
  "allow_origin",
  "email_enabled",
  "comment_auto_approve",
  "comment_spam_keywords",
  "comment_spam_max_links",
  "comment_spam_min_length",
  "comment_spam_duplicate_window",
  "ip_blacklist",
  "email_blacklist",
  "admin_comment_key",
  "admin_comment_key_enabled",
  "trust_proxy",
];

beforeEach(() => {
  useTrustProxy();
  resetTables();
  clearSettings(RESET_KEYS);
});

afterEach(() => {
  clearSettings(RESET_KEYS);
});

describe("GET /admin/data/export/comments", () => {
  it("缺少 token 返回 401", async () => {
    expect((await api("/admin/data/export/comments")).status).toBe(401);
  });

  it("导出结构与字段映射正确，并按 pub_date 升序", async () => {
    const child = seedComment({
      post_slug: "/posts/export",
      author: "甲",
      email: "a@x.com",
      status: "approved",
      pub_date: Date.UTC(2024, 5, 1),
      content_text: "父",
      url: null,
      ip_address: null,
      os: null,
      browser: null,
    });
    seedComment({
      post_slug: "/posts/export",
      author: "乙",
      email: "b@x.com",
      status: "pending",
      parent_id: child,
      pub_date: Date.UTC(2024, 5, 2),
      content_text: "子",
      url: "https://example.com",
      os: "Windows 10",
      browser: "Chrome 120",
    });

    const token = await loginToken();
    const res = await api("/admin/data/export/comments", { token });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.code).toBe(200);
    expect(body.data.type).toBe("comments");
    expect(body.data.version).toBeTypeOf("string");
    expect(body.data.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.data.total).toBe(2);

    const [first, second] = body.data.comments;
    expect(first.id).toBe(child);
    expect(first.pubDate).toBe("2024-06-01T00:00:00.000Z");
    expect(first.url).toBeUndefined();
    expect(first.ipAddress).toBe("");
    expect(first.os).toBe("");
    expect(first.browser).toBe("");
    expect(first.parentId).toBeUndefined();
    expect(first.status).toBe("approved");

    expect(second.parentId).toBe(child);
    expect(second.postSlug).toBe("/posts/export");
    expect(second.url).toBe("https://example.com");
    expect(second.pubDate).toBe("2024-06-02T00:00:00.000Z");
  });

  it("空库导出 total=0", async () => {
    const token = await loginToken();
    const body = await json(await api("/admin/data/export/comments", { token }));
    expect(body.data.total).toBe(0);
    expect(body.data.comments).toEqual([]);
  });
});

describe("POST /admin/data/import/comments", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/data/import/comments", {
      method: "POST",
      body: { comments: [] },
    });
    expect(res.status).toBe(401);
  });

  it("请求体缺少 comments 数组返回 400", async () => {
    const token = await loginToken();
    for (const body of [{}, { comments: "not-array" }, { comments: null }]) {
      const res = await api("/admin/data/import/comments", { method: "POST", token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).message).toContain("comments");
    }
  });

  it("导入成功：默认 pending、重新渲染 content_html、净化 url", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/comments", {
      method: "POST",
      token,
      body: {
        comments: [
          {
            postSlug: "/imported",
            author: "导入用户",
            email: "imp@x.com",
            contentText: "**加粗**",
            contentHtml: "<script>bad</script>",
            url: "javascript:alert(1)",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.imported).toBe(1);
    expect(body.data.errors).toBeUndefined();

    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/imported'`) as any;
    expect(row.status).toBe("pending"); // 缺省状态最安全
    expect(row.content_html).toContain("<strong>加粗</strong>");
    expect(row.content_html).not.toContain("script");
    // 相对公开提交路径（会写入空串）不同，导入路径对空 url 直接不写该列
    expect(row.url).toBeNull();
  });

  it("缺字段的条目被跳过并返回逐条错误信息", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/comments", {
      method: "POST",
      token,
      body: {
        comments: [
          { author: "无 slug", email: "a@x.com", contentText: "x" },
          { postSlug: "/ok-1", email: "a@x.com", contentText: "x" },
          { postSlug: "/ok-2", author: "无邮箱", contentText: "x" },
          { postSlug: "/ok-3", author: "无内容", email: "a@x.com" },
          { postSlug: "/good", author: "完整", email: "a@x.com", contentText: "x" },
        ],
      },
    });
    const body = await json(res);
    expect(body.data.imported).toBe(1);
    expect(body.data.errors).toHaveLength(4);
    expect(body.data.errors[0]).toContain("第 1 条");
    expect(body.data.errors[1]).toContain("第 2 条");
    expect(body.message).toContain("成功 1 条");
    expect(body.message).toContain("失败 4 条");
  });

  it("超长字段被拒绝并计入错误", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/comments", {
      method: "POST",
      token,
      body: {
        comments: [
          { postSlug: "/too-long", author: "a", email: "a@x.com", contentText: "x".repeat(2001) },
          { postSlug: `/${"a".repeat(200)}`, author: "a", email: "a@x.com", contentText: "x" },
        ],
      },
    });
    const body = await json(res);
    expect(body.data.imported).toBe(0);
    expect(body.data.errors).toHaveLength(2);
    expect(body.data.errors[0]).toContain("超出长度限制");
  });

  it("pub_date 兼容毫秒整数、数字字符串与 ISO 字符串，非法值退回当前时间", async () => {
    const token = await loginToken();
    const before = Date.now();
    const res = await api("/admin/data/import/comments", {
      method: "POST",
      token,
      body: {
        comments: [
          { postSlug: "/d1", author: "a", email: "a@x.com", contentText: "x", pubDate: 1700000000000 },
          { postSlug: "/d2", author: "a", email: "a@x.com", contentText: "x", pubDate: "1700000000000" },
          { postSlug: "/d3", author: "a", email: "a@x.com", contentText: "x", pub_date: "2024-01-02T03:04:05.000Z" },
          { postSlug: "/d4", author: "a", email: "a@x.com", contentText: "x", pubDate: "not-a-date" },
          { postSlug: "/d5", author: "a", email: "a@x.com", contentText: "x" },
        ],
      },
    });
    expect((await json(res)).data.imported).toBe(5);

    const pubDateOf = (slug: string) =>
      (db.get(sql`SELECT "pub_date" FROM "Comment" WHERE "post_slug" = ${slug}`) as any).pub_date;
    expect(pubDateOf("/d1")).toBe(1700000000000);
    expect(pubDateOf("/d2")).toBe(1700000000000);
    expect(pubDateOf("/d3")).toBe(Date.parse("2024-01-02T03:04:05.000Z"));
    expect(pubDateOf("/d4")).toBeGreaterThanOrEqual(before);
    // 完全不给 pubDate 时 Node 不发该列，落到 SQLite 默认值 strftime('%s')*1000：
    // 结果是「秒级精度」的时间戳（毫秒部分为 0），与 Go/Worker 的毫秒值略有差异
    expect(pubDateOf("/d5") % 1000).toBe(0);
    expect(Math.abs(pubDateOf("/d5") - Date.now())).toBeLessThan(5000);
  });

  it("导入接受 snake_case 字段与显式 status / parentId", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/comments", {
      method: "POST",
      token,
      body: {
        comments: [
          {
            post_slug: "/snake",
            author: "a",
            email: "a@x.com",
            content_text: "内容",
            status: "approved",
            parent_id: 42,
            ip_address: "1.2.3.4",
            os: "Linux",
            browser: "Firefox",
            user_agent: "UA",
          },
        ],
      },
    });
    expect((await json(res)).data.imported).toBe(1);
    const row = db.get(sql`SELECT * FROM "Comment" WHERE "post_slug" = '/snake'`) as any;
    expect(row.status).toBe("approved");
    expect(row.parent_id).toBe(42);
    expect(row.ip_address).toBe("1.2.3.4");
    expect(row.os).toBe("Linux");
    expect(row.browser).toBe("Firefox");
    expect(row.user_agent).toBe("UA");
  });

  it("空数组导入成功且不写库", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/comments", { method: "POST", token, body: { comments: [] } });
    const body = await json(res);
    expect(body.data.imported).toBe(0);
    const count = db.get(sql`SELECT COUNT(*) AS n FROM "Comment"`) as any;
    expect(count.n).toBe(0);
    // 注意：Go 端对空数组返回 400，Node/Worker 返回 200，属于跨端差异（详见报告）
  });

  it("单条插入失败时记录该条错误但继续导入其余条目", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/comments", {
      method: "POST",
      token,
      body: {
        comments: [
          // parentId 是不可绑定的对象 → better-sqlite3 绑定参数时抛错，被逐条 catch 捕获
          { postSlug: "/bad-parent", author: "a", email: "a@x.com", contentText: "x", parentId: { oops: 1 } },
          { postSlug: "/good-after-error", author: "a", email: "a@x.com", contentText: "x" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.imported).toBe(1);
    expect(body.data.errors).toHaveLength(1);
    expect(body.data.errors[0]).toContain("第 1 条");
    const good = db.get(
      sql`SELECT * FROM "Comment" WHERE "post_slug" = '/good-after-error'`
    ) as any;
    expect(good).toBeTruthy();
  });

  it("导出 → 导入 往返后数据一致", async () => {
    const parent = seedComment({
      post_slug: "/roundtrip",
      author: "甲",
      email: "a@x.com",
      status: "approved",
      pub_date: Date.UTC(2024, 2, 3),
      content_text: "父 <b>x</b>",
      content_html: "<p>父 </p>",
      url: "https://example.com",
      ip_address: "1.2.3.4",
      os: "Windows 10",
      browser: "Chrome 120",
    });
    seedComment({
      post_slug: "/roundtrip",
      author: "乙",
      email: "b@x.com",
      status: "pending",
      parent_id: parent,
      pub_date: Date.UTC(2024, 2, 4),
      content_text: "子",
    });

    const token = await loginToken();
    const before = await json(await api("/admin/data/export/comments", { token }));

    resetTables();
    const imported = await json(
      await api("/admin/data/import/comments", {
        method: "POST",
        token,
        body: { comments: before.data.comments },
      })
    );
    expect(imported.data.imported).toBe(2);

    const after = await json(await api("/admin/data/export/comments", { token }));
    // id 会重新自增；content_html 会被重新渲染（导入时不信任文件里的 HTML），
    // 因此这两项单独断言，其余字段应完全一致
    const normalize = (list: any[]) =>
      list.map(({ id, contentHtml, parentId, ...rest }) => rest);
    expect(after.data.total).toBe(2);
    expect(normalize(after.data.comments)).toEqual(normalize(before.data.comments));

    const afterParent = after.data.comments.find((c: any) => c.author === "甲");
    const afterChild = after.data.comments.find((c: any) => c.author === "乙");
    expect(afterParent.contentHtml).toContain("&lt;b&gt;x&lt;/b&gt;"); // 由 content_text 重新渲染
    expect(afterChild.contentHtml).toContain("子");

    // ⚠️ 已知缺陷：导入按原样复制 parentId，但重新插入后 id 会变化，
    // 因此「导出 → 导入」无法恢复回复关系（子评论指向已不存在的旧 id）。
    // 三端实现（Node/Go/Worker）行为一致，详见最终报告。
    expect(afterChild.parentId).toBe(before.data.comments.find((c: any) => c.author === "乙").parentId);
    expect(afterChild.parentId).not.toBe(afterParent.id);
  });
});

describe("GET /admin/data/export/settings", () => {
  it("缺少 token 返回 401", async () => {
    expect((await api("/admin/data/export/settings")).status).toBe(401);
  });

  it("导出白名单设置，敏感字段置空并记录 sensitiveOmitted", async () => {
    const token = await loginToken();
    await setSetting("site_name", "站点");
    await setSetting("admin_name", "momo");
    await setSetting("email_password", "smtp-secret");
    await setSetting("admin_comment_key", "blogger-key");
    await setSetting("admin_password", "$2b$10$deadbeef");

    const body = await json(await api("/admin/data/export/settings", { token }));
    expect(body.data.type).toBe("settings");
    expect(body.data.settings.site_name).toBe("站点");
    expect(body.data.settings.admin_name).toBe("momo");
    expect(body.data.settings.email_password).toBe("");
    expect(body.data.settings.admin_comment_key).toBe("");
    expect(body.data.settings.admin_password).toBeUndefined();
    expect(body.data.settings.comment_verify_secret).toBeUndefined();
    expect(body.data.settings.email_enabled).toBe("true");
    expect(body.data.sensitiveOmitted.sort()).toEqual(["admin_comment_key", "email_password"]);
  });

  it("敏感字段为空时不记入 sensitiveOmitted", async () => {
    const token = await loginToken();
    const body = await json(await api("/admin/data/export/settings", { token }));
    expect(body.data.sensitiveOmitted).toEqual([]);
  });
});

describe("POST /admin/data/import/settings", () => {
  it("缺少 token 返回 401", async () => {
    expect(
      (await api("/admin/data/import/settings", { method: "POST", body: { site_name: "x" } })).status
    ).toBe(401);
  });

  it("非法 ip_blacklist 返回 400", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: { ip_blacklist: "not-json" },
    });
    expect(res.status).toBe(400);
    expect(await getSetting("ip_blacklist")).toBeNull();
  });

  it("请求体不是 JSON 对象时返回 400", async () => {
    const token = await loginToken();
    const res = await router.request("/admin/data/import/settings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.7",
      },
      body: JSON.stringify("just-a-string"),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("有效的设置数据");
  });

  it("白名单内的键被写入，白名单外的键被忽略", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: {
        site_name: "导入站名",
        comment_auto_approve: "false",
        unknown_key: "应被忽略",
        admin_password: "不应写入",
      },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.updated.sort()).toEqual(["comment_auto_approve", "site_name"]);
    expect(await getSetting("site_name")).toBe("导入站名");
    expect(await getSetting("comment_auto_approve")).toBe("false");
    expect(await getSetting("unknown_key")).toBeNull();
    expect(await getSetting("admin_password")).toBeNull();
  });

  it("敏感字段为空串时不覆盖已有值", async () => {
    const token = await loginToken();
    await setSetting("email_password", "keep-me");
    await setSetting("admin_comment_key", "keep-key");

    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: { email_password: "", admin_comment_key: "", site_name: "新名字" },
    });
    const body = await json(res);
    expect(body.data.updated).toEqual(["site_name"]);
    expect(await getSetting("email_password")).toBe("keep-me");
    expect(await getSetting("admin_comment_key")).toBe("keep-key");
  });

  it("审核自动化规则：非法值整批拒绝，合法值写入", async () => {
    const token = await loginToken();

    const bad = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: { site_name: "不应写入", comment_spam_max_links: "51" },
    });
    expect(bad.status).toBe(400);
    expect((await json(bad)).message).toContain("comment_spam_max_links");
    expect(await getSetting("site_name")).toBeNull();

    const good = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: {
        comment_spam_keywords: JSON.stringify(["加微信"]),
        comment_spam_max_links: "5",
        comment_spam_min_length: "0",
        comment_spam_duplicate_window: "60",
      },
    });
    expect(good.status).toBe(200);
    const body = await json(good);
    expect(body.data.updated.sort()).toEqual([
      "comment_spam_duplicate_window",
      "comment_spam_keywords",
      "comment_spam_max_links",
      "comment_spam_min_length",
    ]);
    expect(await getSetting("comment_spam_max_links")).toBe("5");
  });

  it("导入 trust_proxy 立即生效", async () => {
    const token = await loginToken();
    expect(isTrustProxyEnabled()).toBe(true); // 测试里默认开启，便于控制 IP

    await api("/admin/data/import/settings", { method: "POST", token, body: { trust_proxy: "false" } });
    expect(isTrustProxyEnabled()).toBe(false);
  });

  it("导出 → 清空 → 导入 后设置被还原", async () => {
    const token = await loginToken();
    await setSetting("site_name", "往返站名");
    await setSetting("admin_email", "admin@example.com");
    await setSetting("comment_auto_approve", "false");
    await setSetting("email_password", "smtp-secret");

    const exported = await json(await api("/admin/data/export/settings", { token }));

    clearSettings([...RESET_KEYS, "email_password"]);
    expect(await getSetting("site_name")).toBeNull();

    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: exported.data.settings,
    });
    expect(res.status).toBe(200);

    const all = await getAllSettings();
    expect(all.site_name).toBe("往返站名");
    expect(all.admin_email).toBe("admin@example.com");
    expect(all.comment_auto_approve).toBe("false");
    // 导出的敏感字段是空串，因此不会被写入（保持原样：已清空）
    expect(all.email_password).toBeUndefined();
  });
});
