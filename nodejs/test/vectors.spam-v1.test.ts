import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  countLinks,
  parseSpamKeywords,
  parseSpamNumber,
  evaluateSpamRules,
  validateSpamSetting,
  SPAM_DEFAULTS,
  SPAM_LIMITS,
} from "../src/utils/spam";

/**
 * 审核自动化（垃圾规则）的跨语言固定向量验收。
 *
 * Node / Go / Worker 三端读取同一份 fixture 并各自复算：链接统计口径、长度单位
 * （Unicode 码点，不是 UTF-16 码元/字节）、阈值语义（0 = 不启用）与规则优先级
 * 只要有一端漂移，这里就会立刻失败。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "spam-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("vectors/spam-v1 — 默认值与上限", () => {
  it("默认阈值与 fixture、后台页面一致", () => {
    expect(SPAM_DEFAULTS.maxLinks).toBe(fixture.defaults.maxLinks);
    expect(SPAM_DEFAULTS.minLength).toBe(fixture.defaults.minLength);
    expect(SPAM_DEFAULTS.duplicateWindow).toBe(fixture.defaults.duplicateWindowMinutes);
  });

  it("配置上限与 fixture 一致", () => {
    expect(SPAM_LIMITS.MAX_KEYWORDS).toBe(fixture.limits.maxKeywords);
    expect(SPAM_LIMITS.MAX_KEYWORD_LENGTH).toBe(fixture.limits.maxKeywordLength);
    expect(SPAM_LIMITS.MAX_LINKS).toBe(fixture.limits.maxLinks);
    expect(SPAM_LIMITS.MAX_MIN_LENGTH).toBe(fixture.limits.maxMinLength);
    expect(SPAM_LIMITS.MAX_DUPLICATE_WINDOW_MINUTES).toBe(fixture.limits.maxDuplicateWindowMinutes);
  });
});

describe("vectors/spam-v1 — 关键词解析", () => {
  for (const vector of fixture.parseKeywords) {
    it(vector.name, () => {
      expect(parseSpamKeywords(vector.raw)).toEqual(vector.want);
    });
  }
});

describe("vectors/spam-v1 — 数值配置解析", () => {
  for (const vector of fixture.parseNumber) {
    it(vector.name, () => {
      expect(parseSpamNumber(vector.raw, vector.fallback, vector.max)).toBe(vector.want);
    });
  }
});

describe("vectors/spam-v1 — 链接统计", () => {
  for (const vector of fixture.countLinks) {
    it(vector.name, () => {
      expect(countLinks(vector.text)).toBe(vector.want);
    });
  }
});

describe("vectors/spam-v1 — 规则判定", () => {
  for (const vector of fixture.evaluate) {
    it(vector.name, () => {
      expect(
        evaluateSpamRules({
          content: vector.content,
          author: vector.author,
          url: vector.url,
          keywords: vector.keywords,
          maxLinks: vector.maxLinks,
          minLength: vector.minLength,
        })
      ).toBe(vector.wantReason);
    });
  }
});

describe("vectors/spam-v1 — 后台设置校验", () => {
  for (const vector of fixture.validate) {
    it(vector.name, () => {
      const error = validateSpamSetting(vector.key, vector.value);
      expect(error === null).toBe(!vector.wantError);
    });
  }
});
