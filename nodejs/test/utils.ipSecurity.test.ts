import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isIPBlocked,
  recordFailedAttempt,
  recordSuccessfulLogin,
  getFailedAttemptsCount,
} from "../src/utils/ipSecurity";

const MAX_ATTEMPTS = 5;

afterEach(() => {
  vi.useRealTimers();
});

describe("utils/ipSecurity — 失败计数与锁定", () => {
  it("前 4 次失败不封禁，第 5 次达到阈值返回 true", () => {
    const ip = "10.10.0.1";
    for (let i = 1; i <= 4; i++) {
      expect(recordFailedAttempt(ip), `第 ${i} 次`).toBe(false);
      expect(getFailedAttemptsCount(ip)).toBe(i);
      expect(isIPBlocked(ip)).toBe(false);
    }
    expect(recordFailedAttempt(ip)).toBe(true);
    expect(isIPBlocked(ip)).toBe(true);
  });

  it("封禁后失败计数被清零（计数表不保留已封禁 IP）", () => {
    const ip = "10.10.0.2";
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailedAttempt(ip);
    expect(getFailedAttemptsCount(ip)).toBe(0);
  });

  it("封禁期间再次记录失败不会延长封禁（重新从 1 开始计数）", () => {
    const ip = "10.10.0.3";
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailedAttempt(ip);
    expect(isIPBlocked(ip)).toBe(true);
    expect(recordFailedAttempt(ip)).toBe(false);
    expect(getFailedAttemptsCount(ip)).toBe(1);
  });

  it("未记录的 IP 不被封禁，计数为 0", () => {
    expect(isIPBlocked("10.10.0.4")).toBe(false);
    expect(getFailedAttemptsCount("10.10.0.4")).toBe(0);
  });

  it("不同 IP 的计数互相隔离", () => {
    const a = "10.10.0.5";
    const b = "10.10.0.6";
    recordFailedAttempt(a);
    recordFailedAttempt(a);
    recordFailedAttempt(b);
    expect(getFailedAttemptsCount(a)).toBe(2);
    expect(getFailedAttemptsCount(b)).toBe(1);
    expect(isIPBlocked(b)).toBe(false);
  });
});

describe("utils/ipSecurity — 成功登录与重置", () => {
  it("成功后清除失败记录，需重新累计 5 次才会封禁", () => {
    const ip = "10.20.0.1";
    recordFailedAttempt(ip);
    recordFailedAttempt(ip);
    recordFailedAttempt(ip);
    expect(getFailedAttemptsCount(ip)).toBe(3);

    recordSuccessfulLogin(ip);
    expect(getFailedAttemptsCount(ip)).toBe(0);

    for (let i = 1; i <= 4; i++) expect(recordFailedAttempt(ip)).toBe(false);
    expect(recordFailedAttempt(ip)).toBe(true);
  });

  it("没有失败记录时 recordSuccessfulLogin 是安全的空操作", () => {
    expect(() => recordSuccessfulLogin("10.20.0.2")).not.toThrow();
    expect(getFailedAttemptsCount("10.20.0.2")).toBe(0);
  });

  it("recordSuccessfulLogin 清除失败计数但不解除已有封禁", () => {
    const blocked = "10.20.0.4";
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailedAttempt(blocked);
    expect(isIPBlocked(blocked)).toBe(true);

    recordSuccessfulLogin(blocked);
    expect(isIPBlocked(blocked)).toBe(true);
    expect(getFailedAttemptsCount(blocked)).toBe(0);
  });
});

describe("utils/ipSecurity — 封禁有效期", () => {
  it("30 分钟内封禁有效，超过 30 分钟自动解除", () => {
    vi.useFakeTimers();
    const start = new Date("2025-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const ip = "10.30.0.1";
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailedAttempt(ip);
    expect(isIPBlocked(ip)).toBe(true);

    // 边界：正好 30 分钟时仍然封禁（判定为 > 而非 >=）
    vi.setSystemTime(new Date(start.getTime() + 30 * 60 * 1000));
    expect(isIPBlocked(ip)).toBe(true);

    vi.setSystemTime(new Date(start.getTime() + 30 * 60 * 1000 + 1));
    expect(isIPBlocked(ip)).toBe(false);
    // 过期条目已被惰性清理
    expect(isIPBlocked(ip)).toBe(false);
  });

  it("封禁过期后可以重新累计失败次数", () => {
    vi.useFakeTimers();
    const start = new Date("2025-02-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const ip = "10.30.0.2";
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailedAttempt(ip);
    expect(isIPBlocked(ip)).toBe(true);

    vi.setSystemTime(new Date(start.getTime() + 30 * 60 * 1000 + 1));
    expect(isIPBlocked(ip)).toBe(false);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(recordFailedAttempt(ip)).toBe(false);
    expect(recordFailedAttempt(ip)).toBe(true);
  });
});
