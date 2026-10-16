import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/emoji-v2.json';
import {
	DEFAULT_EMOJI_CDN_URL,
	DEFAULT_EMOJI_ENABLED,
	MAX_EMOJI_CDN_URL_LENGTH,
	normalizeEmojiEnabled,
	resolveEmojiConfig,
	validateEmojiCdnUrl,
	validateEmojiEnabled,
} from '../../src/utils/emoji';

/**
 * 表情配置契约 v2 的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里没有文件系统，vitest 会把 JSON 打包进来。
 * v1 的「自定义表情包」载荷向量已随契约整体删除。
 */

describe('vectors/emoji-v2 — 常量', () => {
	it('默认源 / 默认开关 / 长度上限与 fixture 完全一致', () => {
		expect(DEFAULT_EMOJI_CDN_URL).toBe(fixture.defaults.cdnUrl);
		expect(DEFAULT_EMOJI_ENABLED).toBe(fixture.defaults.enabled);
		expect(MAX_EMOJI_CDN_URL_LENGTH).toBe(fixture.limits.maxCdnUrlLen);
	});
});

describe('vectors/emoji-v2 — emoji_cdn_url 写入校验', () => {
	for (const value of fixture.cdnUrl.valid) {
		it(`合法：${JSON.stringify(value.slice(0, 60))}`, () => {
			expect(validateEmojiCdnUrl(value)).toBeNull();
		});
	}

	for (const value of fixture.cdnUrl.invalid) {
		it(`非法：${value.slice(0, 60)}`, () => {
			expect(validateEmojiCdnUrl(value)).not.toBeNull();
		});
	}

	it('null / undefined 视为未提供，不报错（写入路径会跳过它们）', () => {
		expect(validateEmojiCdnUrl(null)).toBeNull();
		expect(validateEmojiCdnUrl(undefined)).toBeNull();
	});

	it('超长时消息与文案固定', () => {
		const tooLong = `https://cdn.example.com/${'a'.repeat(MAX_EMOJI_CDN_URL_LENGTH)}`;
		expect(validateEmojiCdnUrl(tooLong)).toBe(`emoji_cdn_url 不能超过 ${MAX_EMOJI_CDN_URL_LENGTH} 个字符`);
	});

	it('长度按码点计算（不是 UTF-16 码元），500 码点恰好通过', () => {
		const prefix = 'https://子.example.com/';
		const exact = prefix + '字'.repeat(MAX_EMOJI_CDN_URL_LENGTH - prefix.length);
		expect([...exact].length).toBe(MAX_EMOJI_CDN_URL_LENGTH);
		expect(validateEmojiCdnUrl(exact)).toBeNull();
		expect(validateEmojiCdnUrl(`${exact}字`)).not.toBeNull();
	});
});

describe('vectors/emoji-v2 — emoji_enabled 写入校验', () => {
	for (const value of fixture.enabled.valid) {
		it(`合法：${JSON.stringify(value)}`, () => {
			expect(validateEmojiEnabled(value)).toBeNull();
			// 归一化后只会是 "" / "true" / "false"，写入落库的就是这个值
			expect(['', 'true', 'false']).toContain(normalizeEmojiEnabled(value));
		});
	}

	for (const value of fixture.enabled.invalid) {
		it(`非法：${JSON.stringify(value)}`, () => {
			expect(validateEmojiEnabled(value)).toBe('emoji_enabled 只能是 true 或 false');
		});
	}

	it('归一化口径：trim + 转小写', () => {
		expect(normalizeEmojiEnabled(' TRUE ')).toBe('true');
		expect(normalizeEmojiEnabled('False')).toBe('false');
		expect(normalizeEmojiEnabled('   ')).toBe('');
	});

	it('null / undefined 视为未提供，不报错（写入路径会跳过它们）', () => {
		expect(validateEmojiEnabled(null)).toBeNull();
		expect(validateEmojiEnabled(undefined)).toBeNull();
	});
});

describe('vectors/emoji-v2 — 读取归一化 resolve', () => {
	for (const testCase of fixture.resolve) {
		it(testCase.name, () => {
			expect(resolveEmojiConfig(testCase.storedUrl, testCase.storedEnabled)).toEqual({
				url: testCase.expectUrl,
				enabled: testCase.expectEnabled,
			});
		});
	}

	it('存储为 null / undefined 时回落默认源 + 启用', () => {
		expect(resolveEmojiConfig(null, null)).toEqual({ url: DEFAULT_EMOJI_CDN_URL, enabled: 'true' });
		expect(resolveEmojiConfig(undefined, undefined)).toEqual({ url: DEFAULT_EMOJI_CDN_URL, enabled: 'true' });
	});

	it('只关心开关："false" 以外的任何取值都 fail-open 为启用', () => {
		for (const value of ['', '   ', 'true', 'TRUE', 'yes', '0', 'No', undefined]) {
			expect(resolveEmojiConfig('https://cdn.example.com/owo.json', value).enabled, String(value)).toBe('true');
		}
		for (const value of ['false', 'FALSE', ' False ']) {
			expect(resolveEmojiConfig('https://cdn.example.com/owo.json', value).enabled, String(value)).toBe('false');
		}
	});
});
