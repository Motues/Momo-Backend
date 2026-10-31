import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AVATAR_CUSTOM_URL_KEY,
  AVATAR_ENABLED_KEY,
  AVATAR_ERRORS,
  AVATAR_PLACEHOLDERS,
  AVATAR_SOURCE_KEY,
  AVATAR_SOURCES,
  AVATAR_TEMPLATES,
  AVATAR_URL_MAX_LENGTH,
  DEFAULT_AVATAR_CUSTOM_URL,
  DEFAULT_AVATAR_ENABLED,
  DEFAULT_AVATAR_SOURCE,
  DEFAULT_AVATAR_URL,
  isAvatarEnabled,
  normalizeAvatarEnabled,
  normalizeAvatarSource,
  resolveAvatarConfig,
  resolveAvatarUrl,
  validateAvatarCustomUrl,
  validateAvatarEnabled,
  validateAvatarSettings,
  validateAvatarSource,
} from "../src/utils/avatar";

/**
 * 评论区头像来源契约 v1 的跨语言固定向量验收（与 Go / Worker 读同一份 fixture）。
 *
 * 口径见 `doc/avatar.md`：预设模板 / 四个占位符 / 六条写入错误文案 /
 * 读取 fail-open 回落 / 生成结果，三端必须逐条一致。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "avatar-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
  version: number;
  defaults: { enabled: string; source: string; customUrl: string };
  defaultAvatarUrl: string;
  enabled: {
    normalize: { value: string | null; expect: string }[];
    effective: { value: string | null; expect: boolean }[];
    invalid: { value: string | null; error: string }[];
  };
  limits: { maxUrlLen: number };
  sources: string[];
  templates: Record<string, string>;
  placeholders: string[];
  errors: Record<string, string>;
  validateSource: {
    valid: { value: string | null; expect: string }[];
    invalid: { value: string | null; error: string }[];
  };
  validateCustomUrl: {
    valid: { value: string | null; expect: string }[];
    invalid: { value: string | null; error: string }[];
  };
  resolve: {
    name: string;
    source: string | null;
    customUrl: string | null;
    expect: { source: string; template: string };
  }[];
  build: {
    name: string;
    enabled?: boolean;
    source: string | null;
    customUrl: string | null;
    email: string;
    author: string;
    expect: string;
  }[];
};

describe("vectors/avatar-v1 — 常量与错误文案", () => {
  it("默认值 / 来源取值 / 模板 / 占位符 / 长度上限与 fixture 一致", () => {
    expect(DEFAULT_AVATAR_ENABLED).toBe(fixture.defaults.enabled);
    expect(DEFAULT_AVATAR_SOURCE).toBe(fixture.defaults.source);
    expect(DEFAULT_AVATAR_CUSTOM_URL).toBe(fixture.defaults.customUrl);
    expect(DEFAULT_AVATAR_URL).toBe(fixture.defaultAvatarUrl);
    expect([...AVATAR_SOURCES]).toEqual(fixture.sources);
    expect(AVATAR_TEMPLATES).toEqual(fixture.templates);
    expect([...AVATAR_PLACEHOLDERS]).toEqual(fixture.placeholders);
    expect(AVATAR_URL_MAX_LENGTH).toBe(fixture.limits.maxUrlLen);
  });

  it("设置键名固定（与文档 / 面板一致）", () => {
    expect(AVATAR_ENABLED_KEY).toBe("avatar_enabled");
    expect(AVATAR_SOURCE_KEY).toBe("avatar_source");
    expect(AVATAR_CUSTOM_URL_KEY).toBe("avatar_custom_url");
  });

  it("错误文案与 fixture 逐条一致", () => {
    expect(AVATAR_ERRORS.notString).toBe(fixture.errors.notString);
    expect(AVATAR_ERRORS.badSource).toBe(fixture.errors.badSource);
    expect(AVATAR_ERRORS.badScheme).toBe(fixture.errors.badScheme);
    expect(AVATAR_ERRORS.tooLong).toBe(fixture.errors.tooLong);
    expect(AVATAR_ERRORS.controlChar).toBe(fixture.errors.controlChar);
    expect(AVATAR_ERRORS.emptyCustom).toBe(fixture.errors.emptyCustom);
    expect(AVATAR_ERRORS.badEnabled).toBe(fixture.errors.badEnabled);
    // 具体占位符会拼在错误文案后面（{foo} 为 fixture 里的样例）
    expect(`${AVATAR_ERRORS.badPlaceholder}：{foo}`).toBe(fixture.errors.badPlaceholder);
  });
});

describe("vectors/avatar-v1 — avatar_enabled 读取/校验", () => {
  it.each(fixture.enabled.normalize)("归一化 $value → $expect", ({ value, expect: expected }) => {
    expect(normalizeAvatarEnabled(value)).toBe(expected);
  });

  it.each(fixture.enabled.effective)("生效值 $value → $expect", ({ value, expect: expected }) => {
    expect(isAvatarEnabled(value)).toBe(expected);
  });

  it.each(fixture.enabled.invalid)("非法输入 $value 返回统一错误", ({ value, error }) => {
    expect(validateAvatarEnabled(value)).toBe(error);
  });
});

describe("vectors/avatar-v1 — avatar_source 读取/校验", () => {
  it.each(fixture.validateSource.valid)(
    "合法输入 $value 归一化为 $expect",
    ({ value, expect: expected }) => {
      expect(normalizeAvatarSource(value)).toBe(expected);
      expect(validateAvatarSource(value)).toBeNull();
    }
  );

  it.each(fixture.validateSource.invalid)("非法输入 $value 返回统一错误", ({ value, error }) => {
    expect(validateAvatarSource(value)).toBe(error);
  });
});

describe("vectors/avatar-v1 — avatar_custom_url 校验", () => {
  it.each(fixture.validateCustomUrl.valid)(
    "合法输入 $value 通过（trim 后为 $expect）",
    ({ value, expect: expected }) => {
      expect(validateAvatarCustomUrl(value)).toBeNull();
      expect(typeof value === "string" ? value.trim() : "").toBe(expected);
    }
  );

  it.each(fixture.validateCustomUrl.invalid)("非法输入返回统一错误", ({ value, error }) => {
    expect(validateAvatarCustomUrl(value)).toBe(error);
  });

  it("非字符串按 notString 拒绝", () => {
    expect(validateAvatarCustomUrl(123)).toBe(AVATAR_ERRORS.notString);
    expect(validateAvatarCustomUrl({})).toBe(AVATAR_ERRORS.notString);
  });
});

describe("vectors/avatar-v1 — 读取归一化（fail-open）", () => {
  it.each(fixture.resolve)("$name", ({ source, customUrl, expect: expected }) => {
    expect(resolveAvatarConfig(source, customUrl)).toEqual(expected);
  });
});

describe("vectors/avatar-v1 — 头像地址生成", () => {
  it.each(fixture.build)("$name", ({ enabled, source, customUrl, email, author, expect: expected }) => {
    const config = resolveAvatarConfig(source, customUrl);
    expect(resolveAvatarUrl(enabled !== false, config, email, author)).toBe(expected);
  });
});

describe("vectors/avatar-v1 — 关闭头像", () => {
  it("关闭时无论来源如何都返回内置默认头像", () => {
    for (const source of AVATAR_SOURCES) {
      const config = resolveAvatarConfig(source, "https://cdn.example.com/{hash}");
      expect(resolveAvatarUrl(false, config, "a@b.c", "张三")).toBe(DEFAULT_AVATAR_URL);
    }
  });

  it("开启时仍按来源生成（不受开关默认值影响）", () => {
    const config = resolveAvatarConfig("gravatar", "");
    expect(resolveAvatarUrl(true, config, "a@b.c", "x")).toBe(
      "https://gravatar.com/avatar/5d60d4e28066df254d5452f92c910092?s=200&d=identicon"
    );
  });
});

describe("vectors/avatar-v1 — 写入跨键约束", () => {
  it("选择 custom 但模板为空会被拦下", () => {
    expect(validateAvatarSettings({ source: "custom" }, { source: "default", customUrl: "" })).toBe(
      AVATAR_ERRORS.emptyCustom
    );
    expect(validateAvatarSettings({ source: "custom", customUrl: "" })).toBe(
      AVATAR_ERRORS.emptyCustom
    );
  });

  it("同一次请求里同时提交 custom + 模板可以通过", () => {
    expect(
      validateAvatarSettings({ source: "custom", customUrl: "https://cdn.example.com/{hash}" })
    ).toBeNull();
  });

  it("切回 default 并清空模板是允许的", () => {
    expect(
      validateAvatarSettings(
        { source: "default", customUrl: "" },
        { source: "custom", customUrl: "https://cdn.example.com/{hash}" }
      )
    ).toBeNull();
  });

  it("已存 template 时只把来源切到 custom 不需要重复提交模板", () => {
    expect(
      validateAvatarSettings(
        { source: "custom" },
        { source: "default", customUrl: "https://cdn.example.com/{hash}" }
      )
    ).toBeNull();
  });

  it("非法模板即使来源不是 custom 也会被拒绝（避免脏配置落库）", () => {
    expect(validateAvatarSettings({ source: "default", customUrl: "javascript:alert(1)" })).toBe(
      AVATAR_ERRORS.badScheme
    );
  });

  it("非法 avatar_enabled 会被拒绝", () => {
    expect(validateAvatarSettings({ enabled: "yes" })).toBe(AVATAR_ERRORS.badEnabled);
    expect(validateAvatarSettings({ enabled: " FALSE " })).toBeNull();
  });
});
