/**
 * src/utils/time.ts —— 时间字段统一解析。
 *
 * 三端契约：pub_date 落库为「毫秒整数」，读取侧兼容历史 ISO 字符串。
 * 这些函数是把历史数据接回新契约的关键，非法输入必须稳定返回 null / 空串，
 * 绝不能抛出或返回 NaN（否则会污染 SQL 与响应体）。
 */
import { describe, it, expect } from 'vitest';
import { toMillis, toIsoString } from '../../src/utils/time';

const MS = 1730000000000;
const MS_ISO = '2024-10-27T03:33:20.000Z';

describe('toMillis —— 数字输入', () => {
	it('毫秒整数原样返回', () => {
		expect(toMillis(MS)).toBe(MS);
		expect(toMillis(1)).toBe(1);
	});

	it('零与负数视为非法（返回 null）', () => {
		expect(toMillis(0)).toBeNull();
		expect(toMillis(-1)).toBeNull();
		expect(toMillis(-1730000000000)).toBeNull();
	});

	it('NaN / Infinity 返回 null', () => {
		expect(toMillis(NaN)).toBeNull();
		expect(toMillis(Infinity)).toBeNull();
		expect(toMillis(-Infinity)).toBeNull();
	});
});

describe('toMillis —— 数字字符串输入', () => {
	it('纯数字字符串按毫秒整数处理（而不是走 Date.parse）', () => {
		expect(toMillis('1730000000000')).toBe(MS);
		expect(toMillis('1')).toBe(1);
	});

	it('两端空白被裁剪', () => {
		expect(toMillis('  1730000000000  ')).toBe(MS);
	});

	it('"0" 返回 null（与数字 0 行为一致）', () => {
		expect(toMillis('0')).toBeNull();
		expect(toMillis('00')).toBeNull();
	});

	it('非纯数字形态会落到 V8 宽松日期解析分支（记录既有实现细节）', () => {
		// toMillis 只把 /^\d+$/ 当毫秒整数；'1.5' / '-1' / '+1' 都会交给 Date.parse，
		// V8 的宽松解析器把它们当成日期而非时间戳，于是返回一个语义错误的有限毫秒值。
		// 这里只断言「不会返回 null」这一事实，避免把某个 V8 版本的具体取值写死。
		for (const raw of ['1.5', '-1', '+1']) {
			const result = toMillis(raw);
			expect(Number.isFinite(result as number)).toBe(true);
		}
	});

	it('科学计数法与十六进制无法被 Date.parse 解析，返回 null', () => {
		expect(toMillis('1e3')).toBeNull();
		expect(toMillis('0x10')).toBeNull();
	});
});

describe('toMillis —— ISO 字符串输入', () => {
	it('UTC ISO 字符串转为毫秒整数', () => {
		expect(toMillis('2024-03-05T06:07:08.000Z')).toBe(1709618828000);
		expect(toMillis(MS_ISO)).toBe(MS);
	});

	it('带毫秒与带时区偏移都能解析', () => {
		expect(toMillis('2024-03-05T06:07:08.123Z')).toBe(1709618828123);
		expect(toMillis('2024-03-05T06:07:08+08:00')).toBe(1709590028000);
	});

	it('仅日期部分按 UTC 零点解析', () => {
		expect(toMillis('2024-03-05')).toBe(1709596800000);
	});
});

describe('toMillis —— 非法输入', () => {
	it('null / undefined 返回 null', () => {
		expect(toMillis(null)).toBeNull();
		expect(toMillis(undefined)).toBeNull();
	});

	it('空串与纯空白返回 null', () => {
		expect(toMillis('')).toBeNull();
		expect(toMillis('   ')).toBeNull();
		expect(toMillis('\n\t')).toBeNull();
	});

	it('无法解析的字符串返回 null 而不是 NaN', () => {
		const result = toMillis('not-a-date');
		expect(result).toBeNull();
		expect(Number.isNaN(result as unknown as number)).toBe(false);
	});

	it('布尔 / 对象 / 数组不会抛异常', () => {
		expect(toMillis(true)).toBeNull();
		expect(toMillis(false)).toBeNull();
		expect(toMillis({})).toBeNull();
		expect(toMillis([])).toBeNull();
		expect(toMillis([MS])).toBe(MS);
	});

	it('超出安全范围的超长数字串仍返回有限正数（无上界校验）', () => {
		const result = toMillis('99999999999999999999');
		expect(Number.isFinite(result as number)).toBe(true);
		expect(Number.isNaN(result as number)).toBe(false);
		expect(result as number).toBeGreaterThan(0);
	});
});

describe('toIsoString', () => {
	it('毫秒整数格式化为 ISO 字符串', () => {
		expect(toIsoString(MS)).toBe(MS_ISO);
		expect(toIsoString(1709618828000)).toBe('2024-03-05T06:07:08.000Z');
	});

	it('数字字符串与 ISO 字符串都归一化为同一 ISO 输出', () => {
		expect(toIsoString(String(MS))).toBe(MS_ISO);
		expect(toIsoString(MS_ISO)).toBe(MS_ISO);
	});

	it('非法输入返回空串而不是 "Invalid Date"', () => {
		expect(toIsoString(null)).toBe('');
		expect(toIsoString(undefined)).toBe('');
		expect(toIsoString('')).toBe('');
		expect(toIsoString('garbage')).toBe('');
		expect(toIsoString(0)).toBe('');
		expect(toIsoString(-1)).toBe('');
		expect(toIsoString(NaN)).toBe('');
	});
});
