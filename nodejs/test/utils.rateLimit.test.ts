import { describe, it, expect, vi, afterEach } from "vitest";
import { allowRequest } from "../src/utils/rateLimit";

const WINDOW = 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe("utils/rateLimit — 滑动窗口", () => {
  it("窗口内未超过上限时放行，超过即拒绝", () => {
    const key = "rl-basic";
    expect(allowRequest(key, 3, WINDOW)).toBe(true);
    expect(allowRequest(key, 3, WINDOW)).toBe(true);
    expect(allowRequest(key, 3, WINDOW)).toBe(true);
    expect(allowRequest(key, 3, WINDOW)).toBe(false);
    expect(allowRequest(key, 3, WINDOW)).toBe(false);
  });

  it("limit=1 即 60 秒内只允许一次（评论提交限流语义）", () => {
    const key = "rl-comment";
    expect(allowRequest(key, 1, WINDOW)).toBe(true);
    expect(allowRequest(key, 1, WINDOW)).toBe(false);
  });

  it("不同 key 之间互不影响", () => {
    expect(allowRequest("rl-a", 1, WINDOW)).toBe(true);
    expect(allowRequest("rl-a", 1, WINDOW)).toBe(false);
    expect(allowRequest("rl-b", 1, WINDOW)).toBe(true);
  });

  it("limit=0 或负数时一律拒绝", () => {
    expect(allowRequest("rl-zero", 0, WINDOW)).toBe(false);
    expect(allowRequest("rl-negative", -1, WINDOW)).toBe(false);
  });

  it("窗口滑动后重新放行", () => {
    vi.useFakeTimers();
    const start = new Date("2025-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const key = "rl-window";
    expect(allowRequest(key, 1, WINDOW)).toBe(true);
    expect(allowRequest(key, 1, WINDOW)).toBe(false);

    // 窗口边界：正好等于窗口长度时旧记录已过期
    vi.setSystemTime(new Date(start.getTime() + WINDOW));
    expect(allowRequest(key, 1, WINDOW)).toBe(true);

    vi.setSystemTime(new Date(start.getTime() + 2 * WINDOW + 1));
    expect(allowRequest(key, 1, WINDOW)).toBe(true);
  });

  it("窗口内多次请求按时间逐条过期", () => {
    vi.useFakeTimers();
    const start = new Date("2025-03-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const key = "rl-partial";
    expect(allowRequest(key, 2, WINDOW)).toBe(true); // t=0
    vi.setSystemTime(new Date(start.getTime() + 30_000));
    expect(allowRequest(key, 2, WINDOW)).toBe(true); // t=30s
    expect(allowRequest(key, 2, WINDOW)).toBe(false); // 两次都在窗口内

    vi.setSystemTime(new Date(start.getTime() + WINDOW + 1)); // t=60s+1：第一条过期
    expect(allowRequest(key, 2, WINDOW)).toBe(true);
  });

  it("bucket 数量达到上限后直接放行新 key，避免内存膨胀", () => {
    vi.useRealTimers();
    const MAX_BUCKETS = 10000;
    for (let i = 0; i < MAX_BUCKETS; i++) {
      expect(allowRequest(`rl-mem-${i}`, 1, WINDOW)).toBe(true);
    }
    // 新 key 不进入限流表：连续两次都被放行（内存保护分支）
    expect(allowRequest("rl-mem-overflow", 1, WINDOW)).toBe(true);
    expect(allowRequest("rl-mem-overflow", 1, WINDOW)).toBe(true);
    // 已在表内的 key 依旧受限
    expect(allowRequest("rl-mem-0", 1, WINDOW)).toBe(false);
  });

  it("超过扫描间隔（5 分钟）后清理空 bucket，限流行为不受影响", () => {
    vi.useFakeTimers();
    const start = new Date("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    expect(allowRequest("rl-sweep", 1, WINDOW)).toBe(true);
    expect(allowRequest("rl-sweep", 1, WINDOW)).toBe(false);

    // 前进 6 分钟后触发 sweep 分支
    vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 1000));
    expect(allowRequest("rl-sweep", 1, WINDOW)).toBe(true);
    expect(allowRequest("rl-sweep", 1, WINDOW)).toBe(false);
    expect(allowRequest("rl-sweep-2", 1, WINDOW)).toBe(true);
  });
});
