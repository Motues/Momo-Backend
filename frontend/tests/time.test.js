import { describe, it, expect } from 'vitest';
// 用别名导入，顺便验证 vitest.config.js 里的 `@` -> ./src 别名可用
import { formatMonthDay, formatFullDate } from '@/utils/time';

/** 2024-01-05 12:00 本地时间（构造 Date 而非字符串，避免时区解析差异） */
const D = new Date(2024, 0, 5, 12, 0, 0);
/** 2024-10-27 12:00 本地时间（两位数月/日，用来验证彭古空格的两侧插入） */
const D2 = new Date(2024, 9, 27, 12, 0, 0);

/** 某个 locale 下 Intl 的原生输出（用于「不加彭古空格」的结构性断言） */
const rawMonthDay = (date, lang) =>
  new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' }).format(date);
const rawFullDate = (date, lang) =>
  new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);

describe('formatMonthDay —— 中文 locale 会插入彭古空格', () => {
	it('zh-CN：月与日之间插入空格', () => {
		expect(formatMonthDay(D, 'zh-CN')).toBe('1 月 5 日');
	});

	it('zh-cn（小写）同样插入空格，说明大小写不敏感', () => {
		expect(formatMonthDay(D, 'zh-cn')).toBe('1 月 5 日');
	});

	it('ZH-CN（全大写）仍然插入空格（内部用了 toLowerCase）', () => {
		expect(formatMonthDay(D, 'ZH-CN')).toBe('1 月 5 日');
	});

	it('两位数月日：数字与汉字两侧都补空格', () => {
		expect(formatMonthDay(D2, 'zh-CN')).toBe('10 月 27 日');
	});

	it('中文结果形如 “<数字> 月 <数字> 日”，不可能出现无空格形态', () => {
		const out = formatMonthDay(D2, 'zh-CN');
		expect(out).toMatch(/^\d+ 月 \d+ 日$/);
		expect(out).not.toBe('10月27日');
		expect(out).not.toContain('月27');
	});

	it('默认语言是 zh-CN（不传 lang 参数）', () => {
		expect(formatMonthDay(D)).toBe('1 月 5 日');
	});

	it('接受 "YYYY-MM-DD" 字符串，且与等价的 Date 结果一致', () => {
		expect(formatMonthDay('2024-01-05', 'zh-CN')).toBe(formatMonthDay(new Date(2024, 0, 5), 'zh-CN'));
		expect(formatMonthDay('2024-01-05', 'zh-CN')).toBe('1 月 5 日');
	});

	it('12 月 31 日边界', () => {
		expect(formatMonthDay('2024-12-31', 'zh-CN')).toBe('12 月 31 日');
	});
});

describe('formatMonthDay —— 非中文 locale 不加空格', () => {
	it('en：输出 Jan 5', () => {
		expect(formatMonthDay(D, 'en')).toBe('Jan 5');
	});

	it('en：结果与 Intl 原生输出完全一致（未做任何加工）', () => {
		expect(formatMonthDay(D, 'en')).toBe(rawMonthDay(D, 'en'));
		expect(formatMonthDay(D, 'en')).not.toContain('月');
	});

	it('en-GB：日在前月在后，不插入空格', () => {
		expect(formatMonthDay(D, 'en-GB')).toBe('5 Jan');
	});

	it('未知语言不抛错，返回非空字符串', () => {
		const out = formatMonthDay(D, 'xx-YY');
		expect(typeof out).toBe('string');
		expect(out.length).toBeGreaterThan(0);
	});

	it('未知语言按“非 zh 前缀”处理：不会插入彭古空格', () => {
		expect(formatMonthDay(D, 'xx-YY')).toBe(rawMonthDay(D, 'xx-YY'));
	});
});

describe('formatMonthDay —— 非法输入边界', () => {
	it('下划线写法 zh_CN 会抛 RangeError（未做 normalizeLocale）', () => {
		expect(() => formatMonthDay(D, 'zh_CN')).toThrow(RangeError);
	});

	it('空语言串 "" 会抛 RangeError', () => {
		expect(() => formatMonthDay(D, '')).toThrow(RangeError);
	});

	it('非法语言标签会抛 RangeError', () => {
		expect(() => formatMonthDay(D, 'not a locale!')).toThrow(RangeError);
	});

	it('null 语言会抛 TypeError（Intl 无法处理 null）', () => {
		expect(() => formatMonthDay(D, null)).toThrow(TypeError);
	});

	it('非法 Date（NaN）会抛 RangeError', () => {
		expect(() => formatMonthDay(new Date(NaN), 'zh-CN')).toThrow(RangeError);
	});

	it('空字符串日期解析为 Invalid Date，抛 RangeError', () => {
		expect(() => formatMonthDay('', 'zh-CN')).toThrow(RangeError);
	});

	it('缺少日部分的字符串抛 RangeError', () => {
		expect(() => formatMonthDay('2024-01', 'zh-CN')).toThrow(RangeError);
	});

	it('毫秒时间戳（number）会抛 TypeError：input.split is not a function', () => {
		// 组件里总是先 new Date(c.pubDate) 再传进来，所以组件路径不受影响
		expect(() => formatMonthDay(1730000000000, 'zh-CN')).toThrow(TypeError);
	});

	it('月/日越界不会抛错（Date 自动进位）', () => {
		expect(() => formatMonthDay('2024-13-45', 'zh-CN')).not.toThrow();
		expect(formatMonthDay('2024-13-45', 'zh-CN')).toBe(formatMonthDay(new Date(2025, 1, 14), 'zh-CN'));
	});
});

