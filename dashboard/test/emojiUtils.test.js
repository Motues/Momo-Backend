import { describe, it, expect, afterEach, vi } from 'vitest';

import {
	DEFAULT_EMOJI_CDN_URL,
	EMOJI_MAX_CDN_URL_LENGTH,
	EMOJI_TYPES,
	checkOwoSource,
	codePointLength,
	normalizeEmojiEnabled,
	validateCdnUrl,
	validateOwoSource,
} from '../src/utils/emoji.js';

/**
 * 后台表情设置页的纯逻辑（契约 v2：启用开关 + OwO 来源地址 + 保存前在线校验）。
 *
 * 口径由 doc/emoji.md 与 doc/vectors/emoji-v2.json 钉死；本文件的样例刻意**自备**，
 * 不与固定向量文件耦合（向量校验的是三端后端，不是面板侧的逻辑）。
 */

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** 造一个假的 fetch 响应 */
const jsonResponse = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

describe('常量', () => {
	it('默认源与长度上限与 doc/emoji.md 一致', () => {
		expect(DEFAULT_EMOJI_CDN_URL).toBe('https://open.motues.top/emoji/owo.json');
		expect(EMOJI_MAX_CDN_URL_LENGTH).toBe(500);
		expect(EMOJI_TYPES).toEqual(['emoji', 'emoticon', 'image']);
	});

	it('按码点计数（😂 算 1 个而不是 2 个）', () => {
		expect(codePointLength('😂')).toBe(1);
		expect('😂'.length).toBe(2); // 对照：UTF-16 码元
		expect(codePointLength('abc')).toBe(3);
		expect(codePointLength('')).toBe(0);
	});
});

describe('normalizeEmojiEnabled', () => {
	it('大小写与空格都能归一化', () => {
		expect(normalizeEmojiEnabled('true')).toBe('true');
		expect(normalizeEmojiEnabled('TRUE')).toBe('true');
		expect(normalizeEmojiEnabled(' True ')).toBe('true');
		expect(normalizeEmojiEnabled('false')).toBe('false');
		expect(normalizeEmojiEnabled(' false ')).toBe('false');
		expect(normalizeEmojiEnabled('False')).toBe('false');
		expect(normalizeEmojiEnabled('FALSE')).toBe('false');
	});

	it('空值与无法识别的值一律返回空串（由调用方 fail-open）', () => {
		expect(normalizeEmojiEnabled('')).toBe('');
		expect(normalizeEmojiEnabled('   ')).toBe('');
		expect(normalizeEmojiEnabled('yes')).toBe('');
		expect(normalizeEmojiEnabled('1')).toBe('');
		expect(normalizeEmojiEnabled('0')).toBe('');
		expect(normalizeEmojiEnabled('on')).toBe('');
		expect(normalizeEmojiEnabled('true false')).toBe('');
		expect(normalizeEmojiEnabled(null)).toBe('');
		expect(normalizeEmojiEnabled(undefined)).toBe('');
	});
});

