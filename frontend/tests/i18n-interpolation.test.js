import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * 真实字典里没有任何 {占位符}，所以这里用 mock 的 zh-cn 字典
 * 单独覆盖 translation.ts 的插值实现分支。
 */
vi.mock('../src/i18n/language/zh-cn', () => ({
	default: {
		comments: {
			greet: '你好 {name}',
			pair: '{a} 与 {b}',
			num: '共 {n} 条',
			repeat: '{x}-{x}',
			nested: { deep: '深层 {v}' },
			obj: { a: 1 },
			empty: '',
			real: '中文',
			weird: '值 {a-b} 完',
			unclosed: '值 {name 完',
		},
	},
}));

const { default: i18nit } = await import('../src/i18n/translation');

afterEach(() => {
	vi.restoreAllMocks();
});

describe('i18n 插值 —— 单个与多个占位符', () => {
	it('单个占位符被替换', () => {
		expect(i18nit('zh-cn')('comments.greet', { name: '世界' })).toBe('你好 世界');
	});

	it('多个占位符全部被替换', () => {
		expect(i18nit('zh-cn')('comments.pair', { a: '甲', b: '乙' })).toBe('甲 与 乙');
	});

	it('同一个占位符出现多次时全部替换（不是只替换第一个）', () => {
		expect(i18nit('zh-cn')('comments.repeat', { x: 'ab' })).toBe('ab-ab');
	});

	it('数字参数会被转成字符串', () => {
		expect(i18nit('zh-cn')('comments.num', { n: 42 })).toBe('共 42 条');
	});

	it('数字 0 是有效值，不会被当成缺失（?? 不把 0 视为空）', () => {
		expect(i18nit('zh-cn')('comments.num', { n: 0 })).toBe('共 0 条');
	});

	it('嵌套路径的占位符同样生效', () => {
		expect(i18nit('zh-cn')('comments.nested.deep', { v: 'v1' })).toBe('深层 v1');
	});

	it('多余的参数被忽略', () => {
		expect(i18nit('zh-cn')('comments.greet', { name: 'A', extra: 'B', more: 1 })).toBe('你好 A');
	});
});

describe('i18n 插值 —— 缺失/异常参数', () => {
	it('完全不传 params 时，占位符被替换成参数名本身', () => {
		// 记录现状：String(params?.[param] ?? param) 用参数名兜底，不会残留 {name}
		expect(i18nit('zh-cn')('comments.greet')).toBe('你好 name');
	});

	it('传了 params 但缺少对应键时，同样替换成参数名', () => {
		expect(i18nit('zh-cn')('comments.greet', { other: 'x' })).toBe('你好 name');
	});

	it('参数值为 null 时视为缺失，替换成参数名', () => {
		expect(i18nit('zh-cn')('comments.greet', { name: null })).toBe('你好 name');
	});

	it('参数值为 undefined 时视为缺失，替换成参数名', () => {
		expect(i18nit('zh-cn')('comments.greet', { name: undefined })).toBe('你好 name');
	});

	it('参数值里的 $& 不会被 replace 当成特殊替换串', () => {
		expect(i18nit('zh-cn')('comments.greet', { name: '$&x' })).toBe('你好 $&x');
	});

	it('非 \\w 字符的占位符不参与匹配，原样保留', () => {
		expect(i18nit('zh-cn')('comments.weird', { 'a-b': 'v' })).toBe('值 {a-b} 完');
	});

	it('未闭合的花括号原样保留', () => {
		expect(i18nit('zh-cn')('comments.unclosed', { name: 'v' })).toBe('值 {name 完');
	});

	it('中文与 emoji 参数值可以正常插入', () => {
		expect(i18nit('zh-cn')('comments.greet', { name: '世界🎉' })).toBe('你好 世界🎉');
	});
});

describe('i18n 插值 —— 值与回退', () => {
	it('字典值为空字符串时直接返回空串，且不产生告警', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('zh-cn')('comments.empty')).toBe('');
		expect(warn).not.toHaveBeenCalled();
	});

	it('取到对象（非字符串）时返回空串并告警', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('zh-cn')('comments.obj')).toBe('');
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('未知语言回退到 mock 的 zh-cn 字典', () => {
		expect(i18nit('ja')('comments.greet', { name: 'X' })).toBe('你好 X');
	});

	it('未知语言 + 缺失键：告警里带的是请求的语言', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('ja')('comments.nope')).toBe('');
		expect(warn.mock.calls[0][0]).toBe('[i18n] missing translation key: comments.nope (ja)');
	});

	it('en 语言下 mock 字典没有的键会回退到 zh-cn 的插值结果', () => {
		expect(i18nit('en')('comments.greet', { name: 'World' })).toBe('你好 World');
	});
});