describe('formatFullDate —— 中文 locale', () => {
	it('zh-CN：年月日之间都插入空格', () => {
		expect(formatFullDate(D, 'zh-CN')).toBe('2024 年 1 月 5 日');
	});

	it('zh-cn（小写）结果与 zh-CN 一致', () => {
		expect(formatFullDate(D, 'zh-cn')).toBe('2024 年 1 月 5 日');
	});

	it('两位数月日', () => {
		expect(formatFullDate(D2, 'zh-CN')).toBe('2024 年 10 月 27 日');
	});

	it('默认语言是 zh-CN', () => {
		expect(formatFullDate(D)).toBe('2024 年 1 月 5 日');
	});

	it('显式传入 undefined 时仍走默认值 zh-CN', () => {
		expect(formatFullDate(D, undefined)).toBe('2024 年 1 月 5 日');
	});

	it('"YYYY-MM-DD" 字符串与等价的 Date 结果一致', () => {
		expect(formatFullDate('2024-01-05', 'zh-CN')).toBe(formatFullDate(new Date(2024, 0, 5), 'zh-CN'));
	});

	it('毫秒时间戳先经过 new Date() 包装才可用（组件的调用方式）', () => {
		expect(formatFullDate(new Date(1730000000000), 'zh-CN')).toBe(formatFullDate(new Date(1730000000000), 'zh-CN'));
		expect(formatFullDate(new Date(1730000000000), 'zh-CN')).toMatch(/^2024 年 10 月 27 日$/);
	});
});

describe('formatFullDate —— 非中文 locale 与大小写差异', () => {
	it('en：Jan 5, 2024', () => {
		expect(formatFullDate(D, 'en')).toBe('Jan 5, 2024');
	});

	it('en：与 Intl 原生输出一致，不含汉字', () => {
		expect(formatFullDate(D, 'en')).toBe(rawFullDate(D, 'en'));
		expect(formatFullDate(D, 'en')).not.toContain('年');
	});

	it('en-GB：日在前', () => {
		expect(formatFullDate(D, 'en-GB')).toBe('5 Jan 2024');
	});

	it('大写 ZH-CN 不加空格：lang.startsWith("zh") 区分大小写（与 formatMonthDay 不一致）', () => {
		expect(formatFullDate(D, 'ZH-CN')).toBe('2024年1月5日');
		expect(formatMonthDay(D, 'ZH-CN')).toBe('1 月 5 日');
	});

	it('下划线写法 zh_CN 被 normalizeLocale 修正为 zh-CN，不抛错', () => {
		expect(() => formatFullDate(D, 'zh_CN')).not.toThrow();
		expect(formatFullDate(D, 'zh_CN')).toBe('2024 年 1 月 5 日');
	});

	it('空语言串 "" 回退为 en-US（不抛错，与 formatMonthDay 不一致）', () => {
		expect(() => formatFullDate(D, '')).not.toThrow();
		expect(formatFullDate(D, '')).toBe(formatFullDate(D, 'en-US'));
	});

	it('未知语言不抛错，且按非 zh 处理（不加空格）', () => {
		expect(() => formatFullDate(D, 'xx-YY')).not.toThrow();
		expect(formatFullDate(D, 'xx-YY')).toBe(rawFullDate(D, 'xx-YY'));
	});
});

describe('formatFullDate —— 非法输入边界', () => {
	it('null 语言抛 TypeError（normalizeLocale 之后 .startsWith 落空）', () => {
		expect(() => formatFullDate(D, null)).toThrow(TypeError);
	});

	it('非法 Date 抛 RangeError', () => {
		expect(() => formatFullDate(new Date(NaN), 'zh-CN')).toThrow(RangeError);
	});

	it('不可解析的日期字符串抛 RangeError', () => {
		expect(() => formatFullDate('nope', 'zh-CN')).toThrow(RangeError);
	});

	it('空字符串日期抛 RangeError', () => {
		expect(() => formatFullDate('', 'zh-CN')).toThrow(RangeError);
	});

	it('毫秒时间戳（number）抛 TypeError，必须先 new Date()', () => {
		expect(() => formatFullDate(1730000000000, 'zh-CN')).toThrow(TypeError);
	});

	it('null 日期抛 TypeError', () => {
		expect(() => formatFullDate(null, 'zh-CN')).toThrow(TypeError);
	});

	it('undefined 日期抛 TypeError（dateInput 没有默认值）', () => {
		expect(() => formatFullDate(undefined, 'zh-CN')).toThrow(TypeError);
	});

	it('越界月份自动进位，不抛错', () => {
		expect(() => formatFullDate('2024-13-45', 'zh-CN')).not.toThrow();
		expect(formatFullDate('2024-13-45', 'zh-CN')).toBe('2025 年 2 月 14 日');
	});

	it('1970 年时间戳 0 可正常格式化', () => {
		expect(() => formatFullDate(new Date(0), 'zh-CN')).not.toThrow();
		expect(formatFullDate(new Date(0), 'zh-CN')).toContain('1970');
	});

	it('负数时间戳（1970 之前）可正常格式化', () => {
		expect(() => formatFullDate(new Date(-1), 'zh-CN')).not.toThrow();
	});
});

describe('formatMonthDay / formatFullDate —— 一致性', () => {
	it('同一天的月/日信息一致（忽略年份与空格）', () => {
		const md = formatMonthDay(D2, 'zh-CN').replace(/\s/g, '');
		const fd = formatFullDate(D2, 'zh-CN').replace(/\s/g, '');
		expect(fd).toContain(md);
	});

	it('两个函数都不修改传入的 Date 对象', () => {
		const date = new Date(2024, 5, 15, 8, 30);
		const before = date.getTime();
		formatMonthDay(date, 'zh-CN');
		formatFullDate(date, 'zh-CN');
		expect(date.getTime()).toBe(before);
	});
});