describe('validateCdnUrl', () => {
	it('空串（等价未配置）通过', () => {
		expect(validateCdnUrl('')).toBe('');
		expect(validateCdnUrl('   ')).toBe('');
	});

	it('默认源、带 group 参数、http 与两侧空格都通过', () => {
		expect(validateCdnUrl(DEFAULT_EMOJI_CDN_URL)).toBe('');
		expect(validateCdnUrl('https://open.motues.top/emoji/owo.json?group=Emoji')).toBe('');
		expect(validateCdnUrl('http://example.com/owo.json')).toBe('');
		expect(validateCdnUrl('HTTPS://Example.COM/OWO.JSON')).toBe('');
		expect(validateCdnUrl('  https://cdn.example.com/owo.json  ')).toBe('');
	});

	it('非 http/https 协议被拒绝', () => {
		expect(validateCdnUrl('ftp://example.com/owo.json')).toContain('http/https');
		expect(validateCdnUrl('javascript:alert(1)')).toContain('http/https');
		expect(validateCdnUrl('data:application/json,{}')).toContain('http/https');
		expect(validateCdnUrl('owo.json')).toContain('http/https');
		expect(validateCdnUrl('//example.com/owo.json')).toContain('http/https');
	});

	it('地址里出现引号或尖括号被拒绝', () => {
		expect(validateCdnUrl('https://cdn.example.com/a"b.json')).not.toBe('');
		expect(validateCdnUrl('https://cdn.example.com/a<b>.json')).not.toBe('');
	});

	it('按码点限制 500：恰好 500 通过，501 被拒绝（😂 也算 1 个）', () => {
		const prefix = 'https://a.com/';
		const exactly = prefix + 'x'.repeat(EMOJI_MAX_CDN_URL_LENGTH - prefix.length);
		expect(codePointLength(exactly)).toBe(EMOJI_MAX_CDN_URL_LENGTH);
		expect(validateCdnUrl(exactly)).toBe('');

		const tooLong = `${exactly}x`;
		expect(validateCdnUrl(tooLong)).toContain(String(EMOJI_MAX_CDN_URL_LENGTH));
		expect(validateCdnUrl(prefix + '😂'.repeat(500))).toContain(String(EMOJI_MAX_CDN_URL_LENGTH));
	});
});

describe('validateOwoSource', () => {
	const validTab = {
		type: 'emoticon',
		container: [
			{ icon: 'OωO', text: 'Author: DIYgod' },
			{ icon: '|´・ω・)ノ', text: 'Hi' },
		],
	};

	it('合法多标签：tabs 与 items 都统计合格标签', () => {
		const result = validateOwoSource({
			Emoji: { type: 'emoji', container: [{ icon: '😂' }, { icon: '😀', text: 'grin' }] },
			颜文字: validTab,
		});
		expect(result).toEqual({ ok: true, tabs: 2, items: 4 });
	});

	it('type 缺省合法（按 image 处理）', () => {
		expect(validateOwoSource({ 我的表情: { container: [{ icon: '<img src="https://a.com/x.png">' }] } })).toEqual({
			ok: true,
			tabs: 1,
			items: 1,
		});
	});

	it('顶层不是对象时给出形状错误', () => {
		expect(validateOwoSource([{ icon: '😂' }])).toEqual({
			ok: false,
			reason: expect.stringContaining('顶层'),
		});
		expect(validateOwoSource('owo').ok).toBe(false);
		expect(validateOwoSource(null).ok).toBe(false);
		expect(validateOwoSource(42).ok).toBe(false);
	});

	it('顶层是空对象 → 没有任何可用标签', () => {
		expect(validateOwoSource({})).toEqual({ ok: false, reason: '没有可用的标签' });
	});

	it('标签的值不是对象', () => {
		const result = validateOwoSource({ 坏标签: 'not-a-pack' });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('标签「坏标签」');
	});

	it('container 不是数组', () => {
		const result = validateOwoSource({ Emoji: { type: 'emoji', container: { icon: '😂' } } });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('标签「Emoji」的 container 不是数组');
	});

	it('第 2 项缺少 icon（也覆盖空串与空白 icon）', () => {
		const result = validateOwoSource({ Emoji: { container: [{ icon: '😂' }, { text: 'oops' }] } });
		expect(result).toEqual({ ok: false, reason: '标签「Emoji」第 2 项缺少 icon' });

		expect(validateOwoSource({ Emoji: { container: [{ icon: '   ' }] } }).reason).toContain('缺少 icon');
		expect(validateOwoSource({ Emoji: { container: [{ icon: 1 }] } }).reason).toContain('缺少 icon');
	});

	it('项不是对象', () => {
		const result = validateOwoSource({ Emoji: { container: ['😂'] } });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('标签「Emoji」第 1 项不是对象');
	});

	it('type 非法', () => {
		const result = validateOwoSource({ Emoji: { type: 'sticker', container: [{ icon: '😂' }] } });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('标签「Emoji」的 type 不支持');
	});

	it('container 是空数组仍算合格标签（第 4 节的清单不要求至少 1 项）', () => {
		expect(validateOwoSource({ 空标签: { container: [] } })).toEqual({ ok: true, tabs: 1, items: 0 });
	});

	it('全部标签都不合格 → ok:false，并给出第一条原因', () => {
		const allBad = validateOwoSource({
			二: { container: 'nope' },
			三: { container: [{ icon: '' }] },
		});
		expect(allBad).toEqual({ ok: false, reason: '标签「二」的 container 不是数组' });
	});

	it('坏标签被忽略，好标签照常统计', () => {
		const result = validateOwoSource({
			坏的: { container: null },
			好的: { type: 'emoji', container: [{ icon: '😂' }] },
		});
		expect(result).toEqual({ ok: true, tabs: 1, items: 1 });
	});
});

