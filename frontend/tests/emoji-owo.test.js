import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	EMOJI_CACHE_PREFIX,
	EMOJI_CACHE_TTL_MS,
	EMOJI_REVALIDATE_MS,
	buildEmojiSet,
	codePointLength,
	containsShortcode,
	emojiCacheNeedsRevalidation,
	findShortcodes,
	fnv1aHex,
	getCachedEmojiSet,
	isEmojiCacheFresh,
	loadDefaultPacks,
	loadEmojiSet,
	mergePacks,
	needsRevalidation,
	normalizeCdnUrls,
	normalizeShortcode,
	readEmojiCache,
	resetEmojiSetCache,
	revalidateEmojiSet,
	safeImageUrl,
	sanitizePacks,
	touchEmojiCache,
	writeEmojiCache,
} from '../src/emoji/owo';

const CDN = 'https://cdn.example.com/emoji/owo.json';
const OTHER_CDN = 'https://other.example.com/owo.json';
const PNG = 'https://cdn.example.com/emoji/doge.png';
const PNG2 = 'https://cdn.example.com/emoji/hi.png';

/** 缓存键 = 整个地址列表的 JSON（doc/emoji.md 第 6 节） */
const listKey = (urls) => JSON.stringify(urls);
/** localStorage 里真正的键（前缀 + 地址列表 JSON） */
const storageKey = (urls) => `${EMOJI_CACHE_PREFIX}${listKey(urls)}`;

/** 简化的 owo.json 形状（`{ 标签: { type, container } }`） */
function owo(packs) {
	return packs;
}

function imageItem(url, text = '') {
	return { icon: `<img src="${url}">`, text };
}

function jsonResponse(body, init = {}) {
	return { ok: true, status: 200, json: async () => body, ...init };
}

/** 记录所有请求的 fetch 替身（与 comments.test.js 同风格） */
function fetchMock(handler) {
	const calls = [];
	const mock = vi.fn(async (url, init) => {
		calls.push({ url, init });
		return handler(url, init, calls.length);
	});
	mock.calls = calls;
	vi.stubGlobal('fetch', mock);
	return mock;
}

beforeEach(() => {
	localStorage.clear();
	resetEmojiSetCache();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('emoji/owo —— 本地缓存读写与 TTL', () => {
	it('写入后能读回，缓存键带前缀与整个地址列表的 JSON', () => {
		const packs = sanitizePacks(owo({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] } }));
		expect(writeEmojiCache(listKey([CDN]), packs, localStorage, 1000)).toBe(true);
		expect(localStorage.getItem(storageKey([CDN]))).toBeTruthy();
		// 键是地址列表本身，不是单个地址
		expect(localStorage.getItem(`${EMOJI_CACHE_PREFIX}${CDN}`)).toBeNull();

		const entry = readEmojiCache(listKey([CDN]), localStorage);
		expect(entry.savedAt).toBe(1000);
		expect(entry.packs).toEqual(packs);
	});

	it('列表顺序不同 / 列表不同 = 不同的缓存（互不命中）', () => {
		const packs = sanitizePacks(owo({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] } }));
		writeEmojiCache(listKey([CDN, OTHER_CDN]), packs, localStorage, 1000);

		expect(readEmojiCache(listKey([CDN, OTHER_CDN]), localStorage)).toBeTruthy();
		expect(readEmojiCache(listKey([OTHER_CDN, CDN]), localStorage)).toBeNull();
		expect(readEmojiCache(listKey([CDN]), localStorage)).toBeNull();
	});

	it('没有缓存 / 地址列表为空 / 存储不可用时读取返回 null', () => {
		expect(readEmojiCache(listKey([CDN]), localStorage)).toBeNull();
		expect(readEmojiCache('', localStorage)).toBeNull();
		expect(readEmojiCache(listKey([CDN]), null)).toBeNull();
		expect(writeEmojiCache('', {}, localStorage)).toBe(false);
		expect(writeEmojiCache(listKey([CDN]), {}, null)).toBe(false);
	});

	it('缓存内容损坏或字段缺失时返回 null（不抛错）', () => {
		localStorage.setItem(storageKey([CDN]), '{不是 JSON');
		expect(readEmojiCache(listKey([CDN]), localStorage)).toBeNull();

		localStorage.setItem(storageKey([CDN]), JSON.stringify({ packs: {} }));
		expect(readEmojiCache(listKey([CDN]), localStorage)).toBeNull();

		localStorage.setItem(storageKey([CDN]), JSON.stringify({ savedAt: 'now', packs: {} }));
		expect(readEmojiCache(listKey([CDN]), localStorage)).toBeNull();
	});

	it('读取缓存时会丢弃结构不合法的项', () => {
		writeEmojiCache(
			listKey([CDN]),
			{
				标签: {
					type: 'image',
					container: [imageItem(PNG, 'doge'), { icon: '' }, { text: '没有 icon' }, 'string'],
				},
				坏标签: 'not-an-object',
			},
			localStorage,
			1000
		);
		const entry = readEmojiCache(listKey([CDN]), localStorage);
		expect(Object.keys(entry.packs)).toEqual(['标签']);
		expect(entry.packs['标签'].container).toEqual([{ icon: `<img src="${PNG}">`, text: 'doge' }]);
	});

	it('7 天 TTL 的边界：差 1 毫秒算新鲜，正好到期算过期', () => {
		const entry = { savedAt: 1000, packs: {} };
		expect(isEmojiCacheFresh(entry, 1000 + EMOJI_CACHE_TTL_MS - 1)).toBe(true);
		expect(isEmojiCacheFresh(entry, 1000 + EMOJI_CACHE_TTL_MS)).toBe(false);
		expect(isEmojiCacheFresh(entry, 999)).toBe(false); // 时钟倒退
		expect(isEmojiCacheFresh(null)).toBe(false);
	});

	it('getCachedEmojiSet 是同步零请求：新鲜缓存直接成集合，过期缓存视为空', async () => {
		const fetch = fetchMock(async () => jsonResponse({}));
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(owo({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] } })), localStorage, now);

		const fresh = getCachedEmojiSet({ cdnUrls: [CDN], storage: localStorage, now: now + 1000 });
		expect(fresh.tabs.map((tab) => tab.label)).toEqual(['颜文字']);
		expect(fresh.tabs[0].items[0].insert).toBe('OωO');

		const expired = getCachedEmojiSet({ cdnUrls: [CDN], storage: localStorage, now: now + EMOJI_CACHE_TTL_MS });
		expect(expired.tabs).toEqual([]);
		expect(expired.images.size).toBe(0);

		expect(getCachedEmojiSet({ cdnUrls: [], storage: localStorage, now }).tabs).toEqual([]);
		await Promise.resolve();
		expect(fetch.calls).toEqual([]);
	});

	it('getCachedEmojiSet 的缓存键是整个列表：列表不同就是空集合', () => {
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(owo({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] } })), localStorage, now);

		expect(getCachedEmojiSet({ cdnUrls: [CDN], storage: localStorage, now }).tabs.map((t) => t.label)).toEqual(['颜文字']);
		expect(getCachedEmojiSet({ cdnUrls: [CDN, OTHER_CDN], storage: localStorage, now }).tabs).toEqual([]);
	});
});

