import { describe, it, expect, vi, afterEach } from 'vitest';
import i18nit from '../src/i18n/translation';
import zhCN from '../src/i18n/language/zh-cn';
import en from '../src/i18n/language/en';

/**
 * key.ts 里 Translation 接口声明的全部键（评论组件的 i18n 契约）。
 * 这份清单是「契约快照」：key.ts 变更时这里必须同步更新，
 * 从而保证字典与类型定义不会悄悄漂移。
 */
const CONTRACT_KEYS = [
	'name',
	'email',
	'site',
	'required',
	'optional',
	'welcome',
	'comments',
	'cancel',
	'send',
	'sending',
	'reply',
	'replyPlaceholder',
	'loadMore',
	'loading',
	'loadFailed',
	'submitSuccess',
	'submitFailed',
	'verificationRequired',
	'fillRequired',
	'confirmDelete',
	'delete',
	'deleteSuccess',
	'deleteFailed',
	'deleteError',
	'characters',
	'words',
	'contentTooLong',
	'replyTo',
	'write',
	'preview',
	'previewError',
	'codeFence',
	'inlineCode',
	'bold',
	'italic',
	'quote',
	'code',
	'link',
	'image',
	'list',
	'showMoreReplies',
	'collapseReplies',
	'verifying',
	'verifySuccess',
	'verifyFailed',
	'verifyRetry',
	'adminKey',
	'adminKeyPlaceholder',
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('i18n —— 语言包键集一致性（回归守卫）', () => {
	it('zh-cn.ts 恰好包含契约里的全部键，没有缺漏', () => {
		expect(Object.keys(zhCN.comments).sort()).toEqual([...CONTRACT_KEYS].sort());
	});

	it('en.ts 恰好包含契约里的全部键，没有缺漏', () => {
		expect(Object.keys(en.comments).sort()).toEqual([...CONTRACT_KEYS].sort());
	});

	it('两种语言的键集完全相同（不会出现只翻了一半的键）', () => {
		expect(Object.keys(zhCN.comments).sort()).toEqual(Object.keys(en.comments).sort());
	});

	it('顶层命名空间只有 comments', () => {
		expect(Object.keys(zhCN)).toEqual(['comments']);
		expect(Object.keys(en)).toEqual(['comments']);
	});

	it('所有翻译值都是非空字符串', () => {
		for (const [key, value] of Object.entries(zhCN.comments)) {
			expect(typeof value, `zh-cn.comments.${key} 应为字符串`).toBe('string');
			expect(value.length, `zh-cn.comments.${key} 不应为空`).toBeGreaterThan(0);
		}
		for (const [key, value] of Object.entries(en.comments)) {
			expect(typeof value, `en.comments.${key} 应为字符串`).toBe('string');
			expect(value.length, `en.comments.${key} 不应为空`).toBeGreaterThan(0);
		}
	});

	it('键名不允许出现空白或点号（会被当成嵌套路径）', () => {
		for (const key of Object.keys(zhCN.comments)) {
			expect(key).not.toMatch(/[\s.]/);
		}
	});

	it('中文与英文不是同一份拷贝（至少 40 个键不同）', () => {
		const diff = CONTRACT_KEYS.filter((k) => zhCN.comments[k] !== en.comments[k]);
		expect(diff.length).toBeGreaterThanOrEqual(40);
	});
});

describe('i18n —— 真实字典取值', () => {
	it('zh-cn 取到中文', () => {
		const t = i18nit('zh-cn');
		expect(t('comments.reply')).toBe('回复');
		expect(t('comments.name')).toBe('昵称');
		expect(t('comments.comments')).toBe('条评论');
		expect(t('comments.loadFailed')).toBe('加载失败');
	});

	it('en 取到英文', () => {
		const t = i18nit('en');
		expect(t('comments.reply')).toBe('Reply');
		expect(t('comments.name')).toBe('Name');
		expect(t('comments.comments')).toBe('Comments');
		expect(t('comments.loadFailed')).toBe('Failed to load');
	});

	it('i18nit 返回可调用函数', () => {
		expect(typeof i18nit('en')).toBe('function');
		expect(typeof i18nit('zh-cn')).toBe('function');
	});

	it('同一实例可重复调用，结果稳定', () => {
		const t = i18nit('en');
		expect(t('comments.send')).toBe(t('comments.send'));
		expect(t('comments.send')).toBe('Send');
	});

	it('不传 params 时字典中的原值原样返回（当前字典没有占位符）', () => {
		const t = i18nit('zh-cn');
		expect(t('comments.contentTooLong', { any: 'thing' })).toBe(zhCN.comments.contentTooLong);
	});

	it('字典里确实没有任何 {占位符}，因此调用点不会漏参', () => {
		for (const value of Object.values(zhCN.comments)) expect(value).not.toMatch(/\{\w+\}/);
		for (const value of Object.values(en.comments)) expect(value).not.toMatch(/\{\w+\}/);
	});
});

describe('i18n —— 语言回退', () => {
	it('未知语言回退到 zh-cn', () => {
		const t = i18nit('fr');
		expect(t('comments.reply')).toBe('回复');
		expect(t('comments.name')).toBe('昵称');
	});

	it('带地区的 en-US 也会回退到中文（只注册了 en / zh-cn 两种 key）', () => {
		// 记录现状：调用方传 lang="en-US" 时拿到的是中文而不是英文
		expect(i18nit('en-US')('comments.reply')).toBe('回复');
	});

	it('大写 ZH-CN 也会回退到 zh-cn（靠回退而非大小写归一）', () => {
		expect(i18nit('ZH-CN')('comments.reply')).toBe('回复');
	});

	it('大写 EN 回退到中文（没有做大小写归一）', () => {
		expect(i18nit('EN')('comments.reply')).toBe('回复');
	});

	it('空语言串回退到 zh-cn 且不抛错', () => {
		expect(() => i18nit('')('comments.reply')).not.toThrow();
		expect(i18nit('')('comments.reply')).toBe('回复');
	});
});

describe('i18n —— 缺失键的处理', () => {
	it('缺失键返回空串', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('zh-cn')('comments.doesNotExist')).toBe('');
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('告警信息包含键名与语言（便于定位）', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		i18nit('en')('comments.nope');
		expect(warn.mock.calls[0][0]).toBe('[i18n] missing translation key: comments.nope (en)');
	});

	it('取到对象（非字符串）时同样返回空串并告警', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('zh-cn')('comments')).toBe('');
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('空键名返回空串并告警', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('en')('')).toBe('');
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('注释里依赖的 comments.noContent 键当前并不存在（组件会打印 i18n 告警并走硬编码兜底）', () => {
		// CommentItem.svelte:243 使用 t('comments.noContent') || '评论内容为空'
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('zh-cn')('comments.noContent')).toBe('');
		expect(i18nit('en')('comments.noContent')).toBe('');
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('缺失键返回 ""（而不是键名），调用点可继续用 || 兜底', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(i18nit('en')('comments.missing') || 'fallback').toBe('fallback');
	});
});
