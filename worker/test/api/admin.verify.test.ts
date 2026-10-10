/**
 * GET /admin/verify/overview 与 GET /admin/verify/records —— 认证记录统计与明细。
 *
 * 这些用例是三端（Node / Go / Worker）统计口径漂移的护栏：断言的是具体数值
 * （通过率、环比、百分比、分桶键、字段形状），而不是「状态码 200」。
 *
 * 时间约定：所有窗口都按 UTC 对齐（src/utils/verifyRecord.ts 里的 strftime(..., 'unixepoch')），
 * 因此这里用 `startOfUtcDay` / `startOfUtcHour` 复算窗口边界，不依赖本地时区。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { adminToken, api, bearer } from '../helpers/http';
import {
	allVerifyRecords,
	countVerifyRecords,
	createSchema,
	seedSettings,
	seedVerifyRecord,
	tableExists,
	testEnv,
} from '../helpers/db';
import { extractCfGeo, pruneVerifyRecords } from '../../src/utils/verifyRecord';
import type { Bindings } from '../../src/bindings';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801';
const VERIFY_IP = '203.0.113.200';
const VERIFY_SLUG = '/posts/admin-verify';

const env = testEnv as unknown as Bindings;

let token: string;

beforeEach(async () => {
	await createSchema();
	token = await adminToken();
});

const authed = () => bearer(token);

/* ------------------------------ 窗口辅助函数 ------------------------------ */

function startOfUtcDay(ts: number): number {
	const d = new Date(ts);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfUtcHour(ts: number): number {
	const d = new Date(ts);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
}

/** 与 bucketKey 相同口径的分桶键 */
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const utcHour = (ts: number) => new Date(ts).toISOString().slice(0, 13);
const utcMonth = (ts: number) => new Date(ts).toISOString().slice(0, 7);

/**
 * 第 daysAgo 天的 UTC 正午。
 *
 * days=30 的日窗口是 [今天 00:00 - 29 天, 明天 00:00)，所以 daysAgo ∈ [0,29] 在窗口内、
 * daysAgo ≥ 30 落在上一个窗口里 —— 正好用来构造环比数据。
 */
function inWindow(daysAgo: number): number {
	return startOfUtcDay(Date.now()) - daysAgo * DAY_MS + 12 * HOUR_MS;
}

/* -------------------------------- 请求辅助 -------------------------------- */

async function overview(query = ''): Promise<any> {
	const res = await api(`/admin/verify/overview${query}`, { headers: authed() });
	expect(res.status).toBe(200);
	expect(res.body.code).toBe(200);
	expect(res.body.message).toBe('Verify stats fetched successfully');
	return res.body.data;
}

async function records(query = ''): Promise<any> {
	const res = await api(`/admin/verify/records${query}`, { headers: authed() });
	expect(res.status).toBe(200);
	expect(res.body.code).toBe(200);
	expect(res.body.message).toBe('Verify records fetched successfully');
	return res.body.data;
}

/* ================================== 鉴权 ================================== */

describe('GET /admin/verify/* —— 鉴权', () => {
	it('未带 token 时两个接口都返回 401', async () => {
		for (const path of ['/admin/verify/overview', '/admin/verify/records']) {
			const res = await api(path);
			expect(res.status).toBe(401);
			expect(res.body).toEqual({ code: 401, message: 'Unauthorized' });
		}
	});

	it('无效 token 返回 401，且不泄露任何统计内容', async () => {
		const res = await api('/admin/verify/overview', { headers: bearer('not-a-real-token') });
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ code: 401, message: 'Token expired or invalid' });
		expect(res.body.data).toBeUndefined();
	});
});

/* =========================== overview —— summary =========================== */