describe('emoji/owo —— normalizeCdnUrls 与 mergePacks', () => {
	it('normalizeCdnUrls 只保留非空字符串并保持顺序', () => {
		expect(normalizeCdnUrls([CDN, '', OTHER_CDN])).toEqual([CDN, OTHER_CDN]);
		expect(normalizeCdnUrls([CDN, null, 123])).toEqual([CDN]);
		expect(normalizeCdnUrls('')).toEqual([]);
		expect(normalizeCdnUrls(CDN)).toEqual([CDN]); // 兼容旧调用方的单地址
		expect(normalizeCdnUrls(undefined)).toEqual([]);
	});

	it('mergePacks：标签按首次出现排序，同名标签追加 container 而不是新建标签', () => {
		const merged = mergePacks(
			sanitizePacks(owo({ A: { type: 'image', container: [imageItem(PNG, 'a')] }, B: { type: 'image', container: [] } })),
			sanitizePacks(owo({ B: { type: 'image', container: [imageItem(PNG2, 'b')] }, C: { type: 'image', container: [imageItem(PNG, 'c')] } }))
		);
		expect(Object.keys(merged)).toEqual(['A', 'B', 'C']);
		expect(merged.B.container.map((item) => item.text)).toEqual(['b']);
		expect(merged.A.container.map((item) => item.text)).toEqual(['a']);
	});
});

