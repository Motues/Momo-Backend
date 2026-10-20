import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/emoji-v3.json';
import {
	DEFAULT_EMOJI_CDN_URL,
	DEFAULT_EMOJI_ENABLED,
	MAX_EMOJI_CDN_URL_LENGTH,
	MAX_EMOJI_CDN_URLS,
	EMOJI_CDN_URLS_ERRORS,
	parseEmojiCdnUrlsRead,
	resolveEmojiSettings,
	validateEmojiCdnUrls,
} from '../../src/utils/emoji';

/**
 * 表情配置契约 v3（多来源）的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里没有文件系统，vitest 会把 JSON 打包进来。
 * v2 的单来源 fixture 由 vectors.emoji-v2.test.ts 继续覆盖（旧键仍兼容）。
 */

describe('vectors/emoji-v3 — 常量与错误文案', () => {
	it('默认源 / 默认开关 / 上限与 fixture 完全一致', () => {
		expect(DEFAULT_EMOJI_CDN_URL).toBe(fixture.defaults.cdnUrl);
		expect(DEFAULT_EMOJI_ENABLED).toBe(fixture.defaults.enabled);
		expect(MAX_EMOJI_CDN_URL_LENGTH).toBe(fixture.limits.maxCdnUrlLen);
		expect(MAX_EMOJI_CDN_URLS).toBe(fixture.limits.maxCdnUrls);
	});

	it('五条错误文案逐字一致', () => {
		expect(EMOJI_CDN_URLS_ERRORS).toEqual(fixture.errors);
	});
});

describe('vectors/emoji-v3 — emoji_cdn_urls 写入校验', () => {
	for (const testCase of fixture.cdnUrls.valid) {
		it(`合法：${JSON.stringify(testCase.value)?.slice(0, 60)}`, () => {
			const result = validateEmojiCdnUrls(testCase.value);
			expect(result.error).toBeNull();
			expect(result.urls).toEqual(testCase.expect);
			// 写入路径存的就是归一化后的 JSON 数组
			expect(JSON.parse(JSON.stringify(result.urls))).toEqual(testCase.expect);
		});
	}

	for (const testCase of fixture.cdnUrls.invalid) {
		it(`非法（${testCase.error}）：${String(testCase.value).slice(0, 60)}`, () => {
			const result = validateEmojiCdnUrls(testCase.value);
			expect(result.error).toBe(
				(fixture.errors as Record<string, string>)[testCase.error]
			);
		});
	}

	it('null / undefined 视为未提供，不报错（写入路径会跳过它们）', () => {
		expect(validateEmojiCdnUrls(null)).toEqual({ error: null, urls: [] });
		expect(validateEmojiCdnUrls(undefined)).toEqual({ error: null, urls: [] });
	});

	it('合法值归一化：trim 两侧空格、丢弃空串、保持顺序', () => {
		const result = validateEmojiCdnUrls(
			'["  https://a.example.com/owo.json  ", "", "   ", "https://b.example.com/owo.json"]'
		);
		expect(result.error).toBeNull();
		expect(result.urls).toEqual([
			'https://a.example.com/owo.json',
			'https://b.example.com/owo.json',
		]);
	});

	it('长度按码点计算（不是 UTF-16 码元），500 码点恰好通过', () => {
		const prefix = 'https://子.example.com/';
		const exact = prefix + '字'.repeat(MAX_EMOJI_CDN_URL_LENGTH - [...prefix].length);
		expect([...exact].length).toBe(MAX_EMOJI_CDN_URL_LENGTH);
		expect(validateEmojiCdnUrls(JSON.stringify([exact])).error).toBeNull();
		expect(validateEmojiCdnUrls(JSON.stringify([`${exact}字`])).error).toBe(
			EMOJI_CDN_URLS_ERRORS.tooLong
		);
	});
});

describe('vectors/emoji-v3 — emoji_cdn_urls 读取解析（宽容）', () => {
	it('空 / 空白 / 坏 JSON / 非数组 → 空数组', () => {
		for (const value of [null, undefined, '', '   ', 'not json', '{}', '"url"', '123']) {
			expect(parseEmojiCdnUrlsRead(value), String(value)).toEqual([]);
		}
	});

	it('非字符串项丢弃、空串丢弃、顺序保持', () => {
		expect(
			parseEmojiCdnUrlsRead('["", 7, "https://a.example.com/owo.json", null, "  ", "https://b.example.com/owo.json"]')
		).toEqual(['https://a.example.com/owo.json', 'https://b.example.com/owo.json']);
	});

	it('超过 5 个只取前 5 个', () => {
		const six = JSON.stringify([
			'https://a.example.com/owo.json',
			'https://b.example.com/owo.json',
			'https://c.example.com/owo.json',
			'https://d.example.com/owo.json',
			'https://e.example.com/owo.json',
			'https://f.example.com/owo.json',
		]);
		expect(parseEmojiCdnUrlsRead(six)).toHaveLength(MAX_EMOJI_CDN_URLS);
		expect(parseEmojiCdnUrlsRead(six)[4]).toBe('https://e.example.com/owo.json');
	});
});

describe('vectors/emoji-v3 — 读取归一化 resolve', () => {
	for (const testCase of fixture.resolve) {
		it(testCase.name, () => {
			const resolved = resolveEmojiSettings(
				testCase.storedUrls,
				testCase.storedCdnUrl,
				testCase.storedEnabled
			);
			expect(resolved.urls).toEqual(testCase.expectUrls);
			expect(resolved.enabled).toBe(testCase.expectEnabled);
			// 旧前端字段 = 数组第一个地址
			expect(resolved.url).toBe(testCase.expectUrls[0]);
		});
	}

	it('存储为 null / undefined 时回落默认源 + 启用', () => {
		expect(resolveEmojiSettings(null, null, null)).toEqual({
			urls: [DEFAULT_EMOJI_CDN_URL],
			url: DEFAULT_EMOJI_CDN_URL,
			enabled: 'true',
		});
		expect(resolveEmojiSettings(undefined, undefined, undefined)).toEqual({
			urls: [DEFAULT_EMOJI_CDN_URL],
			url: DEFAULT_EMOJI_CDN_URL,
			enabled: 'true',
		});
	});

	it('只关心开关："false" 以外的任何取值都 fail-open 为启用（关闭时地址照常下发）', () => {
		for (const value of ['', '   ', 'true', 'TRUE', 'yes', '0', 'No', undefined]) {
			const resolved = resolveEmojiSettings('["https://a.example.com/owo.json"]', '', value);
			expect(resolved.enabled, String(value)).toBe('true');
			expect(resolved.urls).toEqual(['https://a.example.com/owo.json']);
		}
		for (const value of ['false', 'FALSE', ' False ']) {
			const resolved = resolveEmojiSettings('["https://a.example.com/owo.json"]', '', value);
			expect(resolved.enabled, String(value)).toBe('false');
			expect(resolved.urls).toEqual(['https://a.example.com/owo.json']);
		}
	});
});
