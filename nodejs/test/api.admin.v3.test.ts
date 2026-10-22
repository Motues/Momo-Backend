import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { setSetting } from "../src/utils/settings";
import {
  api,
  json,
  loginToken,
  useTrustProxy,
  resetTables,
  clearSettings,
  startFakeSmtp,
  messageHeader,
  decodeHeaderValue,
  type FakeSmtp,
} from "./helpers";

/**
 * 1.8.0 新增设置键的 HTTP 级验收（表情多来源 / 多管理员邮箱 / 链接安全审查）。
 *
 * 重点：
 *  - 白名单与分组：type=emoji / type=link / type=basic 各自下发哪些键；
 *  - 写入校验的错误文案（三端逐字一致）；
 *  - 归一化落库（数组键存 JSON、开关存小写、天数存整数）；
 *  - 整批不落库（任一键非法时同一次请求里的其他键也不能写进去）；
 *  - 测试邮件发给解析后的 notify_email。
 */

const TOUCHED = [
  "emoji_enabled",
  "emoji_cdn_url",
  "emoji_cdn_urls",
  "admin_email",
  "admin_emails",
  "notify_email",
  "link_security_enabled",
  "link_dormant_days",
  "link_sync_enabled",
  "link_dormant_notice_enabled",
  "email_verify_enabled",
  "verify_base_url",
  "mail_log_retention_days",
  "smtp_host",
  "smtp_port",
  "email_user",
  "email_password",
  "email_secure",
  "email_enabled",
  "site_name",
];

let token = "";

beforeAll(async () => {
  useTrustProxy();
});

beforeEach(async () => {
  resetTables();
  token = await loginToken();
});

afterEach(() => {
  clearSettings(TOUCHED);
});

async function put(body: Record<string, unknown>) {
  const res = await api("/admin/settings", { method: "PUT", token, body });
  return { status: res.status, body: await json<any>(res) };
}

async function getGroup(type: string) {
  const res = await api(`/admin/settings?type=${type}`, { token });
  return (await json<any>(res)).data as Record<string, unknown>;
}

describe("GET /admin/settings — 新增分组", () => {
  it("type=emoji 下发 emoji_enabled + emoji_cdn_urls + 兼容的 emoji_cdn_url", async () => {
    await setSetting("emoji_cdn_urls", JSON.stringify(["https://a.example.com/owo.json"]));
    const data = await getGroup("emoji");
    expect(data.emoji_cdn_urls).toBe(JSON.stringify(["https://a.example.com/owo.json"]));
    expect(data.emoji_enabled ?? "true").toBe("true");
  });

  it("type=link 下发四个链接安全键（外加注入的 email_enabled）", async () => {
    await setSetting("link_security_enabled", "true");
    await setSetting("link_dormant_days", "45");
    await setSetting("link_dormant_notice_enabled", "true");
    const data = await getGroup("link");
    expect(data.link_security_enabled).toBe("true");
    expect(data.link_dormant_days).toBe("45");
    expect(data.link_sync_enabled ?? "").toBe("");
    expect(data.link_dormant_notice_enabled).toBe("true");
  });

  it("type=basic 下发 admin_emails 与 notify_email", async () => {
    await setSetting("admin_emails", JSON.stringify(["a@example.com"]));
    await setSetting("notify_email", "a@example.com");
    const data = await getGroup("basic");
    expect(data.admin_emails).toBe(JSON.stringify(["a@example.com"]));
    expect(data.notify_email).toBe("a@example.com");
  });
});

