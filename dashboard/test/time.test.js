import { describe, it, expect, afterEach } from 'vitest';
import {
	bucketAxisLabel,
	bucketTooltipLabel,
	bucketGranularity,
	parseBucketKey,
	formatLocalDate,
} from '../src/utils/time.js';

/**
 * 时间显示工具的约束：
 *  - 后端的时间戳与统计分桶键都是 UTC，前端展示统一换算成**浏览器本地时区**；
 *  - 轴标签形状与改造前一致（小时 HH:00、日 MM-DD、月「M月 / YY年」），只是数值按本地时区算；
 *  - 无法识别的键原样返回，避免数据凭空消失。
 *
 * 时区靠 process.env.TZ 切换（Node 会立即生效），因此断言在任何机器上都一致。
 */

const HOST_TZ = process.env.TZ;

afterEach(() => {
	process.env.TZ = HOST_TZ;
});

describe('utils/time — 分桶键解析', () => {
	it('识别三种粒度', () => {
		expect(bucketGranularity('2024-05')).toBe('month');
		expect(bucketGranularity('2024-05-06')).toBe('day');
		expect(bucketGranularity('2024-05-06T13')).toBe('hour');
		expect(bucketGranularity('')).toBeNull();
		expect(bucketGranularity('2024/05/06')).toBeNull();
		expect(bucketGranularity(undefined)).toBeNull();
	});

	it('按 UTC 解析（而不是本地）', () => {
		process.env.TZ = 'Asia/Shanghai';
		// UTC 2024-05-06 00:00 的毫秒值
		expect(parseBucketKey('2024-05-06').getTime()).toBe(Date.UTC(2024, 4, 6));
		expect(parseBucketKey('2024-05-06T13').getTime()).toBe(Date.UTC(2024, 4, 6, 13));
		expect(parseBucketKey('2024-05').getTime()).toBe(Date.UTC(2024, 4, 1));
		expect(parseBucketKey('乱七八糟')).toBeNull();
	});
});

describe('utils/time — 轴标签（UTC+8）', () => {
	it('日粒度：UTC 日桶的起点落在同一天', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketAxisLabel('2024-05-06')).toBe('05-06');
		expect(bucketAxisLabel('2024-12-31')).toBe('12-31');
	});

	it('小时粒度：换算成本地小时', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketAxisLabel('2024-05-06T00')).toBe('08:00');
		expect(bucketAxisLabel('2024-05-06T13')).toBe('21:00');
		// UTC 16:00 → 本地次日 00:00
		expect(bucketAxisLabel('2024-05-06T16')).toBe('00:00');
	});

	it('月粒度：1 月显示年份，其余显示月份', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketAxisLabel('2024-03')).toBe('3月');
		expect(bucketAxisLabel('2024-01')).toBe('24年');
	});

	it('无法识别的键原样返回', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketAxisLabel('')).toBe('');
		expect(bucketAxisLabel(undefined)).toBe('');
		expect(bucketAxisLabel('week-1')).toBe('week-1');
	});
});

describe('utils/time — 轴标签（西半球时区，UTC-4 / UTC-5）', () => {
	it('日粒度：UTC 日桶起点落在前一天', () => {
		process.env.TZ = 'America/New_York';
		// UTC 2024-05-06 00:00 → 本地 05-05 20:00
		expect(bucketAxisLabel('2024-05-06')).toBe('05-05');
	});

	it('月粒度：UTC 月初落在上个月末', () => {
		process.env.TZ = 'America/New_York';
		// UTC 2024-03-01 00:00 → 本地 2024-02-29 19:00
		expect(bucketAxisLabel('2024-03')).toBe('2月');
	});
});

describe('utils/time — 悬浮提示的完整本地时间', () => {
	it('小时粒度带日期与小时', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketTooltipLabel('2024-05-06T13')).toBe('2024-05-06 21:00');
	});

	it('跨日的小时桶显示次日的本地时间', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketTooltipLabel('2024-05-06T20')).toBe('2024-05-07 04:00');
	});

	it('日粒度与月粒度', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketTooltipLabel('2024-05-06')).toBe('2024-05-06');
		expect(bucketTooltipLabel('2024-03')).toBe('2024-03');
	});

	it('无法识别的键原样返回', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(bucketTooltipLabel('oops')).toBe('oops');
	});
});

describe('utils/time — formatLocalDate', () => {
	it('ISO 时刻换算成本地日期（UTC+8 会跨日）', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(formatLocalDate('2024-05-06T20:00:00.000Z')).toBe('2024-05-07');
		expect(formatLocalDate('2024-05-06T07:08:09.000Z')).toBe('2024-05-06');
	});

	it('西半球时区下 ISO 时刻回退到前一天', () => {
		process.env.TZ = 'America/New_York';
		expect(formatLocalDate('2024-05-06T02:00:00.000Z')).toBe('2024-05-05');
	});

	it('UTC 时区下与 UTC 切片一致', () => {
		process.env.TZ = 'UTC';
		expect(formatLocalDate('2026-04-26T23:59:59.999Z')).toBe('2026-04-26');
	});

	it('同时接受 Date 与毫秒数', () => {
		process.env.TZ = 'UTC';
		expect(formatLocalDate(new Date(Date.UTC(2024, 4, 6, 12)))).toBe('2024-05-06');
		expect(formatLocalDate(Date.UTC(2024, 4, 6, 12))).toBe('2024-05-06');
	});

	it('也能解析分桶键', () => {
		process.env.TZ = 'Asia/Shanghai';
		expect(formatLocalDate('2024-05-06')).toBe('2024-05-06');
		expect(formatLocalDate('2024-05-06T20')).toBe('2024-05-07');
	});

	it('空值与非法值返回空字符串', () => {
		process.env.TZ = 'UTC';
		expect(formatLocalDate('')).toBe('');
		expect(formatLocalDate(null)).toBe('');
		expect(formatLocalDate(undefined)).toBe('');
		expect(formatLocalDate('not-a-date')).toBe('');
	});
});
