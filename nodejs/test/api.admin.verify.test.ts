import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import { pruneVerifyRecords, recordVerifyEvent } from "../src/orm/verifyRecordService";
import { api, json, loginToken, useTrustProxy, resetTables, clearSettings } from "./helpers";

/**
 * 认证记录（评论无感验证）管理接口的契约测试：
 *   GET /admin/verify/overview
 *   GET /admin/verify/records
 *
 * 这些用例的作用是**钉住三端（Node / Go / Worker）共用的统计口径**：分桶一律 UTC、
 * 补零到满窗口、passRate / avgDurationMs / *Delta 的边界语义、明细字段的归一化与
 * 筛选规则。口径一旦漂移（例如有人改成按本地时区分桶），这里必须变红，
 * 而不是等到管理面板显示出错误数据才发现。
 *
 * 约定：
 *  - 测试库是每个文件独立的临时库（见 setup.ts）；VerifyRecord 不在
 *    helpers.resetTables() 里，所以本文件在 beforeEach 中自行清空；
 *  - 插入记录时一律显式指定 created_at，便于精确断言分桶与窗口边界。
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const RESET_KEYS = [
  "comment_verify_enabled",
  "comment_verify_difficulty",
  "comment_verify_log_challenge",
  "comment_verify_retention_days",
];

beforeEach(() => {
  useTrustProxy();
  resetTables();
  db.run(sql`DELETE FROM "VerifyRecord"`);
});

afterEach(() => {
  clearSettings(RESET_KEYS);
});

/* ------------------------------------------------------------------ *
 * 助手
 * ------------------------------------------------------------------ */

interface SeedVerifyOptions {
  created_at?: number;
  event?: "challenge" | "pass" | "fail";
  reason?: string | null;
  elapsed_ms?: number | null;
  difficulty?: number | null;
  challenge_id?: string | null;
  post_slug?: string | null;
  ip_address?: string | null;
  country?: string | null;
  network?: string | null;
  asn?: number | null;
}

/** 直接插入一条 VerifyRecord（绕过 service，便于构造任意时间/字段），返回自增 id */
function seedVerify(options: SeedVerifyOptions = {}): number {
  db.run(sql`
    INSERT INTO "VerifyRecord"
      ("created_at","event","reason","elapsed_ms","difficulty","challenge_id","post_slug","ip_address","country","network","asn")
    VALUES
      (${options.created_at ?? Date.now()}, ${options.event ?? "challenge"}, ${options.reason ?? null},
       ${options.elapsed_ms ?? null}, ${options.difficulty ?? null}, ${options.challenge_id ?? null},
       ${options.post_slug ?? null}, ${options.ip_address ?? null}, ${options.country ?? null},
       ${options.network ?? null}, ${options.asn ?? null})
  `);
  const row = db.get(sql`SELECT last_insert_rowid() AS id`) as { id: number };
  return row.id;
}

/** 全部认证记录（按写入顺序，即 id 升序） */
function allVerifyRows(): any[] {
  return db.all(sql`SELECT * FROM "VerifyRecord" ORDER BY "id" ASC`) as any[];
}

/** 某个挑战 id 下的认证记录（按写入顺序） */
function verifyRowsOf(challengeId: string): any[] {
  return db.all(
    sql`SELECT * FROM "VerifyRecord" WHERE "challenge_id" = ${challengeId} ORDER BY "id" ASC`
  ) as any[];
}

/** 认证记录总行数 */
function countVerify(): number {
  return (db.get(sql`SELECT COUNT(*) AS n FROM "VerifyRecord"`) as { n: number }).n;
}

/* 与 verifyRecordService.bucketKey 同口径的本地实现：一律 UTC —— 断言若用了本地
 * 时区，会在非 UTC 机器上（例如 UTC+8）与实现一起错，从而漏掉时区漂移。 */
const pad = (n: number) => String(n).padStart(2, "0");

function utcDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function utcHourKey(ts: number): string {
  return `${utcDayKey(ts)}T${pad(new Date(ts).getUTCHours())}`;
}

function utcMonthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
}

/** 由响应里的 range.from 推出满窗口应该有的分桶键序列 */
function expectedKeys(bucket: string, from: string, length: number): string[] {
  const t0 = Date.parse(from);
  const keys: string[] = [];
  for (let i = 0; i < length; i += 1) {
    if (bucket === "month") keys.push(utcMonthKey(addMonths(t0, i)));
    else if (bucket === "hour") keys.push(utcHourKey(t0 + i * HOUR));
    else keys.push(utcDayKey(t0 + i * DAY));
  }
  return keys;
}

function trendSum(trend: any[], field: string): number {
  return trend.reduce((sum, t) => sum + Number(t[field] ?? 0), 0);
}

/* ------------------------------------------------------------------ *
 * GET /admin/verify/overview
 * ------------------------------------------------------------------ */

