import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_EMOJI_CDN_URL,
  DEFAULT_EMOJI_ENABLED,
  EMOJI_CDN_URL_KEY,
  EMOJI_ENABLED_KEY,
  MAX_EMOJI_CDN_URL_LENGTH,
  normalizeEmojiEnabled,
  resolveEmojiConfig,
  validateEmojiCdnUrl,
  validateEmojiEnabled,
} from "../src/utils/emoji";

/**
 * 表情配置契约 v2 的跨语言固定向量验收（Node / Go / Worker 读同一份 fixture）。
 *
 * 契约 v2 只剩下两个设置键：`emoji_enabled`（开关）与 `emoji_cdn_url`（OwO 来源地址）。
 * 默认值、长度上限、写入路径校验与读取路径归一化只要有一端漂移，这里就会立刻失败。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "emoji-v2.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("vectors/emoji-v2 — 常量与上限", () => {
  it("默认源 / 默认开关 / 长度上限与 fixture 完全一致", () => {
    expect(DEFAULT_EMOJI_CDN_URL).toBe(fixture.defaults.cdnUrl);
    expect(DEFAULT_EMOJI_ENABLED).toBe(fixture.defaults.enabled);
    expect(MAX_EMOJI_CDN_URL_LENGTH).toBe(fixture.limits.maxCdnUrlLen);
  });

  it("设置键名固定（三端共用同一对键）", () => {
    expect(EMOJI_ENABLED_KEY).toBe("emoji_enabled");
    expect(EMOJI_CDN_URL_KEY).toBe("emoji_cdn_url");
  });
});

describe("vectors/emoji-v2 — emoji_cdn_url 校验", () => {
  for (const value of fixture.cdnUrl.valid) {
    it(`合法：${JSON.stringify(value).slice(0, 60)}`, () => {
      expect(validateEmojiCdnUrl(value)).toBeNull();
    });
  }

  for (const value of fixture.cdnUrl.invalid) {
    it(`非法：${JSON.stringify(value).slice(0, 60)}`, () => {
      expect(validateEmojiCdnUrl(value)).not.toBeNull();
    });
  }

  it("null / undefined 视为未提供，不报错（写入路径会跳过它们）", () => {
    expect(validateEmojiCdnUrl(null)).toBeNull();
    expect(validateEmojiCdnUrl(undefined)).toBeNull();
  });

  it("超长判定按 Unicode 码点（不是 UTF-16 码元 / 字节）", () => {
    // 499 个 ASCII + 2 个 emoji = 501 码点（UTF-16 码元 503）：必须被判为超长
    const value = `https://a.com/${"a".repeat(485)}😀😀`;
    expect([...value].length).toBe(501);
    expect(validateEmojiCdnUrl(value)).not.toBeNull();
  });
});

describe("vectors/emoji-v2 — emoji_enabled 校验", () => {
  for (const value of fixture.enabled.valid) {
    it(`合法：${JSON.stringify(value)}`, () => {
      expect(validateEmojiEnabled(value)).toBeNull();
    });
  }

  for (const value of fixture.enabled.invalid) {
    it(`非法：${JSON.stringify(value)}`, () => {
      expect(validateEmojiEnabled(value)).not.toBeNull();
    });
  }

  it("错误文案与三端一致", () => {
    expect(validateEmojiEnabled("yes")).toBe("emoji_enabled 只能是 true 或 false");
  });

  it("归一化：trim + 转小写", () => {
    expect(normalizeEmojiEnabled("  TRUE ")).toBe("true");
    expect(normalizeEmojiEnabled("False")).toBe("false");
    expect(normalizeEmojiEnabled("   ")).toBe("");
    expect(normalizeEmojiEnabled(null)).toBe("");
    expect(normalizeEmojiEnabled(undefined)).toBe("");
  });
});

describe("vectors/emoji-v2 — 读取归一化", () => {
  for (const testCase of fixture.resolve) {
    it(testCase.name, () => {
      expect(resolveEmojiConfig(testCase.storedUrl, testCase.storedEnabled)).toEqual({
        url: testCase.expectUrl,
        enabled: testCase.expectEnabled,
      });
    });
  }

  it("null / undefined 存储值回落默认源 + 启用", () => {
    expect(resolveEmojiConfig(null, null)).toEqual({
      url: fixture.defaults.cdnUrl,
      enabled: "true",
    });
    expect(resolveEmojiConfig(undefined, undefined)).toEqual({
      url: fixture.defaults.cdnUrl,
      enabled: "true",
    });
  });
});
