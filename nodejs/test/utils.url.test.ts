import { describe, it, expect } from "vitest";
import {
  getQueryNumber,
  getQueryClampedNumber,
  getQueryBoolean,
  getQueryString,
} from "../src/utils/url";

describe("utils/url — getQueryNumber", () => {
  it("缺省（undefined）返回默认值", () => {
    expect(getQueryNumber(undefined, 7)).toBe(7);
  });

  it("空字符串返回默认值", () => {
    expect(getQueryNumber("", 7)).toBe(7);
  });

  it("合法整数按 10 进制解析", () => {
    expect(getQueryNumber("42", 1)).toBe(42);
    expect(getQueryNumber("010", 1)).toBe(10);
  });

  it("带尾随字符时取前缀数字（parseInt 语义）", () => {
    expect(getQueryNumber("5abc", 1)).toBe(5);
    expect(getQueryNumber("3.9", 1)).toBe(3);
  });

  it("非数字返回默认值", () => {
    expect(getQueryNumber("abc", 9)).toBe(9);
    expect(getQueryNumber("NaN", 9)).toBe(9);
  });

  it("负数与 0 原样返回（不做 clamp）", () => {
    expect(getQueryNumber("-3", 1)).toBe(-3);
    expect(getQueryNumber("0", 1)).toBe(0);
  });

  it("超大数不返回 NaN", () => {
    const value = getQueryNumber("99999999999999999999", 1);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(1e19);
  });

  it("数组取第一个元素", () => {
    expect(getQueryNumber(["8", "9"], 1)).toBe(8);
    expect(getQueryNumber([], 5)).toBe(5);
  });
});

describe("utils/url — getQueryClampedNumber", () => {
  const MIN = 1;
  const MAX = 50;

  it("小于 min 的取值回退到默认值（0 与负数视为非法）", () => {
    expect(getQueryClampedNumber("0", 20, MIN, MAX)).toBe(20);
    expect(getQueryClampedNumber("-5", 20, MIN, MAX)).toBe(20);
  });

  it("等于 min 时保留", () => {
    expect(getQueryClampedNumber("1", 20, MIN, MAX)).toBe(1);
  });

  it("超过 max 时截断到 max", () => {
    expect(getQueryClampedNumber("51", 20, MIN, MAX)).toBe(MAX);
    expect(getQueryClampedNumber("999999", 20, MIN, MAX)).toBe(MAX);
  });

  it("区间内保持不变", () => {
    expect(getQueryClampedNumber("30", 20, MIN, MAX)).toBe(30);
  });

  it("缺省/非数字/空串回退到默认值", () => {
    expect(getQueryClampedNumber(undefined, 20, MIN, MAX)).toBe(20);
    expect(getQueryClampedNumber("abc", 20, MIN, MAX)).toBe(20);
    expect(getQueryClampedNumber("", 20, MIN, MAX)).toBe(20);
  });

  it("数组同样走 clamp 逻辑", () => {
    expect(getQueryClampedNumber(["100"], 20, MIN, MAX)).toBe(MAX);
    expect(getQueryClampedNumber([], 20, MIN, MAX)).toBe(20);
  });

  it("超大页码不会被截断（MAX_SAFE_INTEGER 作为上限）", () => {
    expect(getQueryClampedNumber("123456789", 1, 1, Number.MAX_SAFE_INTEGER)).toBe(123456789);
  });
});

describe("utils/url — getQueryString", () => {
  it("缺省返回默认值", () => {
    expect(getQueryString(undefined, "fallback")).toBe("fallback");
  });

  it("空串返回空串（而非默认值）", () => {
    expect(getQueryString("", "fallback")).toBe("");
  });

  it("正常取值原样返回", () => {
    expect(getQueryString("/posts/hello", "")).toBe("/posts/hello");
  });

  it("数组取第一个元素；空数组返回空串", () => {
    expect(getQueryString(["a", "b"], "")).toBe("a");
    expect(getQueryString([], "fallback")).toBe("");
  });
});

describe("utils/url — getQueryBoolean", () => {
  it("缺省/空串返回默认值", () => {
    expect(getQueryBoolean(undefined, true)).toBe(true);
    expect(getQueryBoolean(undefined, false)).toBe(false);
    expect(getQueryBoolean("", true)).toBe(true);
  });

  it("仅 'true' 视为真，其余字符串一律为假", () => {
    expect(getQueryBoolean("true", false)).toBe(true);
    expect(getQueryBoolean("false", true)).toBe(false);
    expect(getQueryBoolean("TRUE", true)).toBe(false);
    expect(getQueryBoolean("1", true)).toBe(false);
    expect(getQueryBoolean("yes", true)).toBe(false);
  });

  it("数组取第一个元素", () => {
    expect(getQueryBoolean(["true"], false)).toBe(true);
    expect(getQueryBoolean([], true)).toBe(true);
  });
});