describe('GET /admin/verify/overview —— summary', () => {
	it('只统计窗口内记录：passRate 以 pass+fail 为分母，avgDurationMs 只看 pass', async () => {
		await seedVerifyRecord({ created_at: inWindow(0), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(1), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(2), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(3), event: 'pass', elapsed_ms: 100 });
		await seedVerifyRecord({ created_at: inWindow(4), event: 'pass', elapsed_ms: 300 });
		// 失败行的耗时不得参与 avgDurationMs（99999 会让它明显偏掉）
		await seedVerifyRecord({ created_at: inWindow(5), event: 'fail', reason: 'ip mismatch', elapsed_ms: 99999 });
		// 上一窗口之前（第 60 天起）：既不入 summary / 环比，也不入趋势
		await seedVerifyRecord({ created_at: inWindow(60), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(61), event: 'pass', elapsed_ms: 5 });

		const data = await overview('?days=30');
		expect(data.summary).toEqual({
			challenges: 3,
			challengesDelta: null,
			verified: 2,
			verifiedDelta: null,
			failed: 1,
			failedDelta: null,
			avgDurationMs: 200,
			avgDurationDelta: null,
			// 2 / (2 + 1) * 100，一位小数
			passRate: 66.7,
		});
	});

	it('没有任何 pass/fail 时 passRate 与 avgDurationMs 为 null（分母为 0）', async () => {
		await seedVerifyRecord({ created_at: inWindow(0), event: 'challenge' });
		const data = await overview('?days=30');
		expect(data.summary.challenges).toBe(1);
		expect(data.summary.verified).toBe(0);
		expect(data.summary.failed).toBe(0);
		expect(data.summary.passRate).toBeNull();
		expect(data.summary.avgDurationMs).toBeNull();
	});

	it('全部失败时 passRate 为 0（分母非 0，不是 null）', async () => {
		await seedVerifyRecord({ created_at: inWindow(0), event: 'fail', reason: 'bad signature' });
		const data = await overview('?days=30');
		expect(data.summary.passRate).toBe(0);
		expect(data.summary.failed).toBe(1);
	});

	it('passRate 保留一位小数（四舍五入）', async () => {
		// 3 通过 / 7 失败 → 30.0（签发事件不参与分母）
		for (let i = 0; i < 3; i += 1) {
			await seedVerifyRecord({ created_at: inWindow(0), event: 'pass', elapsed_ms: 10 });
		}
		for (let i = 0; i < 7; i += 1) {
			await seedVerifyRecord({ created_at: inWindow(1), event: 'fail', reason: 'bad signature' });
		}
		expect((await overview('?days=30')).summary.passRate).toBe(30);

		// 再补一条失败 → 3/11 = 27.272… → 27.3
		await seedVerifyRecord({ created_at: inWindow(2), event: 'fail', reason: 'bad signature' });
		expect((await overview('?days=30')).summary.passRate).toBe(27.3);
	});

	it('*Delta 与上一个等长窗口比较；上一窗口为空时为 null', async () => {
		// 上一个 30 天窗口（30~59 天前）：2 次签发、1 次通过（耗时 100）
		await seedVerifyRecord({ created_at: inWindow(35), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(36), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(37), event: 'pass', elapsed_ms: 100 });
		// 当前窗口：3 次签发、2 次通过（100 / 300 → 均值 200）、1 次失败
		await seedVerifyRecord({ created_at: inWindow(0), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(1), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(2), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(3), event: 'pass', elapsed_ms: 100 });
		await seedVerifyRecord({ created_at: inWindow(4), event: 'pass', elapsed_ms: 300 });
		await seedVerifyRecord({ created_at: inWindow(5), event: 'fail', reason: 'ip mismatch' });

		const data = await overview('?days=30');
		expect(data.summary.challenges).toBe(3);
		expect(data.summary.challengesDelta).toBe(50); // (3 - 2) / 2
		expect(data.summary.verified).toBe(2);
		expect(data.summary.verifiedDelta).toBe(100); // (2 - 1) / 1
		expect(data.summary.failed).toBe(1);
		expect(data.summary.failedDelta).toBeNull(); // 上一窗口 failed = 0 → null，不是 100%
		expect(data.summary.avgDurationMs).toBe(200);
		expect(data.summary.avgDurationDelta).toBe(100); // (200 - 100) / 100
	});

	it('环比可以为负（在当前窗口数据更少时）', async () => {
		for (let i = 0; i < 4; i += 1) {
			await seedVerifyRecord({ created_at: inWindow(40 + i), event: 'challenge' });
		}
		await seedVerifyRecord({ created_at: inWindow(0), event: 'challenge' });

		const data = await overview('?days=30');
		expect(data.summary.challenges).toBe(1);
		expect(data.summary.challengesDelta).toBe(-75); // (1 - 4) / 4
	});
});

/* ============================ overview —— trend ============================ */

