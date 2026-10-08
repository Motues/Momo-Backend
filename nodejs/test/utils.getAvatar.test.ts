import { describe, it, expect } from "vitest";
import { getAvatar } from "../src/utils/getAvatar";

/** md5("test@example.com") */
const MD5_TEST = "55502f40dc8b7c769880b10874abc9d0";
/** md5("") */
const MD5_EMPTY = "d41d8cd98f00b204e9800998ecf8427e";

const cravatar = (hash: string) =>
  `https://open.motues.top/avatar?name=${hash}&mode=cravatar&variant=beam`;

describe("utils/getAvatar", () => {
  it("按小写去空格后的邮箱 MD5 生成头像地址", async () => {
    expect(await getAvatar("张三", "test@example.com")).toBe(cravatar(MD5_TEST));
  });

  it("邮箱先 toLowerCase + trim，大小写与空格不影响结果", async () => {
    const a = await getAvatar("张三", "  Test@Example.COM  ");
    const b = await getAvatar("张三", "test@example.com");
    expect(a).toBe(b);
    expect(a).toBe(cravatar(MD5_TEST));
  });

  it("author 不参与计算，只影响调用方", async () => {
    expect(await getAvatar("A", "test@example.com")).toBe(
      await getAvatar("B", "test@example.com")
    );
  });

  it("邮箱为空时回退到 md5(\"\")，仍返回可用地址", async () => {
    expect(await getAvatar("匿名", "")).toBe(cravatar(MD5_EMPTY));
  });

  it("非法邮箱不做格式校验，直接哈希整个字符串", async () => {
    const url = await getAvatar("x", "not-an-email");
    expect(url).toMatch(/^https:\/\/open\.motues\.top\/avatar\?name=[0-9a-f]{32}&mode=cravatar&variant=beam$/);
  });

  it("QQ 邮箱当前不会走 QQ 头像分支（代码里已注释）", async () => {
    const url = await getAvatar("q", "10000@qq.com");
    expect(url).toContain("open.motues.top/avatar?");
    expect(url).not.toContain("qlogo.cn");
  });

  it("返回值永远不是 undefined", async () => {
    expect(await getAvatar("", "")).toBeTypeOf("string");
  });
});
