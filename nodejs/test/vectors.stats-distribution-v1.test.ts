import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DISTRIBUTION_LIMIT,
  mergeDistribution,
  normalizeBrowserFamily,
  normalizeDeviceType,
  normalizeOsFamily,
} from "../src/utils/statsDistribution";

/**
 * 数据统计页客户端分布口径 v1 的跨语言固定向量验收。
 *
 * 三端（Node / Go / Worker）读取同一份 fixture 各自复算：浏览器与操作系统要按
 * 「去掉尾部版本号」得到家族名，设备要归成「桌面 / 移动 / 平板 / 未知」四类。
 * 任何一端改了口径，排行榜就会在同一份数据上给出不同结果。
 */

const FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "doc",
  "vectors",
  "stats-distribution-v1.json"
);
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("vectors/stats-distribution-v1 — 浏览器家族名", () => {
  it.each(fixture.browser as { raw: string | null; expected: string }[])(
    "$raw → $expected",
    ({ raw, expected }) => {
      expect(normalizeBrowserFamily(raw)).toBe(expected);
    }
  );
});

describe("vectors/stats-distribution-v1 — 操作系统家族名", () => {
  it.each(fixture.os as { raw: string | null; expected: string }[])(
    "$raw → $expected",
    ({ raw, expected }) => {
      expect(normalizeOsFamily(raw)).toBe(expected);
    }
  );
});

describe("vectors/stats-distribution-v1 — 设备类型", () => {
  it.each(fixture.device as { raw: string | null; expected: string }[])(
    "$raw → $expected",
    ({ raw, expected }) => {
      expect(normalizeDeviceType(raw)).toBe(expected);
    }
  );

  it("移动关键词优先于桌面关键词（Windows Phone 是手机而不是桌面）", () => {
    expect(normalizeDeviceType("Windows Phone")).toBe("移动");
    // 桌面取值不受影响
    expect(normalizeDeviceType("Windows 10")).toBe("桌面");
  });
});

describe("vectors/stats-distribution-v1 — 合并、排序与截断", () => {
  it("同名家族合并计数", () => {
    const merged = mergeDistribution(
      [
        { name: "Chrome 145.0.0.0", count: 3 },
        { name: "Chrome 144.0.0.0", count: 2 },
        { name: "Edge 147.0.0.0", count: 1 },
      ],
      normalizeBrowserFamily
    );
    expect(merged).toEqual([
      { name: "Chrome", count: 5 },
      { name: "Edge", count: 1 },
    ]);
  });

  it("按数量降序，并列时按名称升序（跨语言稳定）", () => {
    const merged = mergeDistribution(
      [
        { name: "Firefox 121.0", count: 2 },
        { name: "Chrome 145.0.0.0", count: 2 },
        { name: "Edge 147.0.0.0", count: 1 },
      ],
      normalizeBrowserFamily
    );
    expect(merged.map((item) => item.name)).toEqual(["Chrome", "Firefox", "Edge"]);
  });

  it("最多下发 5 档", () => {
    const rows = ["a 1", "b 1", "c 1", "d 1", "e 1", "f 1", "g 1"].map((name) => ({
      name,
      count: 1,
    }));
    const merged = mergeDistribution(rows, normalizeBrowserFamily);
    expect(merged).toHaveLength(DISTRIBUTION_LIMIT);
    expect(DISTRIBUTION_LIMIT).toBe(5);
    // 数量全部并列时按名称升序取前 5 档
    expect(merged.map((item) => item.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("空分布返回空数组而不是 null", () => {
    expect(mergeDistribution([], normalizeBrowserFamily)).toEqual([]);
  });
});