describe('GET /admin/verify/overview —— trend', () => {
	it('days=30 按天分桶：UTC 日期键、补零到 30 个桶、最后一个是今天', async () => {
		await seedVerifyRecord({ created_at: inWindow(0), event: 'challenge' });
		await seedVerifyRecord({ created_at: inWindow(0), event: 'pass', elapsed_ms: 100 });
		await seedVerifyRecord({ created_at: inWindow(3), event: 'fail', reason: 'bad signature' });

		const data = await overview('?days=30');
		expect(data.range.bucket).toBe('day');
		expect(data.trend).toHaveLength(30);
		expect(data.trend.every((b: any) => /^\d{4}-\d{2}-\d{2}$/.test(b.date))).toBe(true);

		expect(data.trend.at(-1)).toEqual({
			date: utcDay(Date.now()),
			challenges: 1,
			verified: 1,
			failed: 0,
		});
		const older = utcDay(inWindow(3));
		expect(data.trend.find((b: any) => b.date === older)).toEqual({
			date: older,
			challenges: 0,
			verified: 0,
			failed: 1,
		});

		// 补零：没有数据的分桶仍然存在且全为 0
		const zeroBuckets = data.trend.filter(
			(b: any) => b.challenges === 0 && b.verified === 0 && b.failed === 0
		);
		expect(zeroBuckets).toHaveLength(28);

		// 趋势与 summary 口径一致（同一窗口、同一事件分类）
		const sum = (key: string) => data.trend.reduce((acc: number, b: any) => acc + b[key], 0);
		expect(sum('challenges')).toBe(data.summary.challenges);
		expect(sum('verified')).toBe(data.summary.verified);
		expect(sum('failed')).toBe(data.summary.failed);

		// 窗口外的记录既不在趋势里，也不在合计里
		expect(data.trend.map((b: any) => b.date)).not.toContain(utcDay(inWindow(60)));
	});

	it('days=1 按小时分桶：键 2026-04-27T14，补零到 24 个桶', async () => {
		await seedVerifyRecord({ created_at: Date.now(), event: 'challenge' });
		await seedVerifyRecord({ created_at: Date.now(), event: 'pass', elapsed_ms: 42 });

		const data = await overview('?days=1');
		expect(data.range.days).toBe(1);
		expect(data.range.bucket).toBe('hour');
		expect(data.trend).toHaveLength(24);
		expect(data.trend.every((b: any) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(b.date))).toBe(true);
		expect(data.trend.at(-1)).toEqual({
			date: utcHour(Date.now()),
			challenges: 1,
			verified: 1,
			failed: 0,
		});
		expect(data.trend.at(-1).date).toBe(utcHour(startOfUtcHour(Date.now())));
	});

	it('days=0 / all 按月分桶最近 12 个月：键 2026-04', async () => {
		await seedVerifyRecord({ created_at: Date.now(), event: 'pass', elapsed_ms: 10 });

		for (const query of ['?days=0', '?days=all', '?days=ALL']) {
			const data = await overview(query);
			expect(data.range.days).toBe(0);
			expect(data.range.bucket).toBe('month');
			expect(data.trend).toHaveLength(12);
			expect(data.trend.every((b: any) => /^\d{4}-\d{2}$/.test(b.date))).toBe(true);
			expect(data.trend.at(-1)).toEqual({
				date: utcMonth(Date.now()),
				challenges: 0,
				verified: 1,
				failed: 0,
			});
		}
	});

	it('按月聚合时超过 12 个月的历史记录被排除', async () => {
		await seedVerifyRecord({ created_at: Date.now() - 400 * DAY_MS, event: 'challenge' });
		const data = await overview('?days=all');
		expect(data.summary.challenges).toBe(0);
		expect(data.trend.every((b: any) => b.challenges === 0)).toBe(true);
	});
});

/* ====================== overview —— days / offset 参数 ====================== */

describe('GET /admin/verify/overview —— days / offset 参数', () => {
	it('缺省与非法 days（非数字、负数、空值）回落到 30 天（按天分桶）', async () => {
		for (const query of ['', '?days=abc', '?days=', '?days=-5', '?days=-1', '?days=%2D5']) {
			const data = await overview(query);
			expect({ query, days: data.range.days, bucket: data.range.bucket }).toEqual({
				query,
				days: 30,
				bucket: 'day',
			});
			expect(data.trend).toHaveLength(30);
		}
	});

	it('days 上限 365；days=0 表示「全部历史」（近 12 个月按月）', async () => {
		const capped = await overview('?days=999');
		expect(capped.range.days).toBe(365);
		expect(capped.range.bucket).toBe('day');
		expect(capped.trend).toHaveLength(365);

		const all = await overview('?days=0');
		expect(all.range.days).toBe(0);
		expect(all.range.bucket).toBe('month');
		expect(all.trend).toHaveLength(12);
	});

	it('小数 days 按 parseInt 语义截断', async () => {
		expect((await overview('?days=30.9')).range.days).toBe(30);
		expect((await overview('?days=1.9')).range.bucket).toBe('hour');
	});

	it('offset 表示窗口向前平移的整窗个数；非法值回落到 0，上限 120', async () => {
		// 第 35 天落在上一个 30 天窗口里
		await seedVerifyRecord({ created_at: inWindow(35), event: 'challenge' });

		const current = await overview('?days=30&offset=0');
		expect(current.range.offset).toBe(0);
		expect(current.summary.challenges).toBe(0);

		const previous = await overview('?days=30&offset=1');
		expect(previous.range.offset).toBe(1);
		expect(previous.summary.challenges).toBe(1);
		expect(previous.trend).toHaveLength(30);
		expect(Date.parse(previous.range.to)).toBeLessThan(Date.parse(current.range.to));

		for (const query of ['?days=30&offset=abc', '?days=30&offset=-3']) {
			expect((await overview(query)).range.offset).toBe(0);
		}
		expect((await overview('?days=30&offset=999')).range.offset).toBe(120);
	});

	it('range.from / to 对齐到 UTC 边界，跨度等于窗口长度 - 1ms', async () => {
		const daily = await overview('?days=30');
		expect(daily.range.from).toMatch(/T00:00:00\.000Z$/);
		expect(daily.range.to).toMatch(/T23:59:59\.999Z$/);
		expect(Date.parse(daily.range.to) - Date.parse(daily.range.from)).toBe(30 * DAY_MS - 1);

		const hourly = await overview('?days=1');
		expect(hourly.range.from).toMatch(/T\d{2}:00:00\.000Z$/);
		expect(hourly.range.to).toMatch(/T\d{2}:59:59\.999Z$/);
		expect(Date.parse(hourly.range.to) - Date.parse(hourly.range.from)).toBe(24 * HOUR_MS - 1);

		const monthly = await overview('?days=all');
		expect(monthly.range.from).toMatch(/T00:00:00\.000Z$/);
		expect(monthly.range.to).toMatch(/T23:59:59\.999Z$/);
	});
});