describe("PUT /admin/settings — 表情多来源", () => {
  it("合法数组归一化后落库（trim + 去空）", async () => {
    const { status } = await put({ emoji_cdn_urls: '["  https://a.example.com/owo.json  ", ""]' });
    expect(status).toBe(200);
    const data = await getGroup("emoji");
    expect(data.emoji_cdn_urls).toBe('["https://a.example.com/owo.json"]');
  });

  it("五条错误文案与契约一致", async () => {
    expect((await put({ emoji_cdn_urls: "not json" })).body.message).toBe(
      "emoji_cdn_urls 必须是 JSON 数组"
    );
    expect((await put({ emoji_cdn_urls: "{}" })).body.message).toBe(
      "emoji_cdn_urls 必须是 JSON 数组"
    );
    expect((await put({ emoji_cdn_urls: "[1]" })).body.message).toBe(
      "emoji_cdn_urls 的每一项都必须是字符串"
    );
    expect(
      (
        await put({
          emoji_cdn_urls: JSON.stringify(
            Array.from({ length: 6 }, (_, i) => `https://s${i}.example.com/owo.json`)
          ),
        })
      ).body.message
    ).toBe("emoji_cdn_urls 最多 5 个地址");
    expect((await put({ emoji_cdn_urls: '["ftp://a.example.com/owo.json"]' })).body.message).toBe(
      "emoji_cdn_urls 只允许 http/https 地址"
    );
    expect(
      (await put({ emoji_cdn_urls: JSON.stringify([`https://a.com/${"a".repeat(600)}`]) })).body
        .message
    ).toBe("emoji_cdn_urls 不能超过 500 个字符");
  });

  it("同一次请求里有非法键时整批不落库", async () => {
    const { status } = await put({
      emoji_cdn_urls: '["https://a.example.com/owo.json"]',
      emoji_cdn_url: "ftp://bad.example.com/owo.json",
    });
    expect(status).toBe(400);
    const data = await getGroup("emoji");
    expect(data.emoji_cdn_urls ?? "").toBe("");
  });
});

describe("PUT /admin/settings — 多管理员邮箱", () => {
  it("列表归一化（小写 + 去重保序）后落库", async () => {
    const { status } = await put({ admin_emails: '["  A@X.com ", "b@y.com", "a@x.com"]' });
    expect(status).toBe(200);
    expect((await getGroup("basic")).admin_emails).toBe('["a@x.com","b@y.com"]');
  });

  it("错误文案与契约一致", async () => {
    expect((await put({ admin_emails: "oops" })).body.message).toBe("admin_emails 必须是 JSON 数组");
    expect((await put({ admin_emails: "[1]" })).body.message).toBe(
      "admin_emails 的每一项都必须是字符串"
    );
    expect(
      (
        await put({
          admin_emails: JSON.stringify(Array.from({ length: 11 }, (_, i) => `a${i}@b.com`)),
        })
      ).body.message
    ).toBe("admin_emails 最多 10 个邮箱");
    expect((await put({ admin_emails: '["nope"]' })).body.message).toBe(
      "admin_emails 包含非法邮箱地址"
    );
  });

  it("notify_email 必须命中列表（同请求的新列表优先）", async () => {
    await setSetting("admin_emails", JSON.stringify(["old@example.com"]));

    // 同一请求里带了新列表：按新列表判定
    let result = await put({
      admin_emails: '["a@x.com","b@y.com"]',
      notify_email: "b@y.com",
    });
    expect(result.status).toBe(200);
    expect((await getGroup("basic")).notify_email).toBe("b@y.com");

    // 不在列表里 → 400，且整批不落库（列表还是上一次的值）
    result = await put({ admin_emails: '["c@z.com"]', notify_email: "b@y.com" });
    expect(result.status).toBe(400);
    expect(result.body.message).toBe("notify_email 必须在管理员邮箱列表中");
    expect((await getGroup("basic")).admin_emails).toBe('["a@x.com","b@y.com"]');

    // 只传 notify_email 时按库里的当前列表判定
    expect((await put({ notify_email: "c@z.com" })).body.message).toBe(
      "notify_email 必须在管理员邮箱列表中"
    );
    expect((await put({ notify_email: "nope" })).body.message).toBe(
      "notify_email 必须是合法的邮箱地址"
    );
    // 归一化后命中同样通过
    expect((await put({ notify_email: "  A@X.COM  " })).status).toBe(200);
    expect((await getGroup("basic")).notify_email).toBe("a@x.com");
  });

  it("列表为空时提交 notify_email 一律 400", async () => {
    const result = await put({ notify_email: "a@x.com" });
    expect(result.status).toBe(400);
    expect(result.body.message).toBe("notify_email 必须在管理员邮箱列表中");
  });
});