describe("GET /admin/verify/overview", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/verify/overview");
    expect(res.status).toBe(401);
    expect((await json(res)).message).toBe("Invalid token");
  });

  it("空库：summary 全 0/null、趋势补零到 30 天、榜单为空", async () => {
    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview", { token }));

    expect(body.code).toBe(200);
    // 响应结构（三端必须逐字段一致）
    expect(Object.keys(body.data).sort()).toEqual([
      "geoSupported",
      "range",
      "summary",
      "topCountries",
      "topNetworks",
      "topReasons",
      "trend",
    ]);
    expect(Object.keys(body.data.range).sort()).toEqual([
      "bucket",
      "days",
      "from",
      "offset",
      "to",
    ]);
    expect(Object.keys(body.data.summary).sort()).toEqual([
      "avgDurationDelta",
      "avgDurationMs",
      "challenges",
      "challengesDelta",
      "failed",
      "failedDelta",
      "passRate",
      "verified",
      "verifiedDelta",
    ]);
    expect(Object.keys(body.data.trend[0]).sort()).toEqual([
      "challenges",
      "date",
      "failed",
      "verified",
    ]);

    expect(body.data.range.days).toBe(30);
    expect(body.data.range.offset).toBe(0);
    expect(body.data.range.bucket).toBe("day");
    // from/to 为 ISO 8601 UTC，且对齐到 UTC 日边界
    expect(body.data.range.from).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(body.data.range.to).toMatch(/^\d{4}-\d{2}-\d{2}T23:59:59\.999Z$/);
    expect(new Date(body.data.range.from).toISOString()).toBe(body.data.range.from);
    expect(Date.parse(body.data.range.to) - Date.parse(body.data.range.from)).toBe(
      30 * DAY - 1
    );

    expect(body.data.summary).toEqual({
      challenges: 0,
      challengesDelta: null,
      verified: 0,
      verifiedDelta: null,
      failed: 0,
      failedDelta: null,
      avgDurationMs: null,
      avgDurationDelta: null,
      passRate: null,
    });

    // 满窗口补零：长度 = 窗口分桶数，键为连续 UTC 日期（时区无关）
    expect(body.data.trend).toHaveLength(30);
    expect(body.data.trend.map((t: any) => t.date)).toEqual(
      expectedKeys("day", body.data.range.from, 30)
    );
    expect(
      body.data.trend.every((t: any) => t.challenges === 0 && t.verified === 0 && t.failed === 0)
    ).toBe(true);

    expect(body.data.geoSupported).toBe(false);
    expect(body.data.topCountries).toEqual([]);
    expect(body.data.topNetworks).toEqual([]);
    expect(body.data.topReasons).toEqual([]);
  });

  it("统计签发/通过/失败数、passRate 与只含 pass 的平均耗时（窗口边界与环比对照）", async () => {
    const now = Date.now();
    seedVerify({
      created_at: now - HOUR,
      event: "challenge",
      difficulty: 1000,
      challenge_id: "c1",
      post_slug: "/posts/a",
      ip_address: "203.0.113.7",
    });
    seedVerify({ created_at: now - HOUR, event: "challenge", difficulty: 1000 });
    seedVerify({ created_at: now, event: "pass", elapsed_ms: 120, difficulty: 1000 });
    seedVerify({ created_at: now, event: "pass", elapsed_ms: 180, difficulty: 1000 });
    seedVerify({ created_at: now, event: "fail", reason: "ip mismatch", elapsed_ms: 50 });
    seedVerify({ created_at: now, event: "fail", reason: "ip mismatch", elapsed_ms: 60 });
    seedVerify({ created_at: now, event: "fail", reason: "bad signature" });
    // 40 天前：不在 days=30 的当前窗口内，但**落在紧邻的上一个窗口**（60~30 天前），
    // 因此只影响 failedDelta 的对照值；100 天前则两个窗口都不算
    seedVerify({ created_at: now - 40 * DAY, event: "fail", reason: "challenge expired" });
    seedVerify({ created_at: now - 100 * DAY, event: "fail", reason: "old reason" });

    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview?days=30", { token }));

    // 当前窗口内：2 签发 / 2 通过 / 3 失败；
    // 上一窗口只有 failed 有对照值（40 天前那条）=> (3-1)/1 = 200%，
    // 其余三项的上一窗口为空 => null（而不是 0 / 100）
    expect(body.data.summary).toEqual({
      challenges: 2,
      challengesDelta: null,
      verified: 2,
      verifiedDelta: null,
      failed: 3,
      failedDelta: 200,
      avgDurationMs: 150, // 只算 pass：(120 + 180) / 2
      avgDurationDelta: null,
      passRate: 40, // 2 / (2 + 3)
    });
    // 窗口外的失败（40 天前 / 100 天前）都不进 topReasons；percent 以窗口内 7 个事件为分母
    expect(body.data.topReasons).toEqual([
      { reason: "ip mismatch", count: 2, percent: 28.6 },
      { reason: "bad signature", count: 1, percent: 14.3 },
    ]);
    expect(trendSum(body.data.trend, "challenges")).toBe(2);
    expect(trendSum(body.data.trend, "verified")).toBe(2);
    expect(trendSum(body.data.trend, "failed")).toBe(3);
  });

  it("passRate 保留一位小数且分母为 0 时为 null；平均耗时四舍五入为整数毫秒", async () => {
    const now = Date.now();
    const token = await loginToken();
    const overview = async () => json(await api("/admin/verify/overview?days=30", { token }));

    // 2 pass（100 / 101）+ 1 fail（elapsed 9999 不得参与平均）
    seedVerify({ created_at: now, event: "pass", elapsed_ms: 100 });
    seedVerify({ created_at: now, event: "pass", elapsed_ms: 101 });
    seedVerify({ created_at: now, event: "fail", reason: "bad signature", elapsed_ms: 9999 });
    let body = await overview();
    expect(body.data.summary.passRate).toBe(66.7); // 2/3 => 66.666... => 66.7
    expect(body.data.summary.avgDurationMs).toBe(101); // 100.5 => 101（四舍五入）

    // 只有失败：通过率为 0（有结果），但没有通过数据 => 平均耗时为 null
    db.run(sql`DELETE FROM "VerifyRecord"`);
    seedVerify({ created_at: now, event: "fail", reason: "bad signature" });
    body = await overview();
    expect(body.data.summary.passRate).toBe(0);
    expect(body.data.summary.avgDurationMs).toBeNull();

    // 只有签发：没有任何已出结果的认证 => 通过率为 null（而不是 0%）
    db.run(sql`DELETE FROM "VerifyRecord"`);
    seedVerify({ created_at: now, event: "challenge" });
    body = await overview();
    expect(body.data.summary.passRate).toBeNull();
    expect(body.data.summary.avgDurationMs).toBeNull();
  });

  it("days=1 按小时分桶（UTC），趋势长度 24", async () => {
    const insertedAt = Date.now();
    seedVerify({ created_at: insertedAt, event: "challenge" });
    seedVerify({ created_at: insertedAt, event: "fail", reason: "bad signature" });

    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview?days=1", { token }));

    expect(body.data.range.days).toBe(1);
    expect(body.data.range.bucket).toBe("hour");
    // 24 小时窗口：对齐到整点，末端为当前小时的最后一毫秒
    expect(body.data.range.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    expect(body.data.range.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:59:59\.999Z$/);

    expect(body.data.trend).toHaveLength(24);
    expect(body.data.trend.map((t: any) => t.date)).toEqual(
      expectedKeys("hour", body.data.range.from, 24)
    );
    expect(
      body.data.trend.every((t: any) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(t.date))
    ).toBe(true);

    // 补零：只有当前小时有数据，其余 23 个桶全 0
    const key = utcHourKey(insertedAt);
    expect(body.data.trend.find((t: any) => t.date === key)).toEqual({
      date: key,
      challenges: 1,
      verified: 0,
      failed: 1,
    });
    expect(
      body.data.trend.filter((t: any) => t.challenges || t.verified || t.failed)
    ).toHaveLength(1);
  });

  it("days=0 / days=all 按最近 12 个月分桶", async () => {
    const now = Date.now();
    const threeMonthsAgo = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth() - 3,
      15,
      12
    );
    seedVerify({ created_at: threeMonthsAgo, event: "challenge" });
    seedVerify({ created_at: threeMonthsAgo, event: "pass", elapsed_ms: 500 });

    const token = await loginToken();
    for (const query of ["days=0", "days=all"]) {
      const body = await json(await api(`/admin/verify/overview?${query}`, { token }));

      expect(body.data.range.days, query).toBe(0);
      expect(body.data.range.bucket, query).toBe("month");
      expect(body.data.range.from, query).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
      expect(body.data.trend, query).toHaveLength(12);
      expect(body.data.trend.map((t: any) => t.date), query).toEqual(
        expectedKeys("month", body.data.range.from, 12)
      );
      expect(body.data.trend.every((t: any) => /^\d{4}-\d{2}$/.test(t.date)), query).toBe(true);

      const key = utcMonthKey(threeMonthsAgo);
      expect(body.data.trend.find((t: any) => t.date === key), query).toEqual({
        date: key,
        challenges: 1,
        verified: 1,
        failed: 0,
      });
      expect(
        body.data.trend.filter((t: any) => t.challenges || t.verified || t.failed),
        query
      ).toHaveLength(1);
    }
  });

  it("days 非法值回退 30、超大值截断到 365；offset 上限 120、非法值回退 0", async () => {
    const token = await loginToken();

    const bogus = await json(await api("/admin/verify/overview?days=abc", { token }));
    expect(bogus.data.range.days).toBe(30);
    expect(bogus.data.range.bucket).toBe("day");
    expect(bogus.data.trend).toHaveLength(30);

    const blank = await json(await api("/admin/verify/overview?days=", { token }));
    expect(blank.data.range.days).toBe(30);
    expect(blank.data.trend).toHaveLength(30);

    // 负数按非法值回退 30（而不是被夹成 0=「全部」，见 doc/api.md 与 Go/Worker）
    const negative = await json(await api("/admin/verify/overview?days=-5", { token }));
    expect(negative.data.range.days).toBe(30);
    expect(negative.data.range.bucket).toBe("day");
    expect(negative.data.trend).toHaveLength(30);

    const huge = await json(await api("/admin/verify/overview?days=999", { token }));
    expect(huge.data.range.days).toBe(365);
    expect(huge.data.range.bucket).toBe("day");
    expect(huge.data.trend).toHaveLength(365);

    const offBogus = await json(await api("/admin/verify/overview?days=7&offset=abc", { token }));
    expect(offBogus.data.range.offset).toBe(0);
    const offNegative = await json(await api("/admin/verify/overview?days=7&offset=-1", { token }));
    expect(offNegative.data.range.offset).toBe(0);
    const offHuge = await json(await api("/admin/verify/overview?days=7&offset=999", { token }));
    expect(offHuge.data.range.offset).toBe(120);

    // offset 平移「整个窗口」：offset=1 的末端正好是 offset=0 的起点前一毫秒
    const base = await json(await api("/admin/verify/overview?days=7&offset=0", { token }));
    const prev = await json(await api("/admin/verify/overview?days=7&offset=1", { token }));
    expect(prev.data.range.offset).toBe(1);
    expect(Date.parse(prev.data.range.to)).toBe(Date.parse(base.data.range.from) - 1);
    expect(prev.data.trend).toHaveLength(7);
  });

  it("环比 Delta 与紧邻的上一个等长窗口比较，offset=1 可查上一窗口", async () => {
    const now = Date.now();
    const dayStart = startOfUtcDay(now);
    // days=7 的当前窗口：[dayStart-6天, dayStart+1天)
    const winStart = dayStart + DAY - 7 * DAY;
    // 取两个窗口各自的中点，避免用例正好跨 UTC 零点时落到边界外
    const cur = winStart + 3 * DAY;
    const prevAt = winStart - 4 * DAY;

    // 当前窗口：5 签发 / 3 通过（均值 200ms）/ 2 失败
    for (let i = 0; i < 5; i += 1) seedVerify({ created_at: cur + i, event: "challenge" });
    for (const ms of [100, 200, 300]) {
      seedVerify({ created_at: cur + 10 + ms, event: "pass", elapsed_ms: ms });
    }
    seedVerify({ created_at: cur, event: "fail", reason: "ip mismatch" });
    seedVerify({ created_at: cur, event: "fail", reason: "bad signature" });
    // 上一窗口：4 签发 / 2 通过（均值 150ms）/ 1 失败
    for (let i = 0; i < 4; i += 1) seedVerify({ created_at: prevAt + i, event: "challenge" });
    seedVerify({ created_at: prevAt + 10, event: "pass", elapsed_ms: 100 });
    seedVerify({ created_at: prevAt + 11, event: "pass", elapsed_ms: 200 });
    seedVerify({ created_at: prevAt + 12, event: "fail", reason: "old reason" });

    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview?days=7", { token }));

    expect(body.data.summary).toEqual({
      challenges: 5,
      challengesDelta: 25, // (5-4)/4
      verified: 3,
      verifiedDelta: 50, // (3-2)/2
      failed: 2,
      failedDelta: 100, // (2-1)/1
      avgDurationMs: 200,
      avgDurationDelta: 33, // (200-150)/150 => 33.33 => 33
      passRate: 60,
    });
    // topReasons 只看当前窗口（"old reason" 属于上一窗口）
    expect(body.data.topReasons).toEqual([
      { reason: "bad signature", count: 1, percent: 10 },
      { reason: "ip mismatch", count: 1, percent: 10 },
    ]);

    // offset=1 就是上一窗口本身：数值与上面手工构造的对照窗口一致
    const previous = await json(await api("/admin/verify/overview?days=7&offset=1", { token }));
    expect(previous.data.summary.challenges).toBe(4);
    expect(previous.data.summary.verified).toBe(2);
    expect(previous.data.summary.failed).toBe(1);
    expect(previous.data.summary.avgDurationMs).toBe(150);
    expect(previous.data.summary.passRate).toBe(66.7);
    expect(previous.data.topReasons).toEqual([
      { reason: "old reason", count: 1, percent: 14.3 }, // 1/(4+2+1)
    ]);
    expect(trendSum(previous.data.trend, "challenges")).toBe(4);
    expect(trendSum(previous.data.trend, "verified")).toBe(2);
    expect(trendSum(previous.data.trend, "failed")).toBe(1);
  });

  it("上一窗口为空时四个 Delta 全为 null", async () => {
    const now = Date.now();
    seedVerify({ created_at: now, event: "challenge" });
    seedVerify({ created_at: now, event: "pass", elapsed_ms: 300 });
    seedVerify({ created_at: now, event: "fail", reason: "ip mismatch" });

    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview?days=30", { token }));

    expect(body.data.summary.challengesDelta).toBeNull();
    expect(body.data.summary.verifiedDelta).toBeNull();
    expect(body.data.summary.failedDelta).toBeNull();
    expect(body.data.summary.avgDurationDelta).toBeNull();
  });

  it("topReasons 取窗口内 fail 的原因，percent 为占窗口内全部事件（含签发）的比例", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) seedVerify({ created_at: now, event: "challenge" });
    for (let i = 0; i < 2; i += 1) seedVerify({ created_at: now, event: "pass", elapsed_ms: 100 });
    for (let i = 0; i < 3; i += 1) seedVerify({ created_at: now, event: "fail", reason: "ip mismatch" });
    for (let i = 0; i < 2; i += 1) seedVerify({ created_at: now, event: "fail", reason: "bad signature" });
    seedVerify({ created_at: now, event: "fail", reason: "challenge expired" });
    // 没有原因（NULL / 空串）的失败不进榜单
    seedVerify({ created_at: now, event: "fail", reason: null });
    seedVerify({ created_at: now, event: "fail", reason: "" });

    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview?days=30", { token }));

    expect(body.data.summary).toMatchObject({ challenges: 5, verified: 2, failed: 8 });
    // 窗口内总事件数 15（5 签发 + 2 通过 + 8 失败）：3/15、2/15、1/15 保留一位小数
    expect(body.data.topReasons).toEqual([
      { reason: "ip mismatch", count: 3, percent: 20 },
      { reason: "bad signature", count: 2, percent: 13.3 },
      { reason: "challenge expired", count: 1, percent: 6.7 },
    ]);
  });

  it("topReasons 最多 5 条，数量相同时按原因升序", async () => {
    const now = Date.now();
    const spec: [string, number][] = [
      ["r1", 6],
      ["r2", 5],
      ["r3", 4],
      ["r4", 3],
      ["z-tie", 2],
      ["a-tie", 2],
    ];
    for (const [reason, count] of spec) {
      for (let i = 0; i < count; i += 1) seedVerify({ created_at: now, event: "fail", reason });
    }

    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview?days=30", { token }));

    expect(body.data.topReasons).toHaveLength(5);
    // 第 5 名是并列 2 次里原因更小的那个
    expect(body.data.topReasons.map((r: any) => r.reason)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "a-tie",
    ]);
    expect(body.data.topReasons.map((r: any) => r.count)).toEqual([6, 5, 4, 3, 2]);
  });

  it("Node 部署 geoSupported=false，地区与运营商榜单恒为空数组", async () => {
    const now = Date.now();
    // 即便表里存在 Worker 才会写入的 country / network / asn，Node 也不该输出榜单
    seedVerify({ created_at: now, event: "pass", country: "US", network: "Comcast", asn: 7922 });
    seedVerify({ created_at: now, event: "challenge", country: "GB", network: "BT", asn: 2856 });

    const token = await loginToken();
    const body = await json(await api("/admin/verify/overview?days=30", { token }));

    expect(body.data.geoSupported).toBe(false);
    expect(body.data.topCountries).toEqual([]);
    expect(body.data.topNetworks).toEqual([]);
    expect(body.data.summary.verified).toBe(1);
    expect(body.data.summary.challenges).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * GET /admin/verify/records
 * ------------------------------------------------------------------ */

describe("GET /admin/verify/records", () => {
  it("缺少 token 返回 401", async () => {
    const res = await api("/admin/verify/records");
    expect(res.status).toBe(401);
    expect((await json(res)).message).toBe("Invalid token");
  });

  it("分页：total / page / pageSize 与 limit-offset 一致，非法值回退、上限 100", async () => {
    const now = Date.now();
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        seedVerify({
          created_at: now - i * 1000,
          event: "challenge",
          ip_address: `203.0.113.${i}`,
        })
      );
    }
    const token = await loginToken();

    // created_at 倒序（同刻再按 id 倒序）
    const page1 = await json(await api("/admin/verify/records?page=1&pageSize=2", { token }));
    expect(page1.data).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(page1.data.list.map((r: any) => r.id)).toEqual([ids[0], ids[1]]);

    const page2 = await json(await api("/admin/verify/records?page=2&pageSize=2", { token }));
    expect(page2.data.list.map((r: any) => r.id)).toEqual([ids[2], ids[3]]);

    const page3 = await json(await api("/admin/verify/records?page=3&pageSize=2", { token }));
    expect(page3.data.list.map((r: any) => r.id)).toEqual([ids[4]]);

    const page4 = await json(await api("/admin/verify/records?page=4&pageSize=2", { token }));
    expect(page4.data.list).toEqual([]);
    expect(page4.data.total).toBe(5);

    const clamped = await json(await api("/admin/verify/records?page=0&pageSize=999", { token }));
    expect(clamped.data.page).toBe(1);
    expect(clamped.data.pageSize).toBe(100);
    expect(clamped.data.list).toHaveLength(5);

    const bogus = await json(await api("/admin/verify/records?page=abc&pageSize=abc", { token }));
    expect(bogus.data.page).toBe(1);
    expect(bogus.data.pageSize).toBe(20);
    expect(bogus.data.list).toHaveLength(5);

    const zeroSize = await json(await api("/admin/verify/records?pageSize=0", { token }));
    expect(zeroSize.data.pageSize).toBe(20);

    // 同一时间戳时按 id 倒序，保证翻页不会重复/漏行
    db.run(sql`DELETE FROM "VerifyRecord"`);
    const sameTs = Date.now();
    const first = seedVerify({ created_at: sameTs, event: "challenge" });
    const second = seedVerify({ created_at: sameTs, event: "challenge" });
    const third = seedVerify({ created_at: sameTs, event: "challenge" });
    const tied = await json(await api("/admin/verify/records?pageSize=10", { token }));
    expect(tied.data.list.map((r: any) => r.id)).toEqual([third, second, first]);
  });

  it("明细字段：createdAt 为 ISO 8601 UTC，空值归一为 \"\" / null", async () => {
    const ts = Date.now() - 3 * HOUR;
    const richId = seedVerify({
      created_at: ts,
      event: "fail",
      reason: "ip mismatch",
      elapsed_ms: 250,
      difficulty: 1048576,
      challenge_id: "cid-rich",
      post_slug: "/posts/rich",
      ip_address: "203.0.113.7",
      country: "US",
      network: "Comcast Cable",
      asn: 7922,
    });
    const bareId = seedVerify({ created_at: ts - 1000, event: "challenge" });

    const token = await loginToken();
    const body = await json(await api("/admin/verify/records", { token }));

    expect(Object.keys(body.data.list[0]).sort()).toEqual([
      "asn",
      "challengeId",
      "country",
      "createdAt",
      "difficulty",
      "elapsedMs",
      "event",
      "id",
      "ipAddress",
      "network",
      "postSlug",
      "reason",
    ]);
    expect(body.data.list).toEqual([
      {
        id: richId,
        createdAt: new Date(ts).toISOString(),
        event: "fail",
        reason: "ip mismatch",
        elapsedMs: 250,
        difficulty: 1048576,
        challengeId: "cid-rich",
        postSlug: "/posts/rich",
        ipAddress: "203.0.113.7",
        country: "US",
        network: "Comcast Cable",
        asn: 7922,
      },
      {
        id: bareId,
        createdAt: new Date(ts - 1000).toISOString(),
        event: "challenge",
        reason: "",
        elapsedMs: null,
        difficulty: null,
        challengeId: "",
        postSlug: "",
        ipAddress: "",
        country: "",
        network: "",
        asn: null,
      },
    ]);
    expect(body.data.list[0].createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  it("event 过滤：all 与空值不过滤，其余精确匹配", async () => {
    const now = Date.now();
    const challengeId = seedVerify({ created_at: now, event: "challenge" });
    const passId = seedVerify({ created_at: now - 1000, event: "pass", elapsed_ms: 500 });
    const failId = seedVerify({ created_at: now - 2000, event: "fail", reason: "bad signature" });

    const token = await loginToken();
    const list = async (query: string) =>
      (await json(await api(`/admin/verify/records${query}`, { token }))).data;

    const noParam = await list("");
    expect(noParam.list.map((r: any) => r.id)).toEqual([challengeId, passId, failId]);

    expect((await list("?event=all")).total).toBe(3);
    expect((await list("?event=")).total).toBe(3);

    const onlyChallenge = await list("?event=challenge");
    expect(onlyChallenge.list.map((r: any) => r.id)).toEqual([challengeId]);

    const onlyPass = await list("?event=pass");
    expect(onlyPass.total).toBe(1);
    expect(onlyPass.list[0].id).toBe(passId);
    expect(onlyPass.list[0].event).toBe("pass");

    const onlyFail = await list("?event=fail");
    expect(onlyFail.list.map((r: any) => r.id)).toEqual([failId]);
    expect(onlyFail.list[0].reason).toBe("bad signature");

    // 未知取值按精确匹配处理 => 无结果（而不是静默退化成不过滤）
    const bogus = await list("?event=bogus");
    expect(bogus.list).toEqual([]);
    expect(bogus.total).toBe(0);
  });

  it("reason / slug 为精确匹配，ip 为前缀匹配且 LIKE 通配符被转义", async () => {
    const now = Date.now();
    const a = seedVerify({
      created_at: now,
      event: "fail",
      reason: "ip mismatch",
      post_slug: "/posts/a",
      ip_address: "203.0.113.7",
    });
    const b = seedVerify({
      created_at: now - 1000,
      event: "fail",
      reason: "ip mismatch extra",
      post_slug: "/posts/ab",
      ip_address: "203.0.113.99",
    });
    seedVerify({
      created_at: now - 2000,
      event: "fail",
      reason: "bad signature",
      post_slug: "/posts/b",
      ip_address: "198.51.100.7",
    });

    const token = await loginToken();
    const list = async (query: string) =>
      (await json(await api(`/admin/verify/records${query}`, { token }))).data;

    // reason：完全相等才算命中，前缀不算
    expect((await list("?reason=ip%20mismatch")).list.map((r: any) => r.id)).toEqual([a]);
    expect((await list("?reason=ip")).total).toBe(0);
    expect((await list("?reason=ip%20mismatch%20extra")).list.map((r: any) => r.id)).toEqual([b]);

    // slug：完全相等才算命中
    expect((await list("?slug=%2Fposts%2Fa")).list.map((r: any) => r.id)).toEqual([a]);
    expect((await list("?slug=%2Fposts")).total).toBe(0);

    // ip：前缀匹配
    expect((await list("?ip=203.0.113.")).list.map((r: any) => r.id)).toEqual([a, b]);
    expect((await list("?ip=203.0.113.9")).list.map((r: any) => r.id)).toEqual([b]);
    expect((await list("?ip=203")).total).toBe(2);
    // '%' 是字面量，不是通配符
    expect((await list("?ip=203.0.113.7%25")).total).toBe(0);

    // 组合筛选
    expect(
      (
        await list(
          "?event=fail&reason=ip%20mismatch&slug=%2Fposts%2Fa&ip=203.0.113."
        )
      ).list.map((r: any) => r.id)
    ).toEqual([a]);
  });

  it("days 窗口：1 天 / 30 天 / 0(all) 全部历史，非法值回退 30", async () => {
    const now = Date.now();
    const newest = seedVerify({ created_at: now, event: "challenge" });
    const twoHours = seedVerify({ created_at: now - 2 * HOUR, event: "pass", elapsed_ms: 100 });
    const thirtyHours = seedVerify({ created_at: now - 30 * HOUR, event: "fail", reason: "ip mismatch" });
    const fortyDays = seedVerify({
      created_at: now - 40 * DAY,
      event: "fail",
      reason: "challenge expired",
    });

    const token = await loginToken();
    const list = async (query: string) =>
      (await json(await api(`/admin/verify/records${query}`, { token }))).data;

    // days=1 是「最近 24 小时」窗口（对齐到整点，最多约 25 小时），30 小时前必在其外
    const oneDay = await list("?days=1");
    expect(oneDay.total).toBe(2);
    expect(oneDay.list.map((r: any) => r.id)).toEqual([newest, twoHours]);

    const thirtyDays = await list("?days=30");
    expect(thirtyDays.total).toBe(3);
    expect(thirtyDays.list.map((r: any) => r.id)).toEqual([newest, twoHours, thirtyHours]);

    const allNumeric = await list("?days=0");
    expect(allNumeric.total).toBe(4);
    expect(allNumeric.list.map((r: any) => r.id)).toEqual([
      newest,
      twoHours,
      thirtyHours,
      fortyDays,
    ]);

    expect((await list("?days=all")).total).toBe(4);

    const bogus = await list("?days=abc");
    expect(bogus.total).toBe(3);

    // 负数按非法值回退 30 天（而不是被夹成 0=「全部历史」）
    const negative = await list("?days=-5");
    expect(negative.total).toBe(3);
    expect(negative.list.map((r: any) => r.id)).toEqual([newest, twoHours, thirtyHours]);
  });

  it("无匹配时返回空列表且 total=0，page/pageSize 原样回显", async () => {
    seedVerify({ created_at: Date.now(), event: "challenge" });

    const token = await loginToken();
    const body = await json(
      await api("/admin/verify/records?slug=%2Fnope&page=2&pageSize=5", { token })
    );

    expect(body.data).toEqual({ list: [], total: 0, page: 2, pageSize: 5 });
  });
});

/* ------------------------------------------------------------------ *
 * 设置项：comment_verify_log_challenge
 * ------------------------------------------------------------------ */

describe("设置项 comment_verify_log_challenge", () => {
  it("默认（未设置）会记录 challenge 事件", async () => {
    await recordVerifyEvent({
      event: "challenge",
      challengeId: "c-default",
      difficulty: 1000,
      postSlug: "/posts/a",
      ip: "203.0.113.7",
    });

    const rows = verifyRowsOf("c-default");
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("challenge");
    expect(rows[0].difficulty).toBe(1000);
    expect(rows[0].post_slug).toBe("/posts/a");
    expect(rows[0].ip_address).toBe("203.0.113.7");
    expect(rows[0].reason).toBeNull();
    expect(rows[0].elapsed_ms).toBeNull();
    expect(Math.abs(Number(rows[0].created_at) - Date.now())).toBeLessThan(5000);
  });

  it("=false 时 recordVerifyEvent({event:'challenge'}) 不写库，pass / fail 仍写入", async () => {
    await setSetting("comment_verify_log_challenge", "false");

    await recordVerifyEvent({
      event: "challenge",
      challengeId: "c-off",
      difficulty: 1000,
      postSlug: "/posts/a",
      ip: "203.0.113.7",
    });
    expect(countVerify()).toBe(0);

    await recordVerifyEvent({
      event: "fail",
      reason: "ip mismatch",
      elapsedMs: 120,
      difficulty: 1000,
      challengeId: "c-off",
      ip: "203.0.113.7",
    });
    await recordVerifyEvent({
      event: "pass",
      elapsedMs: 2000,
      difficulty: 1000,
      challengeId: "c-off",
      ip: "203.0.113.7",
    });

    const rows = verifyRowsOf("c-off");
    expect(rows.map((r) => r.event)).toEqual(["fail", "pass"]);
    expect(rows[0].reason).toBe("ip mismatch");
    expect(rows[0].elapsed_ms).toBe(120);
    expect(rows[1].reason).toBeNull();
    expect(rows[1].elapsed_ms).toBe(2000);
  });

  it("=false 时接口签发挑战也不写入 challenge 记录，失败记录照常写入", async () => {
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_log_challenge", "false");
    const ip = "198.51.100.9";

    const challenge = await api("/api/verify/challenge", {
      method: "POST",
      ip,
      body: { post_slug: "/posts/x" },
    });
    expect(challenge.status).toBe(200);
    expect((await json(challenge)).data.enabled).toBe(true);
    expect(countVerify()).toBe(0);

    // 空 prefix 必然失败 => fail 记录仍然要落库
    const solved = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: { post_slug: "/posts/x", prefix: "", sig: "", nonces: [], elapsed_ms: 1000 },
    });
    expect(solved.status).toBe(403);
    expect((await json(solved)).reason).toBe("missing challenge");

    const rows = allVerifyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("fail");
    expect(rows[0].reason).toBe("missing challenge");
    expect(rows[0].challenge_id).toBeNull();
    expect(rows[0].post_slug).toBe("/posts/x");
    expect(rows[0].ip_address).toBe(ip);
    expect(rows[0].elapsed_ms).toBe(1000);
    expect(rows[0].difficulty).toBe(1000000); // 未配置难度时的默认总期望哈希次数
  });
});

/* ------------------------------------------------------------------ *
 * 过期清理（comment_verify_retention_days）
 * ------------------------------------------------------------------ */

describe("过期清理 pruneVerifyRecords", () => {
  it("默认保留 30 天：超期记录被删除，保留期内记录保留", async () => {
    const now = Date.now();
    const oldId = seedVerify({ created_at: now - 40 * DAY, event: "challenge" });
    const freshId = seedVerify({ created_at: now - HOUR, event: "pass", elapsed_ms: 100 });

    await pruneVerifyRecords();

    const rows = allVerifyRows();
    expect(rows.map((r) => r.id)).toEqual([freshId]);
    expect(rows.some((r) => r.id === oldId)).toBe(false);
  });

  it("comment_verify_retention_days=1 时按 1 天清理", async () => {
    await setSetting("comment_verify_retention_days", "1");
    const now = Date.now();
    seedVerify({ created_at: now - 2 * DAY, event: "challenge" });
    const freshId = seedVerify({ created_at: now - HOUR, event: "challenge" });

    await pruneVerifyRecords();

    expect(allVerifyRows().map((r) => r.id)).toEqual([freshId]);
  });

  it("comment_verify_retention_days=0 表示永久保留", async () => {
    await setSetting("comment_verify_retention_days", "0");
    const oldId = seedVerify({ created_at: Date.now() - 3650 * DAY, event: "challenge" });

    await pruneVerifyRecords();

    expect(allVerifyRows().map((r) => r.id)).toEqual([oldId]);
  });
});