/* ========================== overview —— 地域榜单 ========================== */

describe('GET /admin/verify/overview —— 地域 / 运营商 / 失败原因榜单', () => {
	it('无数据时 geoSupported 仍为 true，三个榜单是空数组而不是缺失字段', async () => {
		const data = await overview('?days=30');
		expect(data.geoSupported).toBe(true);
		expect(data.topCountries).toEqual([]);
		expect(data.topNetworks).toEqual([]);
		expect(data.topReasons).toEqual([]);
	});

	it('取不到 cf 地域时（country / network 为 null）榜单为空但 geoSupported 不变', async () => {
		await seedVerifyRecord({ created_at: inWindow(0), event: 'pass', elapsed_ms: 10 });
		expect(await allVerifyRecords()).toHaveLength(1);

		const data = await overview('?days=30');
		expect(data.summary.verified).toBe(1);
		expect(data.geoSupported).toBe(true);
		expect(data.topCountries).toEqual([]);
		expect(data.topNetworks).toEqual([]);
	});

	it('topCountries 按次数倒序、同次数按名称升序，percent 以窗口内全部记录为分母', async () => {
		const countries = ['US', 'US', 'US', 'JP', 'JP', 'DE', 'DE'];
		for (const [i, country] of countries.entries()) {
			await seedVerifyRecord({ created_at: inWindow(i), event: 'challenge', country });
		}

		const data = await overview('?days=30');
		expect(data.topCountries).toEqual([
			{ name: 'US', count: 3, percent: 42.9 },
			{ name: 'DE', count: 2, percent: 28.6 },
			{ name: 'JP', count: 2, percent: 28.6 },
		]);
	});

	it('country 为 null / 空串的记录不进榜单，但仍计入 percent 分母', async () => {
		await seedVerifyRecord({ created_at: inWindow(0), event: 'challenge', country: 'US' });
		await seedVerifyRecord({ created_at: inWindow(1), event: 'challenge', country: '' });
		await seedVerifyRecord({ created_at: inWindow(2), event: 'challenge', country: null });
		await seedVerifyRecord({ created_at: inWindow(3), event: 'pass', elapsed_ms: 10 });

		const data = await overview('?days=30');
		expect(data.summary.challenges).toBe(3);
		expect(data.topCountries).toEqual([{ name: 'US', count: 1, percent: 25 }]);
	});

	it('topNetworks 带 asn（同一网络取 MAX(asn)），缺少 asn 时为 null', async () => {
		const seeds = [
			{ network: 'Cloudflare, Inc.', asn: 13335 },
			{ network: 'Cloudflare, Inc.', asn: 13335 },
			{ network: 'Cloudflare, Inc.', asn: 13335 },
			{ network: 'Comcast Cable', asn: 7922 },
			{ network: 'Comcast Cable', asn: 7922 },
			{ network: 'No-ASN Net', asn: null },
		];
		for (const [i, seed] of seeds.entries()) {
			await seedVerifyRecord({ created_at: inWindow(i), event: 'challenge', ...seed });
		}

		const data = await overview('?days=30');
		expect(data.topNetworks).toEqual([
			{ name: 'Cloudflare, Inc.', asn: 13335, count: 3, percent: 50 },
			{ name: 'Comcast Cable', asn: 7922, count: 2, percent: 33.3 },
			{ name: 'No-ASN Net', asn: null, count: 1, percent: 16.7 },
		]);
	});

	it('topReasons 只统计 event=fail 且 reason 非空的行', async () => {
		await seedVerifyRecord({ created_at: inWindow(0), event: 'fail', reason: 'ip mismatch' });
		await seedVerifyRecord({ created_at: inWindow(1), event: 'fail', reason: 'ip mismatch' });
		await seedVerifyRecord({ created_at: inWindow(2), event: 'fail', reason: 'bad signature' });
		// 非 fail 事件即使带 reason 也不计入
		await seedVerifyRecord({ created_at: inWindow(3), event: 'challenge', reason: 'ip mismatch' });
		// 空 / null reason 不计入
		await seedVerifyRecord({ created_at: inWindow(4), event: 'fail', reason: '' });
		await seedVerifyRecord({ created_at: inWindow(5), event: 'fail', reason: null });

		const data = await overview('?days=30');
		expect(data.summary.failed).toBe(5);
		// 分母是窗口内全部 6 条记录
		expect(data.topReasons).toEqual([
			{ reason: 'ip mismatch', count: 2, percent: 33.3 },
			{ reason: 'bad signature', count: 1, percent: 16.7 },
		]);
	});

	it('三个榜单各自最多返回 5 条', async () => {
		for (let i = 0; i < 6; i += 1) {
			for (let n = 0; n < 6 - i; n += 1) {
				await seedVerifyRecord({
					created_at: inWindow(i),
					event: 'fail',
					reason: `reason-${i}`,
					country: `C${i}`,
					network: `N${i}`,
					asn: 1000 + i,
				});
			}
		}

		const data = await overview('?days=30');
		expect(data.topReasons).toHaveLength(5);
		expect(data.topReasons.map((r: any) => r.reason)).toEqual([
			'reason-0',
			'reason-1',
			'reason-2',
			'reason-3',
			'reason-4',
		]);
		expect(data.topCountries).toHaveLength(5);
		expect(data.topNetworks).toHaveLength(5);
		expect(data.topCountries.map((c: any) => c.name)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4']);
		expect(data.topNetworks.map((n: any) => n.name)).toEqual(['N0', 'N1', 'N2', 'N3', 'N4']);
	});
});

/* ========================== records —— 分页与排序 ========================== */

describe('GET /admin/verify/records —— 分页与排序', () => {
	it('默认 page=1 / pageSize=20 / days=30', async () => {
		await seedVerifyRecord({ created_at: Date.now(), event: 'challenge' });
		await seedVerifyRecord({ created_at: Date.now() - 40 * DAY_MS, event: 'challenge' });

		const data = await records();
		expect(data.page).toBe(1);
		expect(data.pageSize).toBe(20);
		expect(data.total).toBe(1);
		expect(data.list).toHaveLength(1);
	});

	it('createdAt 是 ISO 8601 UTC（毫秒 + Z）', async () => {
		const now = Date.now();
		await seedVerifyRecord({ created_at: now, event: 'challenge' });

		const data = await records();
		expect(data.list[0].createdAt).toBe(new Date(now).toISOString());
		expect(data.list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it('按 created_at DESC, id DESC 排序并支持翻页', async () => {
		const base = Date.now() - 2 * DAY_MS;
		const ids = [
			await seedVerifyRecord({ created_at: base, event: 'challenge' }),
			await seedVerifyRecord({ created_at: base + 1000, event: 'fail', reason: 'bad signature' }),
			await seedVerifyRecord({ created_at: base + 2000, event: 'pass', elapsed_ms: 100 }),
			await seedVerifyRecord({ created_at: base + 2000, event: 'challenge' }),
		];

		const first = await records('?pageSize=3&page=1');
		expect(first.total).toBe(4);
		expect(first.page).toBe(1);
		expect(first.pageSize).toBe(3);
		// 同一毫秒内 id 大的排前面
		expect(first.list.map((r: any) => r.id)).toEqual([ids[3], ids[2], ids[1]]);
		expect(first.list[0].createdAt).toBe(new Date(base + 2000).toISOString());

		const second = await records('?pageSize=3&page=2');
		expect(second.page).toBe(2);
		expect(second.total).toBe(4);
		expect(second.list.map((r: any) => r.id)).toEqual([ids[0]]);
	});

	it('page / pageSize 非法值回退，pageSize 上限 100', async () => {
		for (const query of ['?page=abc&pageSize=abc', '?page=0&pageSize=0', '?page=-1&pageSize=-5']) {
			const data = await records(query);
			expect(data.page).toBe(1);
			expect(data.pageSize).toBe(20);
		}
		expect((await records('?pageSize=100')).pageSize).toBe(100);
		expect((await records('?pageSize=999')).pageSize).toBe(100);
	});
});

/* ============================ records —— 筛选 ============================ */

describe('GET /admin/verify/records —— 筛选条件', () => {
	it('event=all / 空 不过滤；其它取值按事件名精确过滤', async () => {
		await seedVerifyRecord({ created_at: Date.now(), event: 'challenge' });
		await seedVerifyRecord({ created_at: Date.now(), event: 'pass', elapsed_ms: 10 });
		await seedVerifyRecord({ created_at: Date.now(), event: 'fail', reason: 'bad signature' });

		for (const query of ['', '?event=all', '?event=']) {
			expect((await records(query)).total).toBe(3);
		}
		expect((await records('?event=pass')).list.map((r: any) => r.event)).toEqual(['pass']);
		expect((await records('?event=fail')).total).toBe(1);
		expect((await records('?event=challenge')).total).toBe(1);
		// 已知行为：非 all 的任意取值都按事件名精确过滤，不会回落到 all
		expect((await records('?event=bogus')).total).toBe(0);
	});

	it('reason / slug 精确匹配（不模糊、区分大小写）', async () => {
		await seedVerifyRecord({
			created_at: Date.now(),
			event: 'fail',
			reason: 'ip mismatch',
			post_slug: '/posts/a',
		});
		await seedVerifyRecord({
			created_at: Date.now(),
			event: 'fail',
			reason: 'bad signature',
			post_slug: '/posts/b',
		});

		expect((await records('?reason=ip%20mismatch')).total).toBe(1);
		expect((await records('?reason=ip')).total).toBe(0);
		expect((await records('?reason=IP%20MISMATCH')).total).toBe(0);
		expect((await records('?slug=/posts/a')).total).toBe(1);
		expect((await records('?slug=/posts')).total).toBe(0);

		// 组合筛选是 AND 关系
		expect((await records('?reason=ip%20mismatch&slug=/posts/a')).total).toBe(1);
		expect((await records('?reason=ip%20mismatch&slug=/posts/b')).total).toBe(0);
		expect((await records('?reason=ip%20mismatch&event=pass')).total).toBe(0);
	});

	it('ip 前缀匹配，且 LIKE 通配符被转义', async () => {
		for (const ip of ['203.0.113.10', '203.0.113.20', '10.0.0.1']) {
			await seedVerifyRecord({ created_at: Date.now(), event: 'challenge', ip_address: ip });
		}

		expect((await records('?ip=203.0.113')).total).toBe(2);
		expect((await records('?ip=203.0.113.1')).total).toBe(1);
		expect((await records('?ip=203.0.113.20')).total).toBe(1);
		expect((await records('?ip=10.')).total).toBe(1);
		expect((await records('?ip=')).total).toBe(3);
		// % 与 _ 必须被当作普通字符，否则会退化成「匹配所有 IP」
		expect((await records('?ip=%25')).total).toBe(0);
		expect((await records('?ip=_')).total).toBe(0);
		expect((await records('?ip=203.0.113.10%25')).total).toBe(0);
	});

	it('days=0 / all 表示全部历史；days=1 只看最近 24 小时', async () => {
		await seedVerifyRecord({ created_at: Date.now(), event: 'challenge' });
		await seedVerifyRecord({ created_at: Date.now() - 25 * HOUR_MS, event: 'challenge' });
		await seedVerifyRecord({ created_at: Date.now() - 40 * DAY_MS, event: 'challenge' });

		expect((await records()).total).toBe(2); // 默认 30 天
		expect((await records('?days=0')).total).toBe(3);
		expect((await records('?days=all')).total).toBe(3);
		expect((await records('?days=1')).total).toBe(1);
		expect((await records('?days=7')).total).toBe(2);
		expect((await records('?days=365')).total).toBe(3); // 40 天前仍在一年内
		expect((await records('?days=999')).total).toBe(3); // 上限 365，与 days=365 等价
		expect((await records('?days=-1')).total).toBe(2); // 负数非法 → 回退 30 天
	});

	it('空结果：list 为空数组、total 为 0，分页参数仍按请求回显', async () => {
		expect(await records('?page=2&pageSize=5')).toEqual({
			list: [],
			total: 0,
			page: 2,
			pageSize: 5,
		});

		await seedVerifyRecord({ created_at: Date.now(), event: 'pass', elapsed_ms: 10 });
		const filtered = await records('?event=fail');
		expect(filtered.list).toEqual([]);
		expect(filtered.total).toBe(0);
	});
});

/* ========================= records —— 字段形状契约 ========================= */

describe('GET /admin/verify/records —— 字段形状', () => {
	it('null 落库值映射为空字符串 / null，字段集合与契约一致', async () => {
		const now = Date.now();
		const challengeId = await seedVerifyRecord({ created_at: now - 1000, event: 'challenge' });
		const passId = await seedVerifyRecord({
			created_at: now,
			event: 'pass',
			elapsed_ms: 1234,
			difficulty: 1000,
			challenge_id: 'cid-1',
			post_slug: '/posts/a',
			ip_address: '203.0.113.10',
			country: 'US',
			network: 'Cloudflare, Inc.',
			asn: 13335,
		});

		const data = await records();
		expect(Object.keys(data.list[0]).sort()).toEqual([
			'asn',
			'challengeId',
			'country',
			'createdAt',
			'difficulty',
			'elapsedMs',
			'event',
			'id',
			'ipAddress',
			'network',
			'postSlug',
			'reason',
		]);

		expect(data.list[0]).toEqual({
			id: passId,
			createdAt: new Date(now).toISOString(),
			event: 'pass',
			reason: '',
			elapsedMs: 1234,
			difficulty: 1000,
			challengeId: 'cid-1',
			postSlug: '/posts/a',
			ipAddress: '203.0.113.10',
			country: 'US',
			network: 'Cloudflare, Inc.',
			asn: 13335,
		});

		expect(data.list[1]).toEqual({
			id: challengeId,
			createdAt: new Date(now - 1000).toISOString(),
			event: 'challenge',
			reason: '',
			elapsedMs: null,
			difficulty: null,
			challengeId: '',
			postSlug: '',
			ipAddress: '',
			country: '',
			network: '',
			asn: null,
		});
	});
});

/* ============================== 保留期清理 ============================== */

describe('pruneVerifyRecords —— 保留期清理', () => {
	it('按 comment_verify_retention_days 删除过期行，保留窗口内的行', async () => {
		await seedSettings({ comment_verify_retention_days: '7' });
		const fresh = await seedVerifyRecord({
			created_at: Date.now() - 3 * DAY_MS,
			event: 'pass',
			elapsed_ms: 10,
		});
		await seedVerifyRecord({ created_at: Date.now() - 8 * DAY_MS, event: 'challenge' });

		expect(await pruneVerifyRecords(env)).toBe(1);
		const left = await allVerifyRecords();
		expect(left.map((r) => r.id)).toEqual([fresh]);
		expect(left[0].event).toBe('pass');
	});

	it('保留天数为 0 表示永久保留', async () => {
		await seedSettings({ comment_verify_retention_days: '0' });
		await seedVerifyRecord({ created_at: Date.now() - 400 * DAY_MS, event: 'challenge' });

		expect(await pruneVerifyRecords(env)).toBe(0);
		expect(await countVerifyRecords()).toBe(1);
	});

	it('未配置时按默认 30 天清理', async () => {
		await seedVerifyRecord({ created_at: Date.now() - 40 * DAY_MS, event: 'challenge' });
		const kept = await seedVerifyRecord({ created_at: Date.now() - 10 * DAY_MS, event: 'challenge' });

		expect(await pruneVerifyRecords(env)).toBe(1);
		const left = await allVerifyRecords();
		expect(left.map((r) => r.id)).toEqual([kept]);
	});

	it('非法设置值退回默认 30 天', async () => {
		await seedSettings({ comment_verify_retention_days: 'abc' });
		await seedVerifyRecord({ created_at: Date.now() - 40 * DAY_MS, event: 'challenge' });

		expect(await pruneVerifyRecords(env)).toBe(1);
		expect(await countVerifyRecords()).toBe(0);
	});

	it('超过上限被钳制为 3650 天（不会误删历史数据）', async () => {
		await seedSettings({ comment_verify_retention_days: '99999' });
		await seedVerifyRecord({ created_at: Date.now() - 400 * DAY_MS, event: 'challenge' });

		expect(await pruneVerifyRecords(env)).toBe(0);
		expect(await countVerifyRecords()).toBe(1);
	});

	it('清理失败不抛错（表不存在时返回 0）', async () => {
		await testEnv.MOMO_DB.prepare('DROP TABLE VerifyRecord').run();
		await expect(pruneVerifyRecords(env)).resolves.toBe(0);
	});
});

/* ===================== comment_verify_log_challenge 开关 ===================== */

describe('comment_verify_log_challenge —— 签发事件开关', () => {
	beforeEach(async () => {
		await seedSettings({
			comment_verify_secret: SECRET,
			comment_verify_difficulty: '1000',
			comment_verify_enabled: 'true',
		});
	});

	async function issueChallenge() {
		return await api('/api/verify/challenge', {
			method: 'POST',
			ip: VERIFY_IP,
			body: { post_slug: VERIFY_SLUG },
		});
	}

	it('默认（未配置）时记录 challenge 事件', async () => {
		const res = await issueChallenge();
		expect(res.status).toBe(200);
		expect(res.body.data.enabled).toBe(true);

		const rows = await allVerifyRecords();
		expect(rows).toHaveLength(1);
		expect(rows[0].event).toBe('challenge');
		expect(rows[0].challenge_id).toBe(res.body.data.challenge_id);
	});

	it('false 时不记录 challenge 事件，但 fail 事件照常记录', async () => {
		await seedSettings({ comment_verify_log_challenge: 'false' });

		const res = await issueChallenge();
		expect(res.status).toBe(200);
		expect(res.body.data.enabled).toBe(true);
		expect(res.body.data.challenge_id).toBeTypeOf('string');
		expect(await countVerifyRecords()).toBe(0);

		const bad = await api('/api/verify/solution', {
			method: 'POST',
			ip: VERIFY_IP,
			body: {
				post_slug: VERIFY_SLUG,
				prefix: 'not-a-challenge',
				sig: 'nope',
				nonces: ['1'],
				elapsed_ms: 500,
			},
		});
		expect(bad.status).toBe(403);
		expect(bad.body.reason).toBe('bad signature');

		const rows = await allVerifyRecords();
		expect(rows).toHaveLength(1);
		expect(rows[0].event).toBe('fail');
		expect(rows[0].reason).toBe('bad signature');
		expect(rows[0].post_slug).toBe(VERIFY_SLUG);
		expect(rows[0].ip_address).toBe(VERIFY_IP);
	});
});

/* ===================== 写入失败不影响验证结果（尽力而为） ===================== */

describe('认证记录写入失败不影响验证流程', () => {
	beforeEach(async () => {
		await seedSettings({
			comment_verify_secret: SECRET,
			comment_verify_difficulty: '1000',
			comment_verify_enabled: 'true',
		});
	});

	it('VerifyRecord 表不可用时仍然正常签发挑战', async () => {
		// 启动自迁移在本文件的首次请求（beforeEach 的登录）里已执行完并被缓存，
		// 因此这里删表不会被 ensureMigrated 自动补回，正好模拟「记录写不进去」。
		await testEnv.MOMO_DB.prepare('DROP TABLE VerifyRecord').run();
		expect(await tableExists('VerifyRecord')).toBe(false);

		const res = await api('/api/verify/challenge', {
			method: 'POST',
			ip: '203.0.113.201',
			body: { post_slug: VERIFY_SLUG },
		});
		expect(res.status).toBe(200);
		expect(res.body.data.enabled).toBe(true);
		expect(res.body.data.pow).toBeDefined();
	});
});

/* ====================== extractCfGeo —— request.cf 容错 ====================== */

describe('extractCfGeo —— request.cf 容错', () => {
	it('取不到 cf 时三列全为 null（本地 dev / 测试环境）', () => {
		for (const cf of [undefined, null, 'US', 42, []]) {
			expect(extractCfGeo(cf)).toEqual({ country: null, network: null, asn: null });
		}
	});

	it('解析 country / asOrganization / asn，并忽略空串与非数字 asn', () => {
		expect(extractCfGeo({ country: 'JP', asOrganization: 'NTT Communications', asn: 2497 })).toEqual({
			country: 'JP',
			network: 'NTT Communications',
			asn: 2497,
		});
		expect(extractCfGeo({ country: '', asOrganization: '', asn: 'not-a-number' })).toEqual({
			country: null,
			network: null,
			asn: null,
		});
		// 字符串形式的数字被 Number() 接受，小数被截断
		expect(extractCfGeo({ asn: '13335' })).toEqual({ country: null, network: null, asn: 13335 });
		expect(extractCfGeo({ asn: 13335.9 })).toEqual({ country: null, network: null, asn: 13335 });
		// 字段类型不对（数字/对象）时同样不写入脏值
		expect(extractCfGeo({ country: 1, asOrganization: { name: 'x' } })).toEqual({
			country: null,
			network: null,
			asn: null,
		});
		// asn 缺失（undefined）/ 显式 null / 空串都必须落成 null：
		// Number(null) === 0 曾被误当成「AS0」写入榜单，这里把它钉死。
		expect(extractCfGeo({ asn: undefined })).toEqual({ country: null, network: null, asn: null });
		expect(extractCfGeo({ asn: null })).toEqual({ country: null, network: null, asn: null });
		expect(extractCfGeo({ asn: '' })).toEqual({ country: null, network: null, asn: null });
	});
});
