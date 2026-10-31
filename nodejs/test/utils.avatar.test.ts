import { describe, it, expect } from "vitest";
import { buildAvatarUrl, resolveAvatarConfig } from "../src/utils/avatar";

/** md5("test@example.com") */
const MD5_TEST = "55502f40dc8b7c769880b10874abc9d0";
/** md5("") */
const MD5_EMPTY = "d41d8cd98f00b204e9800998ecf8427e";

const cravatar = (hash: string) =>
  `https://open.motues.top/avatar?name=${hash}&mode=cravatar&variant=beam`;

/** 默认源（历史行为）：整页评论复用同一份解析后的配置 */
const DEFAULT_CONFIG = resolveAvatarConfig(null, null);

describe("utils/avatar — buildAvatarUrl（默认源，保持历史行为）", () => {
  it("按小写去空格后的邮箱 MD5 生成头像地址", () => {
    expect(buildAvatarUrl(DEFAULT_CONFIG, "test@example.com", "张三")).toBe(cravatar(MD5_TEST));
  });

  it("邮箱先 toLowerCase + trim，大小写与空格不影响结果", () => {
    const a = buildAvatarUrl(DEFAULT_CONFIG, "  Test@Example.COM  ", "张三");
    const b = buildAvatarUrl(DEFAULT_CONFIG, "test@example.com", "张三");
    expect(a).toBe(b);
    expect(a).toBe(cravatar(MD5_TEST));
  });

  it("默认模板不含 {author}，昵称不影响结果", () => {
    expect(buildAvatarUrl(DEFAULT_CONFIG, "test@example.com", "A")).toBe(
      buildAvatarUrl(DEFAULT_CONFIG, "test@example.com", "B")
    );
  });

  it("邮箱为空时回退到 md5(\"\")，仍返回可用地址", () => {
    expect(buildAvatarUrl(DEFAULT_CONFIG, "", "匿名")).toBe(cravatar(MD5_EMPTY));
  });

  it("非法邮箱不做格式校验，直接哈希整个字符串", () => {
    const url = buildAvatarUrl(DEFAULT_CONFIG, "not-an-email", "x");
    expect(url).toMatch(/^https:\/\/open\.motues\.top\/avatar\?name=[0-9a-f]{32}&mode=cravatar&variant=beam$/);
  });

  it("默认源下 QQ 邮箱不会走 QQ 头像分支", () => {
    const url = buildAvatarUrl(DEFAULT_CONFIG, "10000@qq.com", "q");
    expect(url).toContain("open.motues.top/avatar?");
    expect(url).not.toContain("qlogo.cn");
  });

  it("返回值永远不是 undefined", () => {
    expect(buildAvatarUrl(DEFAULT_CONFIG, "", "")).toBeTypeOf("string");
  });
});

describe("utils/avatar — buildAvatarUrl（自定义来源）", () => {
  it("gravatar 预设", () => {
    const url = buildAvatarUrl(resolveAvatarConfig("gravatar", ""), "test@example.com", "x");
    expect(url).toBe(
      "https://gravatar.com/avatar/55502f40dc8b7c769880b10874abc9d0?s=200&d=identicon"
    );
  });

  it("qq 预设：QQ 邮箱使用 qlogo 地址", () => {
    const url = buildAvatarUrl(resolveAvatarConfig("qq", ""), "12345@qq.com", "x");
    expect(url).toBe("https://q1.qlogo.cn/g?b=qq&nk=12345&s=100");
  });

  it("qq 预设：非 QQ 邮箱回落默认源", () => {
    const url = buildAvatarUrl(resolveAvatarConfig("qq", ""), "a@b.c", "x");
    expect(url).toContain("open.motues.top/avatar?");
  });

  it("自定义模板支持 {author} 与 percent-encode", () => {
    const config = resolveAvatarConfig(
      "custom",
      "https://cdn.example.com/{hash}/{author}?mail={email}"
    );
    const url = buildAvatarUrl(config, "a+b@example.com", "张 三");
    expect(url).toBe(
      "https://cdn.example.com/4709dfd443b6cca9b5a01b3324124203/%E5%BC%A0%20%E4%B8%89?mail=a%2Bb%40example.com"
    );
  });

  it("非法自定义模板在读取时回落默认源", () => {
    const url = buildAvatarUrl(
      resolveAvatarConfig("custom", "javascript:alert(1)"),
      "test@example.com",
      "x"
    );
    expect(url).toBe(cravatar(MD5_TEST));
  });
});