describe('emoji/owo —— loadDefaultPacks 的缓存与多来源合并', () => {
	const packA = owo({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] } });
	const packB = owo({ Bilibili: { type: 'image', container: [imageItem(PNG, 'doge')] } });

	it('命中 7 天内的缓存时一个请求都不发', async () => {
		const fetch = fetchMock(async () => jsonResponse({}));
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(packA), localStorage, now);

		const result = await loadDefaultPacks([CDN], { storage: localStorage, now: now + 1000 });
		expect(result.fromCache).toBe(true);
		expect(result.stale).toBe(false);
		expect(result.partial).toBe(false);
		expect(Object.keys(result.packs)).toEqual(['颜文字']);
		expect(fetch.calls).toEqual([]);
	});

	it('force 时忽略新鲜缓存并重新拉取', async () => {
		const fetch = fetchMock(async () => jsonResponse(owo({ 新标签: { type: 'emoticon', container: [{ icon: '🙂' }] } })));
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(owo({ 旧标签: { type: 'emoticon', container: [{ icon: 'OωO' }] } })), localStorage, now);

		const result = await loadDefaultPacks([CDN], { force: true, storage: localStorage, now: now + 1000 });
		expect(fetch.calls.length).toBe(1);
		expect(fetch.calls[0].url).toBe(CDN);
		expect(result.fromCache).toBe(false);
		expect(Object.keys(result.packs)).toEqual(['新标签']);
		expect(Object.keys(readEmojiCache(listKey([CDN]), localStorage).packs)).toEqual(['新标签']);
	});

	it('缓存过期时重新拉取并覆盖缓存', async () => {
		const fetch = fetchMock(async () => jsonResponse(owo({ B: { type: 'emoticon', container: [{ icon: 'B' }] } })));
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(owo({ A: { type: 'emoticon', container: [{ icon: 'A' }] } })), localStorage, now - EMOJI_CACHE_TTL_MS);

		const result = await loadDefaultPacks([CDN], { storage: localStorage, now });
		expect(fetch.calls.length).toBe(1);
		expect(Object.keys(result.packs)).toEqual(['B']);
		expect(readEmojiCache(listKey([CDN]), localStorage).savedAt).toBe(now);
	});

	it('多来源：按数组顺序并发拉取，标签保持首次出现顺序，同名标签追加 container', async () => {
		const fetch = fetchMock(async (url) => {
			if (url === CDN) return jsonResponse(owo({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] }, Bilibili: { type: 'image', container: [imageItem(PNG, 'doge')] } }));
			return jsonResponse(owo({ Bilibili: { type: 'image', container: [imageItem(PNG2, 'hi')] }, QQ: { type: 'image', container: [imageItem(PNG2, 'qq')] } }));
		});

		const result = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		expect(fetch.calls.map((call) => call.url)).toEqual([CDN, OTHER_CDN]);
		// 首次出现顺序：CDN 的 颜文字/Bilibili 在前，OTHER 只贡献新标签 QQ
		expect(Object.keys(result.packs)).toEqual(['颜文字', 'Bilibili', 'QQ']);
		// Bilibili 在两个来源里都有 → container 追加进同一个标签，不新建标签页
		expect(result.packs.Bilibili.container.map((item) => item.text)).toEqual(['doge', 'hi']);
		expect(result.partial).toBe(false);
		expect(result.stale).toBe(false);
	});

	it('多来源：合并结果写进「地址列表」缓存键，重新加载不发请求', async () => {
		const fetch = fetchMock(async (url) => jsonResponse(url === CDN ? packA : packB));

		const first = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		expect(Object.keys(first.packs)).toEqual(['颜文字', 'Bilibili']);
		expect(readEmojiCache(listKey([CDN, OTHER_CDN]), localStorage)).toBeTruthy();
		// 单地址的缓存键不会被写入
		expect(readEmojiCache(listKey([CDN]), localStorage)).toBeNull();

		const again = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		expect(again.fromCache).toBe(true);
		expect(fetch.calls.length).toBe(2);
	});

	it('部分来源失败：成功的那几个照常合并并标 partial=true', async () => {
		const fetch = fetchMock(async (url) => {
			if (url === OTHER_CDN) throw new Error('network down');
			return jsonResponse(packA);
		});

		const result = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		expect(fetch.calls.length).toBe(2);
		expect(result.partial).toBe(true);
		expect(result.stale).toBe(false);
		expect(result.fromCache).toBe(false);
		expect(Object.keys(result.packs)).toEqual(['颜文字']);
	});

	it('部分来源返回的不是合法 owo.json：同样只丢这一个来源', async () => {
		fetchMock(async (url) => (url === CDN ? jsonResponse(['not', 'an', 'object']) : jsonResponse(packB)));

		const result = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		expect(result.partial).toBe(true);
		expect(Object.keys(result.packs)).toEqual(['Bilibili']);
	});

	it('全部来源失败但有旧缓存时回退旧缓存并标记 stale', async () => {
		const fetch = fetchMock(async () => {
			throw new Error('network down');
		});
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN, OTHER_CDN]), sanitizePacks(owo({ 旧: { type: 'emoticon', container: [{ icon: 'OωO' }] } })), localStorage, now);

		const result = await loadDefaultPacks([CDN, OTHER_CDN], { force: true, storage: localStorage, now });
		expect(fetch.calls.length).toBe(2);
		expect(result.stale).toBe(true);
		expect(result.fromCache).toBe(true);
		expect(result.partial).toBe(false);
		expect(Object.keys(result.packs)).toEqual(['旧']);
	});

	it('HTTP 非 2xx 时全部失败同样回退旧缓存', async () => {
		fetchMock(async () => jsonResponse({}, { ok: false, status: 500 }));
		writeEmojiCache(listKey([CDN]), sanitizePacks(owo({ 旧: { type: 'emoticon', container: [{ icon: 'OωO' }] } })), localStorage, 1);

		const result = await loadDefaultPacks([CDN], { force: true, storage: localStorage, now: 1 });
		expect(result.stale).toBe(true);
		expect(Object.keys(result.packs)).toEqual(['旧']);
	});

	it('全部失败且没有缓存时抛出异常（由面板显示错误态）', async () => {
		fetchMock(async () => {
			throw new Error('network down');
		});
		await expect(loadDefaultPacks([CDN], { storage: localStorage })).rejects.toThrow('network down');
	});

	it('响应不是合法 owo.json（空对象 / 数组 / 字符串）时视为失败', async () => {
		for (const body of [{}, [], 'nope']) {
			resetEmojiSetCache();
			fetchMock(async () => jsonResponse(body));
			await expect(loadDefaultPacks([CDN], { storage: localStorage }), JSON.stringify(body)).rejects.toThrow(
				'owo.json 结构不正确'
			);
		}
	});

	it('地址列表为空时直接返回空包且不发请求', async () => {
		const fetch = fetchMock(async () => jsonResponse({}));
		const result = await loadDefaultPacks([], { storage: localStorage });
		expect(result).toEqual({ packs: {}, fromCache: true, stale: false, partial: false });
		expect(fetch.calls).toEqual([]);

		// 兼容旧的单地址调用：空串照样不发请求
		expect(await loadDefaultPacks('', { storage: localStorage })).toEqual({
			packs: {},
			fromCache: true,
			stale: false,
			partial: false,
		});
		expect(fetch.calls).toEqual([]);
	});

	it('合并后的短代码跨来源去重：同名表情追加 -2，水合回各自的图', async () => {
		const GIF = 'https://other.example.com/emoji/doge.gif';
		fetchMock(async (url) =>
			url === CDN
				? jsonResponse(owo({ Bilibili: { type: 'image', container: [imageItem(PNG, 'doge')] } }))
				: jsonResponse(owo({ QQ: { type: 'image', container: [imageItem(GIF, 'doge')] } }))
		);

		const result = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		const set = buildEmojiSet(result.packs);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['Bilibili', 'QQ']);
		expect(set.tabs[0].items[0].insert).toBe(':doge:');
		expect(set.tabs[1].items[0].insert).toBe(':doge-2:');
		expect(set.images.get('doge')).toBe(PNG);
		expect(set.images.get('doge-2')).toBe(GIF);
	});

	it('同名标签合并后，同包重名（跨来源）追加 -2、-3', async () => {
		fetchMock(async (url) =>
			url === CDN
				? jsonResponse(owo({ 共享: { type: 'image', container: [imageItem(PNG, 'doge')] } }))
				: jsonResponse(owo({ 共享: { type: 'image', container: [imageItem(PNG2, 'doge')] } }))
		);

		const result = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		expect(Object.keys(result.packs)).toEqual(['共享']);
		const set = buildEmojiSet(result.packs);
		expect(set.tabs[0].items.map((item) => item.insert)).toEqual([':doge:', ':doge-2:']);
		expect(set.images.get('doge-2')).toBe(PNG2);
	});

	it('同名标签合并时标签元数据以首次出现的来源为准', async () => {
		fetchMock(async (url) =>
			url === CDN
				? jsonResponse(owo({ 共享: { type: 'emoticon', container: [{ icon: 'OωO' }] } }))
				: jsonResponse(owo({ 共享: { type: 'image', container: [imageItem(PNG2, 'hi')] } }))
		);

		const result = await loadDefaultPacks([CDN, OTHER_CDN], { storage: localStorage });
		expect(result.packs.共享.type).toBe('emoticon');
		expect(result.packs.共享.container).toEqual([
			{ icon: 'OωO', text: '' },
			{ icon: `<img src="${PNG2}">`, text: 'hi' },
		]);
	});
});

