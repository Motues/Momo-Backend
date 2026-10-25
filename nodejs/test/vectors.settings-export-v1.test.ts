import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  SETTINGS_EXPORT_DEFAULTS,
  SETTINGS_EXPORT_SENSITIVE_KEYS,
  buildExportedSettings,
} from "../src/utils/settingsExport";

/**
 * 系统设置导出的跨语言固定向量验收（与 Worker / Go 读同一份 fixture）。
 *
 * 导出是「完整快照」：47 个可写设置键全都要出现，缺的键按生效默认值补全。
 * 只要有一端漏键、把默认值写成面板初值（例如把 email_secure 当成 true）、
 * 或把表情来源列表直接写默认源（覆盖旧单地址键），这里就会立刻失败。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "settings-export-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
  version: number;
  defaults: Record<string, string>;
  sensitiveBlanked: string[];
};

const DEFAULT_EMOJI_URLS = JSON.stringify(["https://open.motues.top/emoji/owo.json"]);

describe("vectors/settings-export-v1 — 默认值表", () => {
  it("默认值表与 fixture 逐键一致（不多不少）", () => {
    expect(SETTINGS_EXPORT_DEFAULTS).toEqual(fixture.defaults);
    expect(Object.keys(SETTINGS_EXPORT_DEFAULTS).length).toBe(47);
  });

  it("敏感键与 fixture 一致", () => {
    expect([...SETTINGS_EXPORT_SENSITIVE_KEYS]).toEqual(fixture.sensitiveBlanked);
  });

  it("默认值里的开关 / 数字与后端读取路径的生效值一致", () => {
    // 缺省时后端按 `=== "true"` 判定 → 默认关闭（不是面板初值的 true）
    expect(SETTINGS_EXPORT_DEFAULTS.email_secure).toBe("false");
    expect(SETTINGS_EXPORT_DEFAULTS.comment_verify_enabled).toBe("false");
    expect(SETTINGS_EXPORT_DEFAULTS.link_security_enabled).toBe("false");
    // 缺省时按 `!== "false"` 判定 → 默认开启
    expect(SETTINGS_EXPORT_DEFAULTS.email_enabled).toBe("true");
    expect(SETTINGS_EXPORT_DEFAULTS.comment_auto_approve).toBe("true");
    expect(SETTINGS_EXPORT_DEFAULTS.comment_verify_log_challenge).toBe("true");
    expect(SETTINGS_EXPORT_DEFAULTS.emoji_enabled).toBe("true");
    // 数值类默认值（发信 / 保留天数 / 工作量）
    expect(SETTINGS_EXPORT_DEFAULTS.smtp_port).toBe("465");
    expect(SETTINGS_EXPORT_DEFAULTS.mail_log_retention_days).toBe("30");
    expect(SETTINGS_EXPORT_DEFAULTS.comment_verify_retention_days).toBe("30");
    expect(SETTINGS_EXPORT_DEFAULTS.comment_verify_difficulty).toBe("1000000");
    expect(SETTINGS_EXPORT_DEFAULTS.link_dormant_days).toBe("30");
  });
});

describe("vectors/settings-export-v1 — 完整快照合成", () => {
  it("空库导出全部 47 个键，值等于默认值表（表情也能看到）", () => {
    const { settings, sensitiveOmitted } = buildExportedSettings({});
    expect(Object.keys(settings).length).toBe(47);
    expect(settings).toEqual(fixture.defaults);
    expect(settings.emoji_enabled).toBe("true");
    expect(settings.emoji_cdn_urls).toBe(DEFAULT_EMOJI_URLS);
    expect(sensitiveOmitted).toEqual([]);
  });

  it("库里的值覆盖默认值，缺的键仍然补齐", () => {
    const { settings } = buildExportedSettings({
      site_name: "我的博客",
      emoji_enabled: "false",
      emoji_cdn_urls: '["https://cdn.example.com/owo.json"]',
    });
    expect(settings.site_name).toBe("我的博客");
    expect(settings.emoji_enabled).toBe("false");
    expect(settings.emoji_cdn_urls).toBe('["https://cdn.example.com/owo.json"]');
    // 没存过的键仍然按默认值出现
    expect(settings.smtp_port).toBe("465");
    expect(settings.link_dormant_days).toBe("30");
    expect(Object.keys(settings).length).toBe(47);
  });

  it("表情：缺 emoji_cdn_urls 时导出旧单地址键解析后的列表（不能被默认源覆盖）", () => {
    const { settings } = buildExportedSettings({
      emoji_cdn_url: "https://cdn.example.com/legacy.json",
    });
    expect(settings.emoji_cdn_urls).toBe('["https://cdn.example.com/legacy.json"]');
  });

  it("表情：关闭表情时来源列表照常导出（面板不会丢配置）", () => {
    const { settings } = buildExportedSettings({ emoji_enabled: "false" });
    expect(settings.emoji_enabled).toBe("false");
    expect(settings.emoji_cdn_urls).toBe(DEFAULT_EMOJI_URLS);
  });

  it("敏感键始终出现且为空串，只有存过非空值才登记 sensitiveOmitted", () => {
    const blank = buildExportedSettings({ email_password: "", admin_comment_key: "" });
    expect(blank.settings.email_password).toBe("");
    expect(blank.settings.admin_comment_key).toBe("");
    expect(blank.sensitiveOmitted).toEqual([]);

    const omitted = buildExportedSettings({
      email_password: "smtp-secret",
      admin_comment_key: "blogger-key",
    });
    expect(omitted.settings.email_password).toBe("");
    expect(omitted.settings.admin_comment_key).toBe("");
    expect(omitted.sensitiveOmitted).toEqual(["email_password", "admin_comment_key"]);
  });

  it("白名单外的键不会被带进快照", () => {
    const { settings } = buildExportedSettings({
      admin_password: "$2b$10$deadbeef",
      password_changed: "true",
      comment_verify_secret: "internal-secret",
      secret_key: "leak-me",
    });
    for (const key of ["admin_password", "password_changed", "comment_verify_secret", "secret_key"]) {
      expect(settings[key], key).toBeUndefined();
    }
  });

  it("user_agent 之类的评论字段不会混进设置快照", () => {
    const { settings } = buildExportedSettings({ user_agent: "Mozilla/5.0" });
    expect(settings.user_agent).toBeUndefined();
  });
});
