import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseSpamKeywords,
  parseSpamNumber,
  countLinks,
  evaluateSpamRules,
  isValidSpamKeywordsJson,
  validateSpamSetting,
  validateSpamSettings,
  getSpamSettings,
  checkCommentSpam,
  SPAM_DEFAULTS,
  SPAM_LIMITS,
  SPAM_SETTING_KEYS,
} from "../src/utils/spam";
import { setSetting } from "../src/utils/settings";
import { resetTables, seedComment, clearSettings } from "./helpers";

const SPAM_KEYS = [
  "comment_spam_keywords",
  "comment_spam_max_links",
  "comment_spam_min_length",
  "comment_spam_duplicate_window",
];

beforeEach(() => {
  resetTables();
  clearSettings(SPAM_KEYS);
});

afterEach(() => clearSettings(SPAM_KEYS));

describe("utils/spam — 关键词 JSON 校验", () => {
  it("空串表示未设置，允许", () => {
    expect(isValidSpamKeywordsJson("")).toBe(true);
  });

  it("条数上限为 200", () => {
    const ok = JSON.stringify(Array.from({ length: SPAM_LIMITS.MAX_KEYWORDS }, (_, i) => `k${i}`));
    const tooMany = JSON.stringify(
      Array.from({ length: SPAM_LIMITS.MAX_KEYWORDS + 1 }, (_, i) => `k${i}`)
    );
    expect(isValidSpamKeywordsJson(ok)).toBe(true);
    expect(isValidSpamKeywordsJson(tooMany)).toBe(false);
  });

  it("单条长度上限为 100 个码点（按码点而非码元）", () => {
    const atLimit = JSON.stringify(["字".repeat(SPAM_LIMITS.MAX_KEYWORD_LENGTH)]);
    const overLimit = JSON.stringify(["字".repeat(SPAM_LIMITS.MAX_KEYWORD_LENGTH + 1)]);
    expect(isValidSpamKeywordsJson(atLimit)).toBe(true);
    expect(isValidSpamKeywordsJson(overLimit)).toBe(false);

    // emoji 是 2 个 UTF-16 码元，但只算 1 个码点
    const emoji = JSON.stringify(["👍".repeat(SPAM_LIMITS.MAX_KEYWORD_LENGTH)]);
    expect(isValidSpamKeywordsJson(emoji)).toBe(true);
  });
});

describe("utils/spam — 批量校验", () => {
  it("全部合法时返回 null", () => {
    expect(
      validateSpamSettings({
        comment_spam_keywords: '["加微信"]',
        comment_spam_max_links: "3",
        comment_spam_min_length: "0",
        comment_spam_duplicate_window: "10",
      })
    ).toBeNull();
  });

  it("返回首个错误信息", () => {
    expect(validateSpamSettings({ comment_spam_max_links: "51" })).toContain("comment_spam_max_links");
    expect(validateSpamSettings({ comment_spam_min_length: "abc" })).toContain("comment_spam_min_length");
    expect(validateSpamSettings({ comment_spam_duplicate_window: "10081" })).toContain(
      "comment_spam_duplicate_window"
    );
  });

  it("无关的键不参与校验", () => {
    expect(validateSpamSetting("site_name", "随便")).toBeNull();
  });

  it("SPAM_SETTING_KEYS 覆盖全部四项规则", () => {
    expect([...SPAM_SETTING_KEYS].sort()).toEqual(
      [
        "comment_spam_duplicate_window",
        "comment_spam_keywords",
        "comment_spam_max_links",
        "comment_spam_min_length",
      ].sort()
    );
  });
});

describe("utils/spam — getSpamSettings", () => {
  it("未配置时四项阈值均为 0（不启用任何规则）", async () => {
    const settings = await getSpamSettings();
    expect(settings.keywords).toEqual([]);
    expect(settings.maxLinks).toBe(0);
    expect(settings.minLength).toBe(0);
    expect(settings.duplicateWindow).toBe(0);
    // 与导出常量保持一致，避免「默认值」在两处漂移
    expect(SPAM_DEFAULTS).toEqual({ maxLinks: 0, minLength: 0, duplicateWindow: 0 });
  });

  it("读取已配置的阈值并夹取超限值", async () => {
    await setSetting("comment_spam_keywords", '["加微信"]');
    await setSetting("comment_spam_max_links", "7");
    await setSetting("comment_spam_min_length", "0");
    await setSetting("comment_spam_duplicate_window", "99999");

    const settings = await getSpamSettings();
    expect(settings.keywords).toEqual(["加微信"]);
    expect(settings.maxLinks).toBe(7);
    expect(settings.minLength).toBe(0);
    expect(settings.duplicateWindow).toBe(SPAM_LIMITS.MAX_DUPLICATE_WINDOW_MINUTES);
  });
});