describe('emoji/owo —— buildEmojiSet 标签与短代码', () => {
	it('标签顺序 = owo.json 里键的顺序，文本项按 emoji/emoticon 原样插入', () => {
		const set = buildEmojiSet(
			owo({
				颜文字: { type: 'emoticon', container: [{ icon: 'OωO', text: 'Author: DIYgod' }] },
				Emoji: { type: 'emoji', container: [{ icon: '😂' }] },
			})
		);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['颜文字', 'Emoji']);
		expect(set.tabs.map((tab) => tab.id)).toEqual(['颜文字', 'Emoji']);
		expect(set.tabs[0].items[0]).toEqual({ insert: 'OωO', preview: 'OωO', title: 'Author: DIYgod' });
		expect(set.tabs[1].items[0]).toEqual({ insert: '😂', preview: '😂', title: '😂' });
		expect(set.images.size).toBe(0);
		expect(set.stale).toBe(false);
	});

	it('type 缺省按 image 处理；enabled=false 的标签整体跳过', () => {
		const set = buildEmojiSet(
			owo({
				缺省: { container: [imageItem(PNG, 'doge')] },
				关掉的: { enabled: false, type: 'image', container: [imageItem(PNG, 'x')] },
			})
		);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['缺省']);
		expect([...set.images.keys()]).toEqual(['doge']);
	});

	it('无法识别的 type 同样按 image 处理（对齐 doc/emoji.md 第 2 节）', () => {
		const set = buildEmojiSet(
			owo({
				sticker: { type: 'sticker', container: [imageItem(PNG, 'doge')] },
				没有type: { container: [imageItem(PNG2, 'hi')] },
			})
		);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['sticker', '没有type']);
		expect(set.tabs[0].items[0]).toEqual({
			insert: ':doge:',
			preview: PNG,
			title: 'doge',
			shortcode: 'doge',
		});
		expect(set.images.get('doge')).toBe(PNG);
		expect(set.images.get('hi')).toBe(PNG2);
	});

	it('无法识别的 type 配纯文本 icon 时整条被丢弃（文本必须显式声明 emoji / emoticon）', () => {
		const set = buildEmojiSet(
			owo({
				未知: { type: 'sticker', container: [{ icon: 'OωO', text: 'Hi' }] },
				显式文本: { type: 'emoticon', container: [{ icon: 'OωO', text: 'Hi' }] },
			})
		);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['显式文本']);
		expect(set.tabs[0].items[0].insert).toBe('OωO');
		expect(set.images.size).toBe(0);
	});

	it('图片项插入 :name: 短代码，并把短代码映射到图片地址', () => {
		const set = buildEmojiSet(owo({ Bilibili: { type: 'image', container: [imageItem(PNG, 'doge')] } }));
		expect(set.tabs[0].items[0]).toEqual({
			insert: ':doge:',
			preview: PNG,
			title: 'doge',
			shortcode: 'doge',
		});
		expect(set.images.get('doge')).toBe(PNG);
	});

	it('text 归一化：tv_doge → tv-doge，中文名 → e-<8hex>', () => {
		const set = buildEmojiSet(
			owo({
				标签: {
					type: 'image',
					container: [imageItem(PNG, 'tv_doge'), imageItem(PNG2, '中文名')],
				},
			})
		);
		expect(set.tabs[0].items[0].shortcode).toBe('tv-doge');
		expect(set.tabs[0].items[0].insert).toBe(':tv-doge:');

		const hashName = set.tabs[0].items[1].shortcode;
		expect(hashName).toBe(`e-${fnv1aHex(PNG2)}`);
		expect(hashName).toMatch(/^e-[0-9a-f]{8}$/);
	});

	it('同一标签内重名追加 -2、-3', () => {
		const set = buildEmojiSet(
			owo({ 标签: { type: 'image', container: [imageItem(PNG, 'doge'), imageItem(PNG2, 'doge'), imageItem(PNG, 'doge')] } })
		);
		expect(set.tabs[0].items.map((item) => item.shortcode)).toEqual(['doge', 'doge-2', 'doge-3']);
	});

	it('跨标签重名：靠前的标签占名，后来的标签追加 -2（每个条目水合回自己的图）', () => {
		const set = buildEmojiSet(
			owo({
				前: { type: 'image', container: [imageItem(PNG, 'doge')] },
				后: { type: 'image', container: [imageItem(PNG2, 'doge')] },
			})
		);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['前', '后']);
		// 靠前的标签拿到原名（老评论里的 :doge: 不受影响）
		expect(set.tabs[0].items[0].insert).toBe(':doge:');
		expect(set.images.get('doge')).toBe(PNG);
		// 后来的标签拿到自己的名字，否则 QQ 的动图会被 Bilibili 的同名静图顶掉
		expect(set.tabs[1].items[0].insert).toBe(':doge-2:');
		expect(set.images.get('doge-2')).toBe(PNG2);
	});

	it('每个图片条目都能水合回它自己那张图（含跨标签重名与包内重名）', () => {
		const GIF = 'https://cdn.example.com/emoji/doge.gif';
		const set = buildEmojiSet(
			owo({
				甲: { type: 'image', container: [imageItem(PNG, 'doge'), imageItem(PNG2, 'doge')] },
				乙: { type: 'image', container: [imageItem(GIF, 'doge'), imageItem(PNG2, 'hi')] },
			})
		);
		const items = set.tabs.flatMap((tab) => tab.items);
		expect(items.length).toBe(4);
		for (const item of items) {
			expect(set.images.get(item.shortcode)).toBe(item.preview);
		}
		expect(set.images.get('doge')).toBe(PNG);
		expect(set.images.get('doge-3')).toBe(GIF);
	});

	it('非法图片地址被丢弃（svg data URI / http / 裸地址 / 非 img 标签）', () => {
		const bad = [
			'<img src="data:image/svg+xml;base64,PHN2Zz4=">',
			'<img src="http://cdn.example.com/a.png">',
			'<img src="/relative/a.png">',
			'a.png',
			'<img src="javascript:alert(1)">',
			'<img src="data:image/png,notbase64">',
		];
		const set = buildEmojiSet(
			owo({ 标签: { type: 'image', container: [...bad.map((icon) => ({ icon, text: 'x' })), imageItem(PNG, 'ok')] } })
		);
		expect(set.tabs[0].items).toHaveLength(1);
		expect(set.tabs[0].items[0].shortcode).toBe('ok');
		expect(set.images.size).toBe(1);
	});

	it('合法的 data:image/png;base64 与超长文本项的口径', () => {
		const dataIcon = 'data:image/png;base64,iVBORw0KGgo=';
		const set = buildEmojiSet(
			owo({
				标签: {
					type: 'image',
					container: [{ icon: `<img src="${dataIcon}">`, text: 'inline' }],
				},
				文本: {
					type: 'emoticon',
					container: [
						{ icon: 'x'.repeat(65), text: 'too-long' },
						{ icon: '<b>bad</b>', text: 'html' },
						{ icon: 'ok', text: 'fine' },
					],
				},
			})
		);
		expect(set.images.get('inline')).toBe(dataIcon);
		expect(set.tabs[1].items.map((item) => item.insert)).toEqual(['ok']);
	});

	it('没有任何可渲染项时不产生空标签', () => {
		const set = buildEmojiSet(owo({ 空: { type: 'image', container: [] }, 坏: 'nope' }));
		expect(set.tabs).toEqual([]);
		expect(set.images.size).toBe(0);
	});

	it('stale / partial 选项会带到集合上', () => {
		expect(buildEmojiSet(owo({ 标签: { type: 'emoticon', container: [{ icon: 'x' }] } }), { stale: true }).stale).toBe(true);
		expect(buildEmojiSet(owo({ 标签: { type: 'emoticon', container: [{ icon: 'x' }] } }), { partial: true }).partial).toBe(true);
		expect(buildEmojiSet(owo({ 标签: { type: 'emoticon', container: [{ icon: 'x' }] } })).partial).toBe(false);
	});
});

