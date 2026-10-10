import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/sanitize-v2.json';
import {
	checkContent,
	sanitizePostSlug,
	countCodePoints,
	truncateCodePoints,
	MAX_POST_SLUG,
} from '../../src/utils/security';

/**
 * 文章标识「净化 + 截断」的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * post_slug 会被签进挑战载荷，三端的净化与截断口径必须完全一致，否则会出现
 * 「同一篇文章的挑战兑换自己的票据却被拒」或「签出的票据永远兑不掉」的假失败。
 *
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里，没有文件系统；
 * vitest 会把 JSON 打包进来。
 */

/** 是否存在未配对的代理项（码点截断绝不能切出这种字符串） */
function hasLoneSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

describe('sanitize 固定向量 —— checkContent 口径', () => {
	it('fixture 结构与常量一致', () => {
		expect(fixture.maxPostSlug).toBe(MAX_POST_SLUG);
		expect(fixture.checkContent.length).toBeGreaterThan(0);
		expect(fixture.sanitizePostSlug.length).toBeGreaterThan(0);
	});

	for (const testCase of fixture.checkContent) {
		it(testCase.name, () => {
			expect(checkContent(testCase.input)).toBe(testCase.output);
		});
	}
});

describe('sanitize 固定向量 —— 净化 + 按码点截断', () => {
	for (const testCase of fixture.sanitizePostSlug) {
		it(testCase.name, () => {
			const actual = sanitizePostSlug(testCase.input);
			expect(actual).toBe(testCase.output);
			expect(countCodePoints(actual)).toBeLessThanOrEqual(MAX_POST_SLUG);
			expect(hasLoneSurrogate(actual)).toBe(false);
		});
	}

	it('截断按码点而非 UTF-16 码元：emoji 不会被切坏', () => {
		const input = 'a'.repeat(199) + '😀';
		const output = sanitizePostSlug(input);
		expect(output).toBe(input);
		expect(output.length).toBe(201); // 码元数确实超过 200
		expect(countCodePoints(output)).toBe(200);
		expect(hasLoneSurrogate(output)).toBe(false);
	});

	it('countCodePoints 与 truncateCodePoints 自洽', () => {
		for (const value of ['', 'abc', '中文', '😀', 'a😀b', '😀'.repeat(5)]) {
			expect(countCodePoints(value)).toBe(Array.from(value).length);
		}
		expect(truncateCodePoints('a😀b', 2)).toBe('a😀');
		expect(truncateCodePoints('a😀b', 0)).toBe('');
		expect(truncateCodePoints('abc', 99)).toBe('abc');
	});
});
