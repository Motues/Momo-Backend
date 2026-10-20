import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_EMOJI_CDN_URL,
  EMOJI_CDN_URLS_ERRORS,
  EMOJI_CDN_URLS_KEY,
  MAX_EMOJI_CDN_URL_LENGTH,
  MAX_EMOJI_CDN_URLS,
  normalizeEmojiCdnUrls,
  parseEmojiCdnUrls,
  resolveEmojiConfigs,
  validateEmojiCdnUrls,
} from "../src/utils/emoji";

/**
 * 表情多来源契约 v3 的跨语言固定向量验收（Node / Go / Worker 读同一份 fixture）。
 *
 * 契约 v3 新增 `emoji_cdn_urls`（JSON 数组，最多 5 个地址），旧的单地址键
 * `emoji_cdn_url` 只在数组解析为空时回落。写入校验（含五条错误文案）与读取
 * 归一化（回落、容错、截断）只要有一端漂移，这里就会立刻失败。
 *
 * 单地址键（契约 v2）的验收仍然由 `vectors.emoji-v2.test.ts` 守着。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "emoji-v3.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("vectors/emoji-v3 — 常量与上限", () => {
  it("上限与 fixture 完全一致（每个地址 500 码点、最多 5 个）", () => {
    expect(MAX_EMOJI_CDN_URL_LENGTH).toBe(fixture.limits.maxCdnUrlLen);
    expect(MAX_EMOJI_CDN_URLS).toBe(fixture.limits.maxCdnUrls);
  });

  it("设置键名固定", () => {
    expect(EMOJI_CDN_URLS_KEY).toBe("emoji_cdn_urls");
    expect(DEFAULT_EMOJI_CDN_URL).toBe(fixture.defaults.cdnUrl);
  });
});

describe("vectors/emoji-v3 — 写入路径校验", () => {
  for (const item of fixture.cdnUrls.valid) {
    it(`合法：${JSON.stringify(item.value)?.slice(0, 60)}`, () => {
      expect(validateEmojiCdnUrls(item.value)).toBeNull();
      expect(parseEmojiCdnUrls(item.value)).toEqual(item.expect);
      // 归一化后必须能往返（存 JSON 数组字符串）
      expect(parseEmojiCdnUrls(normalizeEmojiCdnUrls(item.value))).toEqual(item.expect);
    });
  }

  for (const item of fixture.cdnUrls.invalid) {
    it(`非法（${item.error}）：${JSON.stringify(item.value)?.slice(0, 60)}`, () => {
      expect(validateEmojiCdnUrls(item.value)).toBe(fixture.errors[item.error]);
    });
  }

  it("五条错误文案与 fixture 逐字一致", () => {
    expect(EMOJI_CDN_URLS_ERRORS).toEqual(fixture.errors);
  });

  it("null / undefined 视为未提供，不报错", () => {
    expect(validateEmojiCdnUrls(null)).toBeNull();
    expect(validateEmojiCdnUrls(undefined)).toBeNull();
  });

  it("长度按 Unicode 码点计算（不是 UTF-16 码元）", () => {
    const atLimit = `https://a.com/${"a".repeat(485 - 8)}😀😀`;
    // 构造恰好 500 码点的地址
    const exact = `https://a.com/${"a".repeat(500 - "https://a.com/".length - 2)}😀😀`;
    expect([...exact].length).toBe(500);
    expect(validateEmojiCdnUrls(JSON.stringify([exact]))).toBeNull();
    expect(validateEmojiCdnUrls(JSON.stringify([`${exact}a`]))).not.toBeNull();
    void atLimit;
  });
});

describe("vectors/emoji-v3 — 读取路径归一化", () => {
  for (const testCase of fixture.resolve) {
    it(testCase.name, () => {
      const got = resolveEmojiConfigs(
        testCase.storedUrls,
        testCase.storedCdnUrl,
        testCase.storedEnabled
      );
      expect(got.urls).toEqual(testCase.expectUrls);
      expect(got.enabled).toBe(testCase.expectEnabled);
      // 兼容字段始终等于第一个地址
      expect(got.url).toBe(testCase.expectUrls[0]);
    });
  }

  it("超长数组读取时截断到前 5 个（宽容，不报错）", () => {
    const many = Array.from({ length: 9 }, (_, index) => `https://s${index}.example.com/owo.json`);
    expect(parseEmojiCdnUrls(JSON.stringify(many))).toHaveLength(MAX_EMOJI_CDN_URLS);
    expect(parseEmojiCdnUrls(JSON.stringify(many))[0]).toBe(many[0]);
  });
});