describe('emoji/owo —— findShortcodes 边界', () => {
	it('命中普通短代码并给出位置', () => {
		expect(findShortcodes('你好 :doge: 世界')).toEqual([{ start: 3, end: 9, name: 'doge' }]);
		expect(findShortcodes(':tv-doge:')).toEqual([{ start: 0, end: 9, name: 'tv-doge' }]);
	});

	it('12:30:45 这类时间不算短代码', () => {
		expect(findShortcodes('12:30:45')).toEqual([]);
		expect(findShortcodes('会议时间 12:30:45 开始')).toEqual([]);
		expect(containsShortcode('12:30:45')).toBe(false);
	});

	it('短代码前一个字符不能是字母或数字', () => {
		expect(findShortcodes('a:doge:')).toEqual([]);
		expect(findShortcodes('1:doge:')).toEqual([]);
		expect(findShortcodes(' :doge:')).toHaveLength(1);
		expect(findShortcodes('中文:doge:')).toHaveLength(1);
	});

	it('短代码后一个字符不能是数字；紧跟字母仍会命中（记录现状）', () => {
		expect(findShortcodes(':doge:1')).toEqual([]);
		// 实现只挡「数字」，因此紧跟字母仍算短代码
		expect(findShortcodes(':doge:a')).toEqual([{ start: 0, end: 6, name: 'doge' }]);
	});

	it('未闭合的冒号、空名称、大写名称都不算', () => {
		expect(findShortcodes(':doge')).toEqual([]);
		expect(findShortcodes('::')).toEqual([]);
		expect(findShortcodes(':Doge:')).toEqual([]);
		expect(findShortcodes('-doge:')).toEqual([]);
	});

	it('limit 限制命中数量，containsShortcode 只判断存在性', () => {
		expect(findShortcodes(':a: :b: :c:', 2)).toHaveLength(2);
		expect(findShortcodes(':a: :b:')).toHaveLength(2);
		expect(containsShortcode('没有短代码')).toBe(false);
		expect(containsShortcode(':a:')).toBe(true);
	});
});

