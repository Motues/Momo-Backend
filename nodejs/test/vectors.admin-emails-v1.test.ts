import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ADMIN_EMAILS_ERRORS,
  ADMIN_EMAILS_KEY,
  MAX_ADMIN_EMAILS,
  MAX_ADMIN_EMAIL_LENGTH,
  NOTIFY_EMAIL_KEY,
  isAdminEmail,
  isValidEmail,
  normalizeAdminEmails,
  normalizeEmail,
  parseAdminEmails,
  resolveAdminEmails,
  resolveNotifyEmail,
  validateAdminEmails,
  validateNotifyEmail,
} from "../src/utils/adminEmails";

/**
 * 多管理员邮箱契约 v1 的跨语言固定向量验收。
 *
 * 博主特权判定与通知收件人都读同一份口径：任何一端把大小写 / 空白 / 去重
 * 处理得不一样，就会出现「面板里是管理员、评论时不是」。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "admin-emails-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("vectors/admin-emails-v1 — 常量与错误文案", () => {
  it("上限与 fixture 一致", () => {
    expect(MAX_ADMIN_EMAILS).toBe(fixture.limits.maxAdminEmails);
    expect(MAX_ADMIN_EMAIL_LENGTH).toBe(fixture.limits.maxEmailLen);
  });

  it("设置键名固定", () => {
    expect(ADMIN_EMAILS_KEY).toBe("admin_emails");
    expect(NOTIFY_EMAIL_KEY).toBe("notify_email");
  });

  it("六条错误文案与 fixture 逐字一致", () => {
    expect(ADMIN_EMAILS_ERRORS).toEqual(fixture.errors);
  });
});

describe("vectors/admin-emails-v1 — 邮箱判定", () => {
  for (const value of fixture.email.valid) {
    it(`合法：${JSON.stringify(value)}`, () => {
      expect(isValidEmail(value)).toBe(true);
    });
  }
  for (const value of fixture.email.invalid) {
    it(`非法：${JSON.stringify(value)}`, () => {
      expect(isValidEmail(value)).toBe(false);
    });
  }
  it("归一化是 trim + 小写", () => {
    expect(normalizeEmail("  A@B.COM ")).toBe("a@b.com");
  });
});

describe("vectors/admin-emails-v1 — 写 / 读口径", () => {
  for (const item of fixture.parse) {
    it(`宽容解析：${item.name}`, () => {
      expect(parseAdminEmails(item.stored)).toEqual(item.expect);
      // 归一化后往返稳定
      expect(parseAdminEmails(normalizeAdminEmails(item.stored))).toEqual(item.expect);
    });
  }

  for (const item of fixture.resolve) {
    it(`归一化：${item.name}`, () => {
      expect(resolveAdminEmails(item.storedAdmins, item.legacyAdmin)).toEqual(item.expectAdmins);
      expect(resolveNotifyEmail(item.storedNotify, item.storedAdmins, item.legacyAdmin)).toBe(
        item.expectNotify
      );
    });
  }

  it("写入路径严格：非数组 / 非字符串项 / 超上限 / 非法邮箱各自报错", () => {
    expect(validateAdminEmails("oops")).toBe(ADMIN_EMAILS_ERRORS.notArray);
    expect(validateAdminEmails('{"a":1}')).toBe(ADMIN_EMAILS_ERRORS.notArray);
    expect(validateAdminEmails('["a@b.com", 1]')).toBe(ADMIN_EMAILS_ERRORS.notString);
    expect(
      validateAdminEmails(JSON.stringify(Array.from({ length: 11 }, (_, i) => `a${i}@b.com`)))
    ).toBe(ADMIN_EMAILS_ERRORS.tooMany);
    expect(validateAdminEmails('["nope"]')).toBe(ADMIN_EMAILS_ERRORS.badEmail);
    expect(validateAdminEmails("")).toBeNull();
    expect(validateAdminEmails("[]")).toBeNull();
    expect(validateAdminEmails('["  A@B.com ", "a@b.com"]')).toBeNull();
  });

  it("先归一化去重再数个数（三端口径一致）", () => {
    // 同一个地址写 11 遍：去重后只剩 1 个，不该被判成超过 10 个
    expect(validateAdminEmails(JSON.stringify(Array.from({ length: 11 }, () => "A@B.com")))).toBeNull();
    // 非字符串项的优先级高于「超过上限」
    const withNonString = JSON.stringify([
      ...Array.from({ length: 11 }, (_, i) => `a${i}@b.com`),
      1,
    ]);
    expect(validateAdminEmails(withNonString)).toBe(ADMIN_EMAILS_ERRORS.notString);
    // 11 个不同地址（其中一个非法）仍然先报「超过上限」
    const manyDistinct = JSON.stringify([
      ...Array.from({ length: 10 }, (_, i) => `a${i}@b.com`),
      "nope",
    ]);
    expect(validateAdminEmails(manyDistinct)).toBe(ADMIN_EMAILS_ERRORS.tooMany);
  });

  it("写入路径归一化：trim + 小写 + 去重保序", () => {
    expect(normalizeAdminEmails('["  A@X.com ", "b@y.com", "a@x.com"]')).toBe(
      '["a@x.com","b@y.com"]'
    );
    expect(normalizeAdminEmails("oops")).toBe("[]");
  });

  it("notify_email 必须是合法邮箱且命中列表", () => {
    const admins = ["a@x.com", "b@y.com"];
    expect(validateNotifyEmail("", admins)).toBeNull();
    expect(validateNotifyEmail(" ", admins)).toBeNull();
    expect(validateNotifyEmail("b@y.com", admins)).toBeNull();
    expect(validateNotifyEmail("  B@Y.COM  ", admins)).toBeNull();
    expect(validateNotifyEmail("nope", admins)).toBe(ADMIN_EMAILS_ERRORS.badNotify);
    expect(validateNotifyEmail("c@z.com", admins)).toBe(ADMIN_EMAILS_ERRORS.notifyNotInList);
  });

  it("博主判定按 trim + 小写匹配", () => {
    const admins = ["a@x.com", "b@y.com"];
    expect(isAdminEmail("  A@X.com ", admins)).toBe(true);
    expect(isAdminEmail("c@z.com", admins)).toBe(false);
    expect(isAdminEmail("", admins)).toBe(false);
    expect(isAdminEmail("a@x.com", [])).toBe(false);
  });
});
