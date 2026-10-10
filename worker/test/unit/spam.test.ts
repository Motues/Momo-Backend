/**
 * src/utils/spam.ts —— 审核自动化（垃圾规则）的设置读取与重复检测。
 *
 * 纯函数规则本身由跨语言向量（doc/vectors/spam-v1.json）覆盖，
 * 这里只验证需要数据库的部分与后台校验的边界。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSchema, seedComment, seedSettings, testEnv } from '../helpers/db';
import {
	parseSpamKeywords,
	parseSpamNumber,
	countLinks,
	evaluateSpamRules,
	isValidSpamKeywordsJson,
	validateSpamSetting,
	validateSpamSettings,
	getSpamSettings,
	checkCommentSpam,
	SPAM_DEFAULTS,
	SPAM_LIMITS,
	SPAM_SETTING_KEYS,
} from '../../src/utils/spam';

const env = testEnv;

describe('isValidSpamKeywordsJson —— 边界', () => {
	beforeEach(createSchema);

	it('空串表示未设置，允许', () => {
		expect(isValidSpamKeywordsJson('')).toBe(true);
	});

	it('条数上限为 200', () => {
		const ok = JSON.stringify(Array.from({ length: SPAM_LIMITS.MAX_KEYWORDS }, (_, i) => `k${i}`));
		const tooMany = JSON.stringify(
			Array.from({ length: SPAM_LIMITS.MAX_KEYWORDS + 1 }, (_, i) => `k${i}`)
		);
		expect(isValidSpamKeywordsJson(ok)).toBe(true);
		expect(isValidSpamKeywordsJson(tooMany)).toBe(false);
	});

	it('单条长度上限为 100 个码点（emoji 算一个）', () => {
		expect(isValidSpamKeywordsJson(JSON.stringify(['字'.repeat(SPAM_LIMITS.MAX_KEYWORD_LENGTH)]))).toBe(true);
		expect(isValidSpamKeywordsJson(JSON.stringify(['字'.repeat(SPAM_LIMITS.MAX_KEYWORD_LENGTH + 1)]))).toBe(
			false
		);
		expect(isValidSpamKeywordsJson(JSON.stringify(['👍'.repeat(SPAM_LIMITS.MAX_KEYWORD_LENGTH)]))).toBe(true);
	});
});

describe('validateSpamSettings —— 批量校验', () => {
	beforeEach(createSchema);

	it('全部合法时返回 null', () => {
		expect(
			validateSpamSettings({
				comment_spam_keywords: '["加微信"]',
				comment_spam_max_links: '3',
				comment_spam_min_length: '0',
				comment_spam_duplicate_window: '10',
			})
		).toBeNull();
	});

	it('返回首个错误信息（与 Node/Go 文案一致）', () => {
		expect(validateSpamSettings({ comment_spam_max_links: '51' })).toBe(
			'comment_spam_max_links must be an integer between 0 and 50'
		);
		expect(validateSpamSettings({ comment_spam_min_length: 'abc' })).toBe(
			'comment_spam_min_length must be an integer between 0 and 2000'
		);
		expect(validateSpamSettings({ comment_spam_duplicate_window: '10081' })).toBe(
			'comment_spam_duplicate_window must be an integer between 0 and 10080'
		);
		expect(validateSpamSettings({ comment_spam_keywords: '{oops' })).toBe(
			'comment_spam_keywords must be a JSON array of at most 200 non-empty strings'
		);
	});

	it('无关的键不参与校验', () => {
		expect(validateSpamSetting('site_name', '随便')).toBeNull();
	});

	it('SPAM_SETTING_KEYS 覆盖全部四项规则', () => {
		expect([...SPAM_SETTING_KEYS].sort()).toEqual(
			[
				'comment_spam_duplicate_window',
				'comment_spam_keywords',
				'comment_spam_max_links',
				'comment_spam_min_length',
			].sort()
		);
	});
});

describe('getSpamSettings', () => {
	beforeEach(createSchema);

	it('未配置时四项阈值均为 0（不启用任何规则）', async () => {
		const settings = await getSpamSettings(env);
		expect(settings.keywords).toEqual([]);
		expect(settings.maxLinks).toBe(0);
		expect(settings.minLength).toBe(0);
		expect(settings.duplicateWindow).toBe(0);
		// 与导出常量保持一致，避免「默认值」在两处漂移
		expect(SPAM_DEFAULTS).toEqual({ maxLinks: 0, minLength: 0, duplicateWindow: 0 });
	});

	it('读取已配置的阈值并夹取超限值', async () => {
		await seedSettings({
			comment_spam_keywords: '["加微信"]',
			comment_spam_max_links: '7',
			comment_spam_min_length: '0',
			comment_spam_duplicate_window: '99999',
		});

		const settings = await getSpamSettings(env);
		expect(settings.keywords).toEqual(['加微信']);
		expect(settings.maxLinks).toBe(7);
		expect(settings.minLength).toBe(0);
		expect(settings.duplicateWindow).toBe(SPAM_LIMITS.MAX_DUPLICATE_WINDOW_MINUTES);
	});
});

describe('checkCommentSpam —— 含重复检测', () => {
	beforeEach(createSchema);

	const input = { content: '这是一条正常的评论', author: '访客', url: '', ip: '203.0.113.9' };

	it('默认配置（全部为 0）下短正文与多链接都放行', async () => {
		expect(await checkCommentSpam(env, { ...input, content: '好文' })).toBeNull();
		expect(
			await checkCommentSpam(env, {
				...input,
				content: 'https://a.com https://b.com https://c.com https://d.com https://e.com',
			})
		).toBeNull();
	});

	it('未命中任何规则返回 null', async () => {
		expect(await checkCommentSpam(env, input)).toBeNull();
	});

	it('命中关键词返回原因', async () => {
		await seedSettings({ comment_spam_keywords: '["加微信"]' });
		expect(await checkCommentSpam(env, { ...input, content: '快来加微信' })).toBe('keyword:加微信');
	});

	it('同一 IP 在时间窗内的相同正文返回重复原因', async () => {
		await seedSettings({ comment_spam_duplicate_window: '10' });
		await seedComment({
			post_slug: '/posts/dup',
			content_text: input.content,
			ip_address: input.ip,
			pub_date: Date.now() - 60_000,
			status: 'approved',
		});
		expect(await checkCommentSpam(env, input)).toBe('duplicate:10m');
	});

	it('时间窗外的相同正文不算重复', async () => {
		await seedSettings({ comment_spam_duplicate_window: '10' });
		await seedComment({
			post_slug: '/posts/dup',
			content_text: input.content,
			ip_address: input.ip,
			pub_date: Date.now() - 11 * 60_000,
			status: 'approved',
		});
		expect(await checkCommentSpam(env, input)).toBeNull();
	});

	it('其他 IP 的相同正文不算重复', async () => {
		await seedSettings({ comment_spam_duplicate_window: '10' });
		await seedComment({
			post_slug: '/posts/dup',
			content_text: input.content,
			ip_address: '203.0.113.200',
			pub_date: Date.now() - 60_000,
			status: 'approved',
		});
		expect(await checkCommentSpam(env, input)).toBeNull();
	});

	it('窗口为 0（默认）时不做重复检测', async () => {
		await seedSettings({ comment_spam_duplicate_window: '0' });
		await seedComment({
			post_slug: '/posts/dup',
			content_text: input.content,
			ip_address: input.ip,
			pub_date: Date.now() - 60_000,
			status: 'approved',
		});
		expect(await checkCommentSpam(env, input)).toBeNull();
	});

	it('关键词优先于重复检测', async () => {
		await seedSettings({ comment_spam_keywords: '["加微信"]', comment_spam_duplicate_window: '10' });
		await seedComment({
			post_slug: '/posts/dup',
			content_text: '快来加微信',
			ip_address: input.ip,
			pub_date: Date.now() - 60_000,
			status: 'approved',
		});
		expect(await checkCommentSpam(env, { ...input, content: '快来加微信' })).toBe('keyword:加微信');
	});

	it('关键词配置损坏时该规则放行（fail-open）', async () => {
		await seedSettings({ comment_spam_keywords: '{oops' });
		expect(await checkCommentSpam(env, { ...input, content: '随便什么内容都可以' })).toBeNull();
	});
});

describe('纯函数规则的快速自检（完整口径见 vectors/spam-v1）', () => {
	beforeEach(createSchema);

	it('全部阈值关闭时不判垃圾', () => {
		expect(
			evaluateSpamRules({ content: '好', author: 'a', url: '', keywords: [], maxLinks: 0, minLength: 0 })
		).toBeNull();
	});

	it('解析关键词时丢弃非字符串元素', () => {
		expect(parseSpamKeywords('["ok",42,null]')).toEqual(['ok']);
	});

	it('数值解析只在非负整数时才采用', () => {
		expect(parseSpamNumber('12', 3, 50)).toBe(12);
		expect(parseSpamNumber('abc', 3, 50)).toBe(3);
		expect(parseSpamNumber('-1', 3, 50)).toBe(3);
	});

	it('链接统计不重复计算 https://www.', () => {
		expect(countLinks('https://www.a.com')).toBe(1);
		expect(countLinks('www.a.com 与 https://b.com')).toBe(2);
	});
});
