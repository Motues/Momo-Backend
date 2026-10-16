import { describe, it, expect, beforeEach } from "vitest";
import { api, clearSettings, json, loginToken, seedComment } from "./helpers";
import { getSetting, setSetting } from "../src/utils/settings";
import { DEFAULT_EMOJI_CDN_URL } from "../src/utils/emoji";

/**
 * 表情配置（契约 v2）的接口验收：
 * - `GET /api/emoji` 已下线（自定义表情包随之删除）
 * - `PUT /admin/settings` / `POST /admin/data/import/settings` 的校验与归一化
 *   （口径见 doc/emoji.md 与 doc/vectors/emoji-v2.json）
 * - `emoji_enabled` + `emoji_cdn_url` 随评论列表下发（未配置时回落默认源）
 * - 设置导出 / 导入往返
 */

const SETTING_KEYS = ["emoji_enabled", "emoji_cdn_url", "allow_origin", "site_name"];
const SLUG = "/posts/emoji";
const OTHER_CDN = "https://cdn.example.com/owo.json?group=Emoji";

async function commentsData() {
  const body = await json(await api(`/api/comments?post_slug=${encodeURIComponent(SLUG)}`));
  return body.data;
}

beforeEach(() => {
  clearSettings(SETTING_KEYS);
});

describe("GET /api/emoji — 已下线", () => {
  it("不再返回表情接口（被 SPA fallback 接走，不是 JSON 接口）", async () => {
    // 注意：Node 端有一条 `/*` 的 SPA fallback，删掉路由后 /api/emoji 会落到它上面，
    // 因此这里断言的是「不再是表情 JSON 接口」，而不是状态码 404。
    const res = await api("/api/emoji");
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    const text = await res.text();
    expect(text).not.toContain("Emoji packs fetched");
  });
});

describe("PUT /admin/settings — emoji_enabled", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/settings", { method: "PUT", body: { emoji_enabled: "false" } });
    expect(res.status).toBe(401);
  });

  it("写入时归一化（trim + 转小写）后落库", async () => {
    const token = await loginToken();

    const off = await api("/admin/settings", { method: "PUT", token, body: { emoji_enabled: " FALSE " } });
    expect(off.status).toBe(200);
    expect(await getSetting("emoji_enabled")).toBe("false");

    const on = await api("/admin/settings", { method: "PUT", token, body: { emoji_enabled: "True" } });
    expect(on.status).toBe(200);
    expect(await getSetting("emoji_enabled")).toBe("true");
  });

  it("非法取值被拒绝且不落库", async () => {
    const token = await loginToken();
    for (const value of ["1", "yes", "on", "true1", "否"]) {
      const res = await api("/admin/settings", { method: "PUT", token, body: { emoji_enabled: value } });
      expect(res.status, value).toBe(400);
      expect((await json(res)).message, value).toBe("emoji_enabled 只能是 true 或 false");
    }
    expect(await getSetting("emoji_enabled")).toBeNull();
  });

  it("空串是合法取值（等价于未配置）", async () => {
    const token = await loginToken();
    const res = await api("/admin/settings", { method: "PUT", token, body: { emoji_enabled: "  " } });
    expect(res.status).toBe(200);
    expect(await getSetting("emoji_enabled")).toBe("");
  });
});