describe('emoji/owo —— 纯函数口径', () => {
	it('codePointLength 按码点计数（emoji 算 1 个）', () => {
		expect(codePointLength('😂')).toBe(1);
		expect(codePointLength('a😂b')).toBe(3);
		expect(codePointLength('')).toBe(0);
	});

	it('fnv1aHex 稳定输出 8 位十六进制', () => {
		expect(fnv1aHex('')).toBe('811c9dc5');
		expect(fnv1aHex(PNG)).toBe(fnv1aHex(PNG));
		expect(fnv1aHex(PNG)).toMatch(/^[0-9a-f]{8}$/);
	});

	it('normalizeShortcode 归一化并限制长度', () => {
		expect(normalizeShortcode('tv_doge')).toBe('tv-doge');
		expect(normalizeShortcode('  DOGE  ')).toBe('doge');
		expect(normalizeShortcode('中文')).toBe('');
		expect(normalizeShortcode('')).toBe('');
		expect(normalizeShortcode('a'.repeat(40))).toHaveLength(32);
	});

	it('safeImageUrl 只放行 data:image/*;base64 与 https 地址', () => {
		expect(safeImageUrl(`<img src="${PNG}">`)).toBe(PNG);
		expect(safeImageUrl('<img src="data:image/webp;base64,AAAA">')).toBe('data:image/webp;base64,AAAA');
		expect(safeImageUrl('<img src="http://a.example.com/x.png">')).toBe('');
		expect(safeImageUrl('<img src="data:image/svg+xml;base64,AAAA">')).toBe('');
		expect(safeImageUrl('https://a.example.com/x.png')).toBe('');
		expect(safeImageUrl(undefined)).toBe('');
	});
});