describe("utils/spam — checkCommentSpam（含重复检测）", () => {
  const input = { content: "这是一条正常的评论", author: "访客", url: "", ip: "203.0.113.9" };

  it("默认配置（全部为 0）下短正文与多链接都放行", async () => {
    expect(await checkCommentSpam({ ...input, content: "好文" })).toBeNull();
    expect(
      await checkCommentSpam({
        ...input,
        content: "https://a.com https://b.com https://c.com https://d.com https://e.com",
      })
    ).toBeNull();
  });

  it("未命中任何规则返回 null", async () => {
    expect(await checkCommentSpam(input)).toBeNull();
  });

  it("命中关键词返回原因", async () => {
    await setSetting("comment_spam_keywords", '["加微信"]');
    expect(await checkCommentSpam({ ...input, content: "快来加微信" })).toBe("keyword:加微信");
  });

  it("同一 IP 在时间窗内的相同正文返回重复原因", async () => {
    await setSetting("comment_spam_duplicate_window", "10");
    seedComment({
      post_slug: "/posts/dup",
      content_text: input.content,
      ip_address: input.ip,
      pub_date: Date.now() - 60_000,
      status: "approved",
    });
    expect(await checkCommentSpam(input)).toBe("duplicate:10m");
  });

  it("时间窗外的相同正文不算重复", async () => {
    await setSetting("comment_spam_duplicate_window", "10");
    seedComment({
      post_slug: "/posts/dup",
      content_text: input.content,
      ip_address: input.ip,
      pub_date: Date.now() - 11 * 60_000,
      status: "approved",
    });
    expect(await checkCommentSpam(input)).toBeNull();
  });

  it("其他 IP 的相同正文不算重复", async () => {
    await setSetting("comment_spam_duplicate_window", "10");
    seedComment({
      post_slug: "/posts/dup",
      content_text: input.content,
      ip_address: "203.0.113.200",
      pub_date: Date.now() - 60_000,
      status: "approved",
    });
    expect(await checkCommentSpam(input)).toBeNull();
  });

  it("窗口为 0（默认）时不做重复检测", async () => {
    await setSetting("comment_spam_duplicate_window", "0");
    seedComment({
      post_slug: "/posts/dup",
      content_text: input.content,
      ip_address: input.ip,
      pub_date: Date.now() - 60_000,
      status: "approved",
    });
    expect(await checkCommentSpam(input)).toBeNull();
  });

  it("关键词优先于重复检测（不会为了查库而先命中重复）", async () => {
    await setSetting("comment_spam_keywords", '["加微信"]');
    await setSetting("comment_spam_duplicate_window", "10");
    seedComment({
      post_slug: "/posts/dup",
      content_text: "快来加微信",
      ip_address: input.ip,
      pub_date: Date.now() - 60_000,
      status: "approved",
    });
    expect(await checkCommentSpam({ ...input, content: "快来加微信" })).toBe("keyword:加微信");
  });

  it("关键词配置损坏时该规则放行（fail-open）", async () => {
    await setSetting("comment_spam_keywords", "{oops");
    expect(await checkCommentSpam({ ...input, content: "随便什么内容都可以" })).toBeNull();
  });
});

describe("utils/spam — 纯函数规则", () => {
  it("全部阈值关闭时不判垃圾", () => {
    expect(
      evaluateSpamRules({ content: "好", author: "a", url: "", keywords: [], maxLinks: 0, minLength: 0 })
    ).toBeNull();
  });

  it("解析关键词时丢弃非字符串元素", () => {
    expect(parseSpamKeywords('["ok",42,null]')).toEqual(["ok"]);
  });

  it("数值解析只在非负整数时才采用", () => {
    expect(parseSpamNumber("12", 3, 50)).toBe(12);
    expect(parseSpamNumber("abc", 3, 50)).toBe(3);
    expect(parseSpamNumber("-1", 3, 50)).toBe(3);
  });

  it("链接统计不重复计算 https://www.", () => {
    expect(countLinks("https://www.a.com")).toBe(1);
    expect(countLinks("www.a.com 与 https://b.com")).toBe(2);
  });
});