describe("PUT /admin/settings — emoji_cdn_url", () => {
  it("只接受 http/https，非法值不落库", async () => {
    const token = await loginToken();
    const bad = await api("/admin/settings", {
      method: "PUT",
      token,
      body: { emoji_cdn_url: "javascript:alert(1)" },
    });
    expect(bad.status).toBe(400);
    expect(await getSetting("emoji_cdn_url")).toBeNull();
  });

  it("两侧空格被归一化，空串合法（读取时回落默认源）", async () => {
    const token = await loginToken();

    const ok = await api("/admin/settings", { method: "PUT", token, body: { emoji_cdn_url: `  ${OTHER_CDN}  ` } });
    expect(ok.status).toBe(200);
    expect(await getSetting("emoji_cdn_url")).toBe(OTHER_CDN);

    const cleared = await api("/admin/settings", { method: "PUT", token, body: { emoji_cdn_url: "" } });
    expect(cleared.status).toBe(200);
    expect(await getSetting("emoji_cdn_url")).toBe("");
  });

  it("emoji_packs 已从白名单移除", async () => {
    const token = await loginToken();
    const res = await api("/admin/settings", {
      method: "PUT",
      token,
      body: { emoji_packs: JSON.stringify({ 包: { type: "emoji", container: [{ icon: "😀" }] } }) },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("not allowed");
    expect(await getSetting("emoji_packs")).toBeNull();
  });

  it("type=emoji 分组只返回两个表情键", async () => {
    const token = await loginToken();
    await setSetting("emoji_enabled", "false");
    await setSetting("emoji_cdn_url", OTHER_CDN);

    const body = await json(await api("/admin/settings?type=emoji", { token }));
    // email_enabled 始终下发，是既有行为
    expect(Object.keys(body.data).sort()).toEqual(["email_enabled", "emoji_cdn_url", "emoji_enabled"]);
    expect(body.data.emoji_enabled).toBe("false");
    expect(body.data.emoji_cdn_url).toBe(OTHER_CDN);
  });

  it("type=emoji 不会带回其他分组的字段", async () => {
    const token = await loginToken();
    await setSetting("site_name", "我的站");
    const body = await json(await api("/admin/settings?type=emoji", { token }));
    expect(body.data.site_name).toBeUndefined();
  });
});

describe("表情配置随评论列表下发", () => {
  it("未配置时回落默认源并启用", async () => {
    seedComment({ post_slug: SLUG });
    const data = await commentsData();
    expect(data.emoji_enabled).toBe("true");
    expect(data.emoji_cdn_url).toBe(DEFAULT_EMOJI_CDN_URL);
  });

  it("配置后按配置下发", async () => {
    seedComment({ post_slug: SLUG });
    await setSetting("emoji_cdn_url", OTHER_CDN);

    const data = await commentsData();
    expect(data.emoji_enabled).toBe("true");
    expect(data.emoji_cdn_url).toBe(OTHER_CDN);
  });

  it("关闭时 enabled=false，但地址照常下发（面板不会丢掉配置）", async () => {
    seedComment({ post_slug: SLUG });
    await setSetting("emoji_enabled", "false");
    await setSetting("emoji_cdn_url", OTHER_CDN);

    const data = await commentsData();
    expect(data.emoji_enabled).toBe("false");
    expect(data.emoji_cdn_url).toBe(OTHER_CDN);
  });

  it("地址为空串（历史配置）同样回落默认源", async () => {
    seedComment({ post_slug: SLUG });
    await setSetting("emoji_cdn_url", "");

    const data = await commentsData();
    expect(data.emoji_cdn_url).toBe(DEFAULT_EMOJI_CDN_URL);
  });

  it("历史脏值大小写不敏感：FALSE 判为关闭", async () => {
    seedComment({ post_slug: SLUG });
    await setSetting("emoji_enabled", "FALSE");

    const data = await commentsData();
    expect(data.emoji_enabled).toBe("false");
  });
});

describe("设置导出 / 导入", () => {
  it("导出包含两个表情键，导入可原样恢复", async () => {
    const token = await loginToken();
    await setSetting("emoji_enabled", "false");
    await setSetting("emoji_cdn_url", OTHER_CDN);

    const exported = await json(await api("/admin/data/export/settings", { token }));
    expect(exported.data.settings.emoji_enabled).toBe("false");
    expect(exported.data.settings.emoji_cdn_url).toBe(OTHER_CDN);

    clearSettings(SETTING_KEYS);
    const imported = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: {
        emoji_enabled: exported.data.settings.emoji_enabled,
        emoji_cdn_url: exported.data.settings.emoji_cdn_url,
      },
    });
    expect(imported.status).toBe(200);
    expect(await getSetting("emoji_enabled")).toBe("false");
    expect(await getSetting("emoji_cdn_url")).toBe(OTHER_CDN);
  });

  it("导入非法开关被拒绝（导入文件同样不可信）", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: { emoji_enabled: "yes" },
    });
    expect(res.status).toBe(400);
    expect(await getSetting("emoji_enabled")).toBeNull();
  });

  it("导入 emoji_cdn_url 两侧空格同样被归一化", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: { emoji_cdn_url: ` ${OTHER_CDN} ` },
    });
    expect(res.status).toBe(200);
    expect(await getSetting("emoji_cdn_url")).toBe(OTHER_CDN);
  });

  it("导入 emoji_enabled 同样归一化", async () => {
    const token = await loginToken();
    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: { emoji_enabled: " FALSE " },
    });
    expect(res.status).toBe(200);
    expect(await getSetting("emoji_enabled")).toBe("false");
  });
});