describe('emoji/owo —— loadEmojiSet 模块级缓存与并发去重', () => {
	it('同一个地址列表只发一次请求（模块级缓存）', async () => {
		const fetch = fetchMock(async () => jsonResponse(owo({ 标签: { type: 'emoticon', container: [{ icon: 'OωO' }] } })));

		const first = await loadEmojiSet({ cdnUrls: [CDN], storage: null });
		const second = await loadEmojiSet({ cdnUrls: [CDN], storage: null });

		expect(fetch.calls.length).toBe(1);
		expect(fetch.calls[0].url).toBe(CDN);
		expect(second).toBe(first);
	});

	it('并发调用共享同一次请求（in-flight 去重）', async () => {
		let resolveFetch;
		const fetch = fetchMock(
			() =>
				new Promise((resolve) => {
					resolveFetch = () => resolve(jsonResponse(owo({ 标签: { type: 'emoticon', container: [{ icon: 'OωO' }] } })));
				})
		);

		const a = loadEmojiSet({ cdnUrls: [CDN], storage: null });
		const b = loadEmojiSet({ cdnUrls: [CDN], storage: null });
		expect(fetch.calls.length).toBe(1);

		resolveFetch();
		const [setA, setB] = await Promise.all([a, b]);
		expect(setA).toBe(setB);
		expect(setA.tabs.map((tab) => tab.label)).toEqual(['标签']);
	});

	it('不同地址列表各自请求，resetEmojiSetCache 后重新请求', async () => {
		const fetch = fetchMock(async () => jsonResponse(owo({ 标签: { type: 'emoticon', container: [{ icon: 'OωO' }] } })));

		await loadEmojiSet({ cdnUrls: [CDN], storage: null });
		await loadEmojiSet({ cdnUrls: [OTHER_CDN], storage: null });
		expect(fetch.calls.map((call) => call.url)).toEqual([CDN, OTHER_CDN]);

		resetEmojiSetCache();
		await loadEmojiSet({ cdnUrls: [CDN], storage: null });
		expect(fetch.calls.length).toBe(3);
	});

	it('模块级缓存的键是地址列表：多来源与单来源互不串用', async () => {
		const fetch = fetchMock(async (url) =>
			url === CDN
				? jsonResponse(owo({ 一: { type: 'emoticon', container: [{ icon: '1' }] } }))
				: jsonResponse(owo({ 二: { type: 'emoticon', container: [{ icon: '2' }] } }))
		);

		const single = await loadEmojiSet({ cdnUrls: [CDN], storage: null });
		const multi = await loadEmojiSet({ cdnUrls: [CDN, OTHER_CDN], storage: null });
		expect(single.tabs.map((tab) => tab.label)).toEqual(['一']);
		expect(multi.tabs.map((tab) => tab.label)).toEqual(['一', '二']);
		expect(fetch.calls.length).toBe(3);
	});

	it('多来源合并 + 部分失败：集合带 partial 标记，成功来源照常渲染', async () => {
		fetchMock(async (url) => {
			if (url === OTHER_CDN) throw new Error('network down');
			return jsonResponse(owo({ 标签: { type: 'emoticon', container: [{ icon: 'OωO' }] } }));
		});

		const set = await loadEmojiSet({ cdnUrls: [CDN, OTHER_CDN], storage: null });
		expect(set.partial).toBe(true);
		expect(set.stale).toBe(false);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['标签']);
	});

	it('拉取失败但有旧缓存时集合带 stale 标记', async () => {
		fetchMock(async () => {
			throw new Error('network down');
		});
		const now = 1_000_000;
		// 刻意写入「已过期」的缓存：新鲜缓存根本不会触发请求，也就不会有 stale
		writeEmojiCache(
			listKey([CDN]),
			sanitizePacks(owo({ 旧: { type: 'emoticon', container: [{ icon: 'OωO' }] } })),
			localStorage,
			now - EMOJI_CACHE_TTL_MS
		);

		const set = await loadEmojiSet({ cdnUrls: [CDN], storage: localStorage, now });
		expect(set.stale).toBe(true);
		expect(set.partial).toBe(false);
		expect(set.tabs.map((tab) => tab.label)).toEqual(['旧']);
	});

	it('force 会绕过模块级缓存重新请求', async () => {
		const fetch = fetchMock(async () => jsonResponse(owo({ 标签: { type: 'emoticon', container: [{ icon: 'OωO' }] } })));
		await loadEmojiSet({ cdnUrls: [CDN], storage: null });
		await loadEmojiSet({ cdnUrls: [CDN], storage: null, force: true });
		expect(fetch.calls.length).toBe(2);
	});
});