describe('checkOwoSource（在线校验）', () => {
	const owo = {
		颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }, { icon: '(๑•̀ㅂ•́)و✧' }] },
		Emoji: { type: 'emoji', container: [{ icon: '😂' }, { icon: '😀' }, { icon: '🎉' }] },
	};

	it('200 + 合法 owo.json → ok，带 Accept 头与 AbortSignal', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(owo));
		const result = await checkOwoSource('https://cdn.example.com/owo.json', fetchImpl);

		expect(result).toEqual({ status: 'ok', tabs: 2, items: 5 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, options] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://cdn.example.com/owo.json');
		expect(options.headers.Accept).toBe('application/json');
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it('200 但不是合法 JSON → invalid（JSON 解析失败不算拉取失败）', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse('<!doctype html><html>nope</html>'));
		const result = await checkOwoSource('https://cdn.example.com/owo.json', fetchImpl);
		expect(result.status).toBe('invalid');
		expect(result.reason).toContain('JSON');
	});

	it('200 但形状不对 → invalid，并带上具体原因', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse([{ icon: '😂' }]));
		const result = await checkOwoSource('https://cdn.example.com/owo.json', fetchImpl);
		expect(result.status).toBe('invalid');
		expect(result.reason).toContain('顶层');
	});

	it('非 2xx → unreachable', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse('oops', 500));
		const result = await checkOwoSource('https://cdn.example.com/owo.json', fetchImpl);
		expect(result.status).toBe('unreachable');
		expect(result.reason).toContain('500');

		const notFound = vi.fn(async () => jsonResponse('', 404));
		expect((await checkOwoSource('https://cdn.example.com/owo.json', notFound)).status).toBe('unreachable');
	});

	it('fetch 抛错（网络 / 跨域被拦）→ unreachable', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		const result = await checkOwoSource('https://cdn.example.com/owo.json', fetchImpl);
		expect(result.status).toBe('unreachable');
		expect(result.reason).toContain('Failed to fetch');
	});

	it('没有 fetch 实现时不抛错，按 unreachable 处理', async () => {
		vi.stubGlobal('fetch', undefined);
		const result = await checkOwoSource('https://cdn.example.com/owo.json');
		expect(result.status).toBe('unreachable');
	});

	it('地址为空 → unreachable，不去 fetch', async () => {
		const fetchImpl = vi.fn();
		const result = await checkOwoSource('   ', fetchImpl);
		expect(result.status).toBe('unreachable');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('8 秒超时后中断请求并返回 unreachable', async () => {
		vi.useFakeTimers();
		const fetchImpl = (_url, { signal }) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')));
			});

		const pending = checkOwoSource('https://cdn.example.com/owo.json', fetchImpl);
		await vi.advanceTimersByTimeAsync(8000);
		const result = await pending;

		expect(result.status).toBe('unreachable');
		expect(result.reason).toContain('aborted');
	});
});