describe("PUT /admin/settings — 链接安全审查", () => {
  it("开关归一化后落库（fail-closed 取值只是校验，不做语义转换）", async () => {
    // 链接同步 / 休眠提醒开启时要求 API 地址非空
    expect((await put({ verify_base_url: "https://api.example.com" })).status).toBe(200);

    expect((await put({ link_security_enabled: " TRUE " })).status).toBe(200);
    expect((await getGroup("link")).link_security_enabled).toBe("true");

    expect((await put({ link_sync_enabled: "False" })).status).toBe(200);
    expect((await getGroup("link")).link_sync_enabled).toBe("false");

    expect((await put({ link_dormant_notice_enabled: " True " })).status).toBe(200);
    expect((await getGroup("link")).link_dormant_notice_enabled).toBe("true");
  });

  it("开关非法值与天数非法值的错误文案", async () => {
    expect((await put({ link_security_enabled: "yes" })).body.message).toBe(
      "link_security_enabled 只能是 true 或 false"
    );
    expect((await put({ link_sync_enabled: "on" })).body.message).toBe(
      "link_sync_enabled 只能是 true 或 false"
    );
    expect((await put({ link_dormant_notice_enabled: "on" })).body.message).toBe(
      "link_dormant_notice_enabled 只能是 true 或 false"
    );
    for (const value of ["0", "-1", "3651", "abc", "1.5", ""]) {
      expect((await put({ link_dormant_days: value })).body.message).toBe(
        "link_dormant_days 必须是 1-3650 之间的整数"
      );
    }
  });

  it("天数合法值落库为整数", async () => {
    expect((await put({ link_dormant_days: " 45 " })).status).toBe(200);
    expect((await getGroup("link")).link_dormant_days).toBe("45");
  });
});

describe("PUT /admin/settings — API 地址与邮箱验证", () => {
  it("type=basic 下发 verify_base_url 与 email_verify_enabled", async () => {
    await setSetting("verify_base_url", "https://api.example.com");
    await setSetting("email_verify_enabled", "true");
    const data = await getGroup("basic");
    expect(data.verify_base_url).toBe("https://api.example.com");
    expect(data.email_verify_enabled).toBe("true");
  });

  it("API 地址归一化：去首尾空格与末尾斜杠", async () => {
    expect((await put({ verify_base_url: "  https://api.example.com///  " })).status).toBe(200);
    expect((await getGroup("basic")).verify_base_url).toBe("https://api.example.com");
  });

  it("非法 API 地址整批拒绝且文案固定", async () => {
    for (const value of ["api.example.com", "ftp://api.example.com", "https://", "https://a.com?x=1", "https://u:p@a.com"]) {
      const result = await put({ verify_base_url: value, site_name: "不应写入" });
      expect(result.status, value).toBe(400);
      expect(result.body.message, value).toBe("verify_base_url 必须是 http(s) 开头的完整地址");
      expect((await getGroup("basic")).site_name ?? "").not.toBe("不应写入");
    }
  });

  it("邮箱验证开关只接受 true / false / 空串", async () => {
    expect((await put({ email_verify_enabled: "yes" })).body.message).toBe(
      "email_verify_enabled 只能是 true 或 false"
    );
    expect((await put({ verify_base_url: "https://api.example.com" })).status).toBe(200);
    expect((await put({ email_verify_enabled: " TRUE " })).status).toBe(200);
    expect((await getGroup("basic")).email_verify_enabled).toBe("true");
  });

  it("开启邮箱验证 / 链接同步 / 休眠提醒前必须填写 API 地址", async () => {
    expect((await put({ email_verify_enabled: "true" })).body.message).toBe(
      "邮箱验证开启时必须填写 API 地址"
    );
    expect((await put({ link_sync_enabled: "true" })).body.message).toBe(
      "历史链接同步开启时必须填写 API 地址"
    );
    expect((await put({ link_dormant_notice_enabled: "true" })).body.message).toBe(
      "休眠提醒邮件开启时必须填写 API 地址"
    );
  });

  it("清空 API 地址会被仍开启的依赖功能拦住；关闭依赖后可清空", async () => {
    expect((await put({ verify_base_url: "https://api.example.com" })).status).toBe(200);
    expect((await put({ link_sync_enabled: "true" })).status).toBe(200);
    expect((await put({ verify_base_url: "" })).body.message).toBe(
      "历史链接同步开启时必须填写 API 地址"
    );

    expect((await put({ link_sync_enabled: "false" })).status).toBe(200);
    expect((await put({ verify_base_url: "" })).status).toBe(200);
    expect((await getGroup("basic")).verify_base_url).toBe("");
  });

  it("同一请求里同时填地址并开启功能可以通过", async () => {
    const result = await put({
      verify_base_url: "https://api.example.com",
      email_verify_enabled: "true",
      link_sync_enabled: "true",
      link_dormant_notice_enabled: "true",
    });
    expect(result.status).toBe(200);
  });
});