describe('emoji/owo —— 后台校验（stale-while-revalidate）', () => {
	const packOld = owo({ 旧: { type: 'emoticon', container: [{ icon: 'OωO' }] } });
	const packNew = owo({ 新: { type: 'emoticon', container: [{ icon: '🙂' }] } });

	it('needsRevalidation：到点、时钟倒退、没有缓存都算需要校验', () => {
		expect(needsRevalidation(null)).toBe(true);

		const entry = { savedAt: 1000, packs: {} };
		expect(needsRevalidation(entry, 1000)).toBe(false);
		expect(needsRevalidation(entry, 1000 + EMOJI_REVALIDATE_MS - 1)).toBe(false);
		expect(needsRevalidation(entry, 1000 + EMOJI_REVALIDATE_MS)).toBe(true);
		expect(needsRevalidation(entry, 999)).toBe(true); // 时钟倒退
		expect(needsRevalidation(entry, 2000, 500)).toBe(true); // 自定义间隔

		// revalidatedAt 优先于 savedAt：校验过之后，可用期锚点不动
		const touched = { savedAt: 1000, revalidatedAt: 9000, packs: {} };
		expect(needsRevalidation(touched, 9000)).toBe(false);
		expect(needsRevalidation(touched, 9000 + EMOJI_REVALIDATE_MS)).toBe(true);
	});

	it('emojiCacheNeedsRevalidation：没有缓存时返回 false（交给正常加载），空地址也返回 false', () => {
		const now = 1_000_000;
		expect(emojiCacheNeedsRevalidation({ cdnUrls: [CDN], storage: localStorage, now })).toBe(false);
		expect(emojiCacheNeedsRevalidation({ cdnUrls: [], storage: localStorage, now })).toBe(false);

		writeEmojiCache(listKey([CDN]), sanitizePacks(packOld), localStorage, now - EMOJI_REVALIDATE_MS);
		expect(emojiCacheNeedsRevalidation({ cdnUrls: [CDN], storage: localStorage, now })).toBe(true);

		touchEmojiCache(listKey([CDN]), localStorage, now);
		expect(emojiCacheNeedsRevalidation({ cdnUrls: [CDN], storage: localStorage, now })).toBe(false);
	});

	it('touchEmojiCache 只推校验时间：内容与 savedAt 都不动', () => {
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(packOld), localStorage, now - 1000);
		expect(touchEmojiCache(listKey([CDN]), localStorage, now)).toBe(true);

		const entry = readEmojiCache(listKey([CDN]), localStorage);
		expect(entry.savedAt).toBe(now - 1000);
		expect(entry.revalidatedAt).toBe(now);
		expect(Object.keys(entry.packs)).toEqual(['旧']);

		expect(touchEmojiCache(listKey([OTHER_CDN]), localStorage, now)).toBe(false);
		expect(touchEmojiCache('', localStorage, now)).toBe(false);
	});

	it('内容没变时返回 null，只推校验时间（不重写包体）', async () => {
		const now = 1_000_000;
		const savedAt = now - 2 * EMOJI_REVALIDATE_MS;
		writeEmojiCache(listKey([CDN]), sanitizePacks(packOld), localStorage, savedAt);
		const fetch = fetchMock(async () => jsonResponse(packOld));

		expect(await revalidateEmojiSet({ cdnUrls: [CDN], storage: localStorage, now })).toBeNull();
		expect(fetch.calls.length).toBe(1);
		// 绕过浏览器 HTTP 缓存：源站只有 max-age，不指定 cache 会拿到旧内容
		expect(fetch.calls[0].init.cache).toBe('no-cache');

		const entry = readEmojiCache(listKey([CDN]), localStorage);
		expect(entry.revalidatedAt).toBe(now);
		expect(entry.savedAt).toBe(savedAt);
	});

	it('内容变了时返回新的集合并覆盖缓存', async () => {
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(packOld), localStorage, now - EMOJI_REVALIDATE_MS);
		fetchMock(async () => jsonResponse(packNew));

		const set = await revalidateEmojiSet({ cdnUrls: [CDN], storage: localStorage, now });
		expect(set).toBeTruthy();
		expect(set.tabs.map((tab) => tab.label)).toEqual(['新']);
		expect(Object.keys(readEmojiCache(listKey([CDN]), localStorage).packs)).toEqual(['新']);
		expect(readEmojiCache(listKey([CDN]), localStorage).revalidatedAt).toBe(now);
	});

	it('没有缓存时返回 null 且不发请求（没有基线可比，交给正常首载）', async () => {
		const fetch = fetchMock(async () => jsonResponse(packNew));
		expect(await revalidateEmojiSet({ cdnUrls: [CDN], storage: localStorage })).toBeNull();
		expect(fetch.calls).toEqual([]);
		expect(await revalidateEmojiSet({ cdnUrls: [], storage: localStorage })).toBeNull();
	});

	it('有来源失败时不换界面（避免面板少一整包），但记一次校验时间避免每页重试', async () => {
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN, OTHER_CDN]), sanitizePacks(packOld), localStorage, now - EMOJI_REVALIDATE_MS);
		const fetch = fetchMock(async (url) => {
			if (url === OTHER_CDN) throw new Error('network down');
			return jsonResponse(packNew);
		});

		expect(await revalidateEmojiSet({ cdnUrls: [CDN, OTHER_CDN], storage: localStorage, now })).toBeNull();
		expect(fetch.calls.length).toBe(2);
		// 缓存内容保持原样（缺标签的结果不能写回去）
		expect(Object.keys(readEmojiCache(listKey([CDN, OTHER_CDN]), localStorage).packs)).toEqual(['旧']);
		expect(readEmojiCache(listKey([CDN, OTHER_CDN]), localStorage).revalidatedAt).toBe(now);
	});

	it('全部来源失败时同样保持缓存并返回 null', async () => {
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(packOld), localStorage, now - EMOJI_REVALIDATE_MS);
		fetchMock(async () => {
			throw new Error('network down');
		});

		expect(await revalidateEmojiSet({ cdnUrls: [CDN], storage: localStorage, now })).toBeNull();
		expect(Object.keys(readEmojiCache(listKey([CDN]), localStorage).packs)).toEqual(['旧']);
	});

	it('并发校验共享同一次请求，内容变了也只替换一次', async () => {
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(packOld), localStorage, now - EMOJI_REVALIDATE_MS);
		let resolveFetch;
		const fetch = fetchMock(
			() =>
				new Promise((resolve) => {
					resolveFetch = () => resolve(jsonResponse(packNew));
				})
		);

		const a = revalidateEmojiSet({ cdnUrls: [CDN], storage: localStorage, now });
		const b = revalidateEmojiSet({ cdnUrls: [CDN], storage: localStorage, now });
		expect(fetch.calls.length).toBe(1);

		resolveFetch();
		const [setA, setB] = await Promise.all([a, b]);
		expect(setA).toBe(setB);
		expect(setA.tabs.map((tab) => tab.label)).toEqual(['新']);
		expect(fetch.calls.length).toBe(1);
	});

	it('校验到变化时同步更新模块级缓存，后续 loadEmojiSet 不会退回旧集合', async () => {
		const now = 1_000_000;
		writeEmojiCache(listKey([CDN]), sanitizePacks(packOld), localStorage, now - EMOJI_REVALIDATE_MS);
		fetchMock(async () => jsonResponse(packNew));

		const before = await loadEmojiSet({ cdnUrls: [CDN], storage: localStorage, now: now - EMOJI_REVALIDATE_MS });
		expect(before.tabs.map((tab) => tab.label)).toEqual(['旧']);

		const set = await revalidateEmojiSet({ cdnUrls: [CDN], storage: localStorage, now });
		expect(set.tabs.map((tab) => tab.label)).toEqual(['新']);

		const after = await loadEmojiSet({ cdnUrls: [CDN], storage: localStorage, now });
		expect(after).toBe(set);
	});

	it('force 拉取用 cache: no-cache 绕开浏览器 HTTP 缓存；普通首载不指定 cache', async () => {
		const fetch = fetchMock(async () => jsonResponse(packOld));
		await loadDefaultPacks([CDN], { storage: localStorage });
		await loadDefaultPacks([CDN], { force: true, storage: localStorage });

		expect(fetch.calls[0].init.cache).toBeUndefined();
		expect(fetch.calls[1].init.cache).toBe('no-cache');
	});
});
