import { describe, it, expect, afterEach, vi } from 'vitest';

import {
	DEFAULT_EMOJI_CDN_URL,
	EMOJI_MAX_CDN_URL_LENGTH,
	EMOJI_MAX_CDN_URLS,
	EMOJI_SOURCE_DUPLICATE,
	EMOJI_SOURCE_INVALID,
	EMOJI_TOO_MANY_SOURCES,
	EMOJI_TYPES,
	addEmojiCdnUrl,
	checkOwoSource,
	codePointLength,
	formatCdnUrlText,
	normalizeEmojiEnabled,
	parseCdnUrlText,
	parseEmojiCdnUrls,
	resolveEmojiCdnUrls,
	validateCdnUrl,
	validateCdnUrls,
	validateOwoSource,
} from '../src/utils/emoji.js';

/**
 * 后台表情设置页的纯逻辑（契约 v3：启用开关 + 一组 OwO 来源地址 + 保存前在线校验）。
 *
 * 口径由 doc/emoji.md 与 doc/vectors/emoji-v3.json 钉死；本文件的样例刻意**自备**，
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
	it('默认源、长度上限与来源个数上限与 doc/emoji.md 一致', () => {
		expect(DEFAULT_EMOJI_CDN_URL).toBe('https://open.motues.top/emoji/owo.json');
		expect(EMOJI_MAX_CDN_URL_LENGTH).toBe(500);
		expect(EMOJI_MAX_CDN_URLS).toBe(5);
		expect(EMOJI_TYPES).toEqual(['emoji', 'emoticon', 'image']);
	});

	it('按码点计数（😂 算 1 个而不是 2 个）', () => {
		expect(codePointLength('😂')).toBe(1);
		expect('😂'.length).toBe(2); // 对照：UTF-16 码元
		expect(codePointLength('abc')).toBe(3);
		expect(codePointLength('')).toBe(0);
	});

	it('列表编辑器的提示文案', () => {
		expect(EMOJI_SOURCE_INVALID).toBe('请输入合法的 http/https 地址');
		expect(EMOJI_SOURCE_DUPLICATE).toBe('该地址已在列表中');
		expect(EMOJI_TOO_MANY_SOURCES).toBe('最多只能配置 5 个表情来源');
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

describe('parseEmojiCdnUrls（读取路径，宽容）', () => {
	it('空值 / 非法 JSON / 不是数组 → []', () => {
		expect(parseEmojiCdnUrls('')).toEqual([]);
		expect(parseEmojiCdnUrls('   ')).toEqual([]);
		expect(parseEmojiCdnUrls(null)).toEqual([]);
		expect(parseEmojiCdnUrls(undefined)).toEqual([]);
		expect(parseEmojiCdnUrls('not json')).toEqual([]);
		expect(parseEmojiCdnUrls('{}')).toEqual([]);
		expect(parseEmojiCdnUrls('"https://a.example.com/owo.json"')).toEqual([]);
		expect(parseEmojiCdnUrls('123')).toEqual([]);
	});

	it('trim 后去空、保持顺序', () => {
		expect(parseEmojiCdnUrls('["  https://a.example.com/owo.json  "]')).toEqual([
			'https://a.example.com/owo.json',
		]);
		expect(parseEmojiCdnUrls('["", "   "]')).toEqual([]);
		expect(
			parseEmojiCdnUrls('["https://a.example.com/owo.json", "", "https://b.example.com/owo.json?group=Emoji"]'),
		).toEqual(['https://a.example.com/owo.json', 'https://b.example.com/owo.json?group=Emoji']);
	});

	it('非字符串项丢弃（读取路径刻意比写入路径宽松）', () => {
		expect(
			parseEmojiCdnUrls('["", 7, "https://a.example.com/owo.json", null, "  ", "https://b.example.com/owo.json"]'),
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
		expect(parseEmojiCdnUrls(six)).toEqual([
			'https://a.example.com/owo.json',
			'https://b.example.com/owo.json',
			'https://c.example.com/owo.json',
			'https://d.example.com/owo.json',
			'https://e.example.com/owo.json',
		]);
	});
});

describe('resolveEmojiCdnUrls（回落链）', () => {
	it('数组已配置 → 原样下发（旧键被忽略）', () => {
		expect(resolveEmojiCdnUrls('["https://a.example.com/owo.json"]', 'https://legacy.example.com/owo.json')).toEqual([
			'https://a.example.com/owo.json',
		]);
	});

	it('数组为空 / 脏值 → 回落旧键（trim）', () => {
		expect(resolveEmojiCdnUrls('[]', '  https://legacy.example.com/owo.json  ')).toEqual([
			'https://legacy.example.com/owo.json',
		]);
		expect(resolveEmojiCdnUrls('not json', 'https://legacy.example.com/owo.json')).toEqual([
			'https://legacy.example.com/owo.json',
		]);
	});

	it('两者都为空 → 默认源', () => {
		expect(resolveEmojiCdnUrls('', '')).toEqual([DEFAULT_EMOJI_CDN_URL]);
		expect(resolveEmojiCdnUrls(undefined, undefined)).toEqual([DEFAULT_EMOJI_CDN_URL]);
		expect(resolveEmojiCdnUrls('[]', '   ')).toEqual([DEFAULT_EMOJI_CDN_URL]);
	});
});

describe('parseCdnUrlText / formatCdnUrlText', () => {
	it('按行拆分、trim、丢弃空行', () => {
		expect(parseCdnUrlText('  https://a.example.com/owo.json  \n\nhttps://b.example.com/owo.json\n   ')).toEqual([
			'https://a.example.com/owo.json',
			'https://b.example.com/owo.json',
		]);
		expect(parseCdnUrlText('')).toEqual([]);
		expect(parseCdnUrlText('   \n  \r\n ')).toEqual([]);
	});

	it('CRLF 也能正确拆分', () => {
		expect(parseCdnUrlText('https://a.example.com/owo.json\r\nhttps://b.example.com/owo.json')).toEqual([
			'https://a.example.com/owo.json',
			'https://b.example.com/owo.json',
		]);
	});

	it('与 formatCdnUrlText 互逆', () => {
		const list = ['https://a.example.com/owo.json', 'https://b.example.com/owo.json'];
		expect(parseCdnUrlText(formatCdnUrlText(list))).toEqual(list);
		expect(formatCdnUrlText([])).toBe('');
	});
});

describe('validateCdnUrls（写入路径，严格）', () => {
	it('空列表与合法列表通过', () => {
		expect(validateCdnUrls([])).toBe('');
		expect(validateCdnUrls([DEFAULT_EMOJI_CDN_URL])).toBe('');
		expect(validateCdnUrls(['http://a.example.com/owo.json', 'https://b.example.com/owo.json'])).toBe('');
		expect(validateCdnUrls([DEFAULT_EMOJI_CDN_URL, DEFAULT_EMOJI_CDN_URL])).toBe('');
	});

	it('超过 5 个 → 最多只能配置 5 个表情来源', () => {
		const six = Array.from({ length: 6 }, (_, index) => `https://s${index}.example.com/owo.json`);
		expect(validateCdnUrls(six)).toBe('最多只能配置 5 个表情来源');
		expect(EMOJI_TOO_MANY_SOURCES).toBe('最多只能配置 5 个表情来源');
	});

	it('第一条非法 → 单条时直接给出原因，多条时带行号', () => {
		expect(validateCdnUrls(['ftp://a.example.com/owo.json'])).toBe('只允许 http/https 地址');
		expect(validateCdnUrls([DEFAULT_EMOJI_CDN_URL, 'ftp://a.example.com/owo.json'])).toBe(
			'第 2 条：只允许 http/https 地址',
		);
	});

	it('也能直接吃多行文本', () => {
		expect(validateCdnUrls('https://a.example.com/owo.json\njavascript:alert(1)')).toBe(
			'第 2 条：只允许 http/https 地址',
		);
	});
});

describe('addEmojiCdnUrl（列表编辑器：校验 + 去重 + 上限）', () => {
	it('合法地址 → 返回新数组（原数组不变）', () => {
		const list = [DEFAULT_EMOJI_CDN_URL];
		const result = addEmojiCdnUrl(list, 'https://a.example.com/owo.json');

		expect(result.error).toBe('');
		expect(result.list).toEqual([DEFAULT_EMOJI_CDN_URL, 'https://a.example.com/owo.json']);
		expect(result.list).not.toBe(list);
		expect(list).toEqual([DEFAULT_EMOJI_CDN_URL]);
	});

	it('两侧空格被 trim 后再入列表', () => {
		const result = addEmojiCdnUrl([], '  https://a.example.com/owo.json  ');
		expect(result.list).toEqual(['https://a.example.com/owo.json']);
		expect(result.error).toBe('');
	});

	it('空输入 → 原样返回、无错误（调用方自行决定是否清空输入框）', () => {
		const list = [DEFAULT_EMOJI_CDN_URL];
		expect(addEmojiCdnUrl(list, '')).toEqual({ list, error: '' });
		expect(addEmojiCdnUrl(list, '   ')).toEqual({ list, error: '' });
		expect(addEmojiCdnUrl(list, null)).toEqual({ list, error: '' });
		expect(addEmojiCdnUrl([], undefined)).toEqual({ list: [], error: '' });
	});

	it('非数组列表按空列表处理', () => {
		expect(addEmojiCdnUrl(null, 'https://a.example.com/owo.json')).toEqual({
			list: ['https://a.example.com/owo.json'],
			error: '',
		});
	});

	it('非法地址 → 请输入合法的 http/https 地址', () => {
		expect(addEmojiCdnUrl([], 'javascript:alert(1)')).toEqual({ list: [], error: EMOJI_SOURCE_INVALID });
		expect(addEmojiCdnUrl([], 'owo.json').error).toBe(EMOJI_SOURCE_INVALID);
		expect(addEmojiCdnUrl([], 'ftp://a.example.com/owo.json').error).toBe(EMOJI_SOURCE_INVALID);
	});

	it('超长地址沿用 validateCdnUrl 的具体文案', () => {
		const tooLong = `https://a.com/${'x'.repeat(EMOJI_MAX_CDN_URL_LENGTH)}`;
		expect(addEmojiCdnUrl([], tooLong).error).toBe(`地址不能超过 ${EMOJI_MAX_CDN_URL_LENGTH} 个字符`);
	});

	it('重复（trim 后精确匹配）→ 该地址已在列表中，且区分大小写之外的差异', () => {
		const list = [DEFAULT_EMOJI_CDN_URL];
		expect(addEmojiCdnUrl(list, DEFAULT_EMOJI_CDN_URL)).toEqual({ list, error: EMOJI_SOURCE_DUPLICATE });
		expect(addEmojiCdnUrl(list, `  ${DEFAULT_EMOJI_CDN_URL}  `).error).toBe(EMOJI_SOURCE_DUPLICATE);
		// 大小写不同视为不同地址（与读取路径一致，不做归一化）
		expect(addEmojiCdnUrl(list, DEFAULT_EMOJI_CDN_URL.toUpperCase()).error).toBe('');
	});

	it('列表里带空格的旧数据也算重复', () => {
		expect(addEmojiCdnUrl([`  ${DEFAULT_EMOJI_CDN_URL}  `], DEFAULT_EMOJI_CDN_URL).error).toBe(
			EMOJI_SOURCE_DUPLICATE,
		);
	});

	it('已达 5 个 → 最多只能配置 5 个表情来源', () => {
		const full = Array.from({ length: EMOJI_MAX_CDN_URLS }, (_, index) => `https://s${index}.example.com/owo.json`);
		expect(addEmojiCdnUrl(full, 'https://one-more.example.com/owo.json')).toEqual({
			list: full,
			error: EMOJI_TOO_MANY_SOURCES,
		});
		// 4 个时还能加第 5 个
		expect(addEmojiCdnUrl(full.slice(0, 4), 'https://five.example.com/owo.json').error).toBe('');
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

describe('checkOwoSource（在线校验，多地址）', () => {
	const owo = {
		颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }, { icon: '(๑•̀ㅂ•́)و✧' }] },
		Emoji: { type: 'emoji', container: [{ icon: '😂' }, { icon: '😀' }, { icon: '🎉' }] },
	};

	it('单条合法 owo.json → ok，带 Accept 头与 AbortSignal', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(owo));
		const result = await checkOwoSource('https://cdn.example.com/owo.json', fetchImpl);

		expect(result).toEqual({ status: 'ok', sources: 1, tabs: 2, items: 5 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, options] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://cdn.example.com/owo.json');
		expect(options.headers.Accept).toBe('application/json');
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it('多条全部通过 → sources/tabs/items 是各来源之和', async () => {
		const fetchImpl = vi.fn(async (url) =>
			url.includes('one') ? jsonResponse({ A: { container: [{ icon: '😂' }] } }) : jsonResponse(owo),
		);
		const result = await checkOwoSource(['https://one/owo.json', 'https://two/owo.json'], fetchImpl);

		expect(result).toEqual({ status: 'ok', sources: 2, tabs: 3, items: 6 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(['https://one/owo.json', 'https://two/owo.json']);
	});

	it('某条拉取成功但不是 owo.json → invalid + 1 起下标 + 原因', async () => {
		const fetchImpl = vi.fn(async (url) =>
			url.includes('bad') ? jsonResponse([{ icon: '😂' }]) : jsonResponse(owo),
		);
		const result = await checkOwoSource(['https://ok/owo.json', 'https://bad/owo.json'], fetchImpl);

		expect(result.status).toBe('invalid');
		expect(result.index).toBe(2);
		expect(result.reason).toContain('顶层');
	});

	it('不是合法 JSON 也算 invalid（JSON 解析失败不算拉取失败）', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse('<!doctype html><html>nope</html>'));
		const result = await checkOwoSource(['https://cdn.example.com/owo.json'], fetchImpl);
		expect(result.status).toBe('invalid');
		expect(result.reason).toContain('JSON');
	});

	it('某条网络 / 跨域失败 → unreachable + 1 起下标（仍可保存）', async () => {
		const fetchImpl = vi.fn(async (url) => {
			if (url.includes('dead')) throw new TypeError('Failed to fetch');
			return jsonResponse(owo);
		});
		const result = await checkOwoSource(['https://dead/owo.json', 'https://ok/owo.json'], fetchImpl);

		expect(result.status).toBe('unreachable');
		expect(result.index).toBe(1);
		expect(result.reason).toContain('Failed to fetch');
	});

	it('既有 invalid 又有 unreachable 时 invalid 优先（它是唯一阻止保存的结果）', async () => {
		const fetchImpl = vi.fn(async (url) => {
			if (url.includes('dead')) throw new TypeError('Failed to fetch');
			if (url.includes('bad')) return jsonResponse([{ icon: '😂' }]);
			return jsonResponse(owo);
		});
		const result = await checkOwoSource(
			['https://dead/owo.json', 'https://bad/owo.json', 'https://ok/owo.json'],
			fetchImpl,
		);

		expect(result.status).toBe('invalid');
		expect(result.index).toBe(2);
	});

	it('非 2xx 也算 unreachable', async () => {
		const notFound = vi.fn(async () => jsonResponse('', 404));
		const result = await checkOwoSource(['https://cdn.example.com/owo.json'], notFound);
		expect(result.status).toBe('unreachable');
		expect(result.reason).toContain('404');
	});

	it('没有 fetch 实现时不抛错，按 unreachable 处理', async () => {
		vi.stubGlobal('fetch', undefined);
		const result = await checkOwoSource(['https://cdn.example.com/owo.json']);
		expect(result.status).toBe('unreachable');
	});

	it('空数组 / 全空白 / 空串 → unreachable(index 0)，不去 fetch', async () => {
		const fetchImpl = vi.fn();
		expect(await checkOwoSource([], fetchImpl)).toMatchObject({ status: 'unreachable', index: 0 });
		expect(await checkOwoSource(['   '], fetchImpl)).toMatchObject({ status: 'unreachable', index: 0 });
		expect(await checkOwoSource('   ', fetchImpl)).toMatchObject({ status: 'unreachable', index: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('8 秒超时后中断请求并返回 unreachable', async () => {
		vi.useFakeTimers();
		const fetchImpl = (_url, { signal }) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')));
			});

		const pending = checkOwoSource(['https://cdn.example.com/owo.json'], fetchImpl);
		await vi.advanceTimersByTimeAsync(8000);
		const result = await pending;

		expect(result.status).toBe('unreachable');
		expect(result.reason).toContain('aborted');
	});
});