describe("PUT /admin/settings — 邮件日志保留天数", () => {
  it("属于 email 分组，归一化后落库为十进制（0 = 永久保留）", async () => {
    expect((await put({ mail_log_retention_days: " 045 " })).status).toBe(200);
    expect((await getGroup("email")).mail_log_retention_days).toBe("45");

    expect((await put({ mail_log_retention_days: "0" })).status).toBe(200);
    expect((await getGroup("email")).mail_log_retention_days).toBe("0");
  });

  it("非法值整批拒绝且文案固定", async () => {
    for (const value of ["", "-1", "1.5", "3651", "abc", "30d"]) {
      const result = await put({ mail_log_retention_days: value, site_name: "不应写入" });
      expect(result.status, JSON.stringify(value)).toBe(400);
      expect(result.body.message, JSON.stringify(value)).toBe(
        "mail_log_retention_days 必须是 0-3650 之间的整数"
      );
      expect((await getGroup("basic")).site_name ?? "").not.toBe("不应写入");
    }
  });
});

describe("POST /admin/settings/test-email", () => {
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
    await setSetting("admin_emails", JSON.stringify(["a@example.com", "b@example.com"]));
    await setSetting("notify_email", "b@example.com");
  });

  it("发给解析后的 notify_email", async () => {
    const res = await api("/admin/settings/test-email", { method: "POST", token });
    expect(res.status).toBe(200);
    expect(smtp.messages).toHaveLength(1);
    expect(messageHeader(smtp.messages[0], "To")).toContain("b@example.com");
    expect(
      decodeHeaderValue(messageHeader(smtp.messages[0], "Subject")).replace(/\s+/g, "")
    ).toContain("SMTP配置验证");
  });

  it("没有管理员邮箱时返回 400", async () => {
    await setSetting("admin_emails", "[]");
    await setSetting("admin_email", "");
    await setSetting("notify_email", "");
    const res = await api("/admin/settings/test-email", { method: "POST", token });
    expect(res.status).toBe(400);
  });
});

describe("导出 / 导入往返", () => {
  it("新键都能导出并原样导回", async () => {
    await put({ emoji_cdn_urls: '["https://a.example.com/owo.json","https://b.example.com/owo.json"]' });
    await put({ admin_emails: '["a@x.com","b@y.com"]', notify_email: "b@y.com" });
    await put({ verify_base_url: "https://api.example.com" });
    await put({ link_security_enabled: "true", link_dormant_days: "45", link_sync_enabled: "true" });
    await put({ link_dormant_notice_enabled: "true" });

    const exported = await json<any>(await api("/admin/data/export/settings", { token }));
    const settings = exported.data.settings as Record<string, string>;
    expect(settings.emoji_cdn_urls).toBe(
      '["https://a.example.com/owo.json","https://b.example.com/owo.json"]'
    );
    expect(settings.admin_emails).toBe('["a@x.com","b@y.com"]');
    expect(settings.notify_email).toBe("b@y.com");
    expect(settings.link_security_enabled).toBe("true");
    expect(settings.link_dormant_days).toBe("45");
    expect(settings.link_sync_enabled).toBe("true");
    expect(settings.link_dormant_notice_enabled).toBe("true");

    // 清空后导回
    clearSettings(TOUCHED);
    // 导入接口的请求体就是「设置键值对」本身（与导出的 data.settings 同形状）
    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: settings,
    });
    expect(res.status).toBe(200);
    const data = await getGroup("link");
    expect(data.link_security_enabled).toBe("true");
    expect(data.link_dormant_days).toBe("45");
    expect(data.link_dormant_notice_enabled).toBe("true");
    expect((await getGroup("emoji")).emoji_cdn_urls).toBe(
      '["https://a.example.com/owo.json","https://b.example.com/owo.json"]'
    );
  });

  it("导入非法值同样 400（导入文件不可信）", async () => {
    const res = await api("/admin/data/import/settings", {
      method: "POST",
      token,
      body: { link_dormant_days: "0" },
    });
    expect(res.status).toBe(400);
    expect((await json<any>(res)).message).toBe("link_dormant_days 必须是 1-3650 之间的整数");
  });
});
