import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import EmojiPicker from '../src/emoji/EmojiPicker.svelte';
import { EMOJI_CACHE_PREFIX, resetEmojiSetCache } from '../src/emoji/owo';
import { stubMatchMedia } from './helpers.js';

const CDN = 'https://cdn.example.com/emoji/owo.json';
const OTHER_CDN = 'https://other.example.com/owo.json';
const PNG = 'https://cdn.example.com/emoji/doge.png';

/** 缓存键 = 整个地址列表的 JSON（doc/emoji.md 第 6 节） */
const cacheStorageKey = (urls) => `${EMOJI_CACHE_PREFIX}${JSON.stringify(urls)}`;

const OWO = {
	颜文字: { type: 'emoticon', container: [{ icon: 'OωO', text: 'Author: DIYgod' }] },
	Bilibili: { type: 'image', container: [{ icon: `<img src="${PNG}">`, text: 'doge' }] },
};

function jsonResponse(body, init = {}) {
	return { ok: true, status: 200, json: async () => body, ...init };
}

/** 记录所有 fetch 调用的替身（与 comments.test.js 同风格） */
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

function renderPicker(props = {}) {
	return render(EmojiPicker, { props: { cdnUrls: [CDN], language: 'zh-cn', ...props } });
}

const trigger = (container) => container.querySelector('[data-test="emoji-trigger"]');
// 面板被 portal 到 document.body（脱离宿主的 overflow-hidden 裁剪盒与层叠上下文），
// 因此面板内部节点只能从 document 上查，不在组件 container 里。
const panel = () => document.querySelector('[data-test="emoji-panel"]');
const tabs = () => [...document.querySelectorAll('[data-test="emoji-tab"]')];
const items = () => [...document.querySelectorAll('[data-test="emoji-item"]')];
const byTest = (name) => document.querySelector(`[data-test="${name}"]`);

/** 替身可视视口（模拟窄屏 / 软键盘弹出后的 visualViewport） */
function stubVisualViewport({ width, height, offsetLeft = 0, offsetTop = 0 }) {
	const original = window.visualViewport;
	Object.defineProperty(window, 'visualViewport', {
		configurable: true,
		value: {
			width,
			height,
			offsetLeft,
			offsetTop,
			addEventListener() {},
			removeEventListener() {},
		},
	});
	return () => {
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: original });
	};
}

beforeEach(() => {
	localStorage.clear();
	resetEmojiSetCache();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	cleanup();
});

describe('EmojiPicker —— 打开与关闭', () => {
	it('初始只渲染按钮，不渲染面板、不发任何请求', () => {
		const fetch = fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		expect(trigger(container)).toBeTruthy();
		expect(panel(container)).toBeNull();
		expect(fetch.calls).toEqual([]);
	});

	it('首次打开面板时只请求配置的 owo.json（绝不请求本站 /api/emoji）', async () => {
		const fetch = fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));

		expect(fetch.calls.length).toBe(1);
		expect(fetch.calls[0].url).toBe(CDN);
		expect(fetch.calls[0].init.headers.Accept).toBe('application/json');
		expect(fetch.calls.some((call) => call.url.includes('/api/emoji'))).toBe(false);
		expect(fetch.calls.some((call) => call.url.includes('api'))).toBe(false);
	});

	it('面板打开后再次打开不会重复请求（模块级缓存）', async () => {
		const fetch = fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));
		await fireEvent.click(trigger(container)); // 关闭
		expect(panel(container)).toBeNull();
		await fireEvent.click(trigger(container)); // 再打开
		await waitFor(() => expect(panel(container)).toBeTruthy());
		expect(fetch.calls.length).toBe(1);
	});

	it('命中 7 天缓存时打开面板一个请求都不发，直接渲染缓存里的表情', async () => {
		const fetch = fetchMock(async () => jsonResponse(OWO));
		localStorage.setItem(
			cacheStorageKey([CDN]),
			JSON.stringify({ savedAt: Date.now(), packs: OWO })
		);
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));
		expect(fetch.calls).toEqual([]);
		expect(tabs(container).map((tab) => tab.textContent.trim())).toEqual(['颜文字', 'Bilibili']);
	});

	it('Esc 关闭面板', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel(container)).toBeTruthy());

		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(panel(container)).toBeNull());
	});

	it('点击面板外部关闭，点击面板内部不关闭', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel(container)).toBeTruthy());

		await fireEvent.click(panel(container));
		expect(panel(container)).toBeTruthy();

		await fireEvent.click(document.body);
		await waitFor(() => expect(panel(container)).toBeNull());
	});

	it('地址列表为空时按钮禁用：点击不打开面板也不发请求', async () => {
		const fetch = fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker({ cdnUrls: [] });

		expect(trigger(container).disabled).toBe(true);
		await fireEvent.click(trigger(container));
		expect(panel(container)).toBeNull();
		expect(fetch.calls).toEqual([]);
	});

	it('多来源：首次打开时并发拉取全部地址，按数组顺序合并标签', async () => {
		const fetch = fetchMock(async (url) =>
			url === CDN
				? jsonResponse({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] } })
				: jsonResponse({ Bilibili: { type: 'image', container: [{ icon: `<img src="${PNG}">`, text: 'doge' }] } })
		);
		const { container } = renderPicker({ cdnUrls: [CDN, OTHER_CDN] });

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(tabs(container).length).toBe(2));

		expect(fetch.calls.map((call) => call.url)).toEqual([CDN, OTHER_CDN]);
		expect(tabs(container).map((tab) => tab.textContent.trim())).toEqual(['颜文字', 'Bilibili']);
	});

	it('兼容旧的单地址 prop：cdnUrls 为空时回落到 cdnUrl', async () => {
		const fetch = fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker({ cdnUrls: [], cdnUrl: CDN });

		expect(trigger(container).disabled).toBe(false);
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));
		expect(fetch.calls.map((call) => call.url)).toEqual([CDN]);
	});
});

describe('EmojiPicker —— 标签与选择', () => {
	it('默认选中第一个标签，可切换标签，标签顺序按 owo.json 键序', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(tabs(container).length).toBe(2));

		expect(tabs(container).map((tab) => tab.textContent.trim())).toEqual(['颜文字', 'Bilibili']);
		expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']);

		await fireEvent.click(tabs(container)[1]);
		await waitFor(() => expect(items(container).map((item) => item.dataset.insert)).toEqual([':doge:']));
		expect(items(container)[0].querySelector('img').getAttribute('src')).toBe(PNG);
	});

	it('点击文本项回调 onPick(文本)，点击图片项回调 onPick(:name:)', async () => {
		const onPick = vi.fn();
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker({ onPick });
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBe(1));

		await fireEvent.click(items(container)[0]);
		expect(onPick).toHaveBeenLastCalledWith('OωO');

		await fireEvent.click(tabs(container)[1]);
		await waitFor(() => expect(items(container).map((item) => item.dataset.insert)).toEqual([':doge:']));
		await fireEvent.click(items(container)[0]);
		expect(onPick).toHaveBeenLastCalledWith(':doge:');
		expect(items(container)[0].title).toBe('doge');
	});
});

describe('EmojiPicker —— 移动端选完即收', () => {
	it('移动端选中表情后自动收起面板（把屏幕还给输入区）', async () => {
		const restore = stubMatchMedia(true);
		try {
			fetchMock(async () => jsonResponse(OWO));
			const { container } = renderPicker();
			await fireEvent.click(trigger(container));
			await waitFor(() => expect(items(container).length).toBeGreaterThan(0));

			await fireEvent.click(items(container)[0]);
			await waitFor(() => expect(panel(container)).toBeNull());
		} finally {
			restore();
		}
	});

	it('桌面端选中表情后保持面板打开，可连续选', async () => {
		const restore = stubMatchMedia(false);
		try {
			fetchMock(async () => jsonResponse(OWO));
			const { container } = renderPicker();
			await fireEvent.click(trigger(container));
			await waitFor(() => expect(items(container).length).toBeGreaterThan(0));

			await fireEvent.click(items(container)[0]);
			expect(panel(container)).toBeTruthy();
		} finally {
			restore();
		}
	});
});

describe('EmojiPicker —— 加载状态', () => {
	it('请求返回前面板显示加载中', async () => {
		let resolveFetch;
		fetchMock(
			() =>
				new Promise((resolve) => {
					resolveFetch = () => resolve(jsonResponse(OWO));
				})
		);
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));

		expect(panel(container).textContent).toContain('正在加载表情...');
		resolveFetch();
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));
		expect(panel(container).textContent).not.toContain('正在加载表情...');
	});

	it('拉取失败显示错误与重试按钮，重试成功后渲染表情', async () => {
		const fetch = fetchMock(async (url, init, nth) => {
			if (nth === 1) throw new Error('network down');
			return jsonResponse(OWO);
		});
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(byTest('emoji-retry')).toBeTruthy());
		expect(panel(container).textContent).toContain('表情加载失败');
		expect(items(container)).toEqual([]);

		await fireEvent.click(byTest('emoji-retry'));
		await waitFor(() => expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']));
		expect(fetch.calls.length).toBe(2);
	});

	it('拉取失败但本地有过期缓存时用旧缓存并显示 stale 提示', async () => {
		fetchMock(async () => {
			throw new Error('network down');
		});
		localStorage.setItem(
			cacheStorageKey([CDN]),
			JSON.stringify({ savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, packs: OWO })
		);
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(byTest('emoji-stale')).toBeTruthy());
		expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']);
		expect(panel(container).textContent).toContain('本地缓存');
	});

	it('部分来源失败：成功的那几个照常渲染，并显示「部分来源加载失败」重试入口', async () => {
		const fetch = fetchMock(async (url) => {
			if (url === OTHER_CDN) throw new Error('network down');
			return jsonResponse({ 颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] } });
		});
		const { container } = renderPicker({ cdnUrls: [CDN, OTHER_CDN] });
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(byTest('emoji-partial')).toBeTruthy());
		// 成功来源照常渲染，且没有 stale（不是回退缓存）
		expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']);
		expect(byTest('emoji-stale')).toBeNull();
		expect(panel(container).textContent).toContain('部分来源加载失败');

		// 重试入口会强制重新拉取全部来源
		await fireEvent.click(byTest('emoji-partial'));
		await waitFor(() => expect(fetch.calls.length).toBe(4));
	});

	it('全部来源成功时不显示 partial 提示', async () => {
		fetchMock(async (url) => jsonResponse(url === CDN ? OWO : { QQ: { type: 'image', container: [{ icon: `<img src="${PNG}">`, text: 'qq' }] } }));
		const { container } = renderPicker({ cdnUrls: [CDN, OTHER_CDN] });
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(tabs(container).length).toBe(3));
		expect(byTest('emoji-partial')).toBeNull();
	});

	it('没有可渲染的表情时显示空态', async () => {
		fetchMock(async () => jsonResponse({ 空标签: { type: 'image', container: [] } }));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(byTest('emoji-empty')).toBeTruthy());
		expect(panel(container).textContent).toContain('暂无可用的表情');
		expect(items(container)).toEqual([]);
	});

	it('响应形状不对时按加载失败处理（重试按钮而非空态）', async () => {
		fetchMock(async () => jsonResponse(['not', 'an', 'object']));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(byTest('emoji-retry')).toBeTruthy());
		expect(byTest('emoji-empty')).toBeNull();
	});
});

describe('EmojiPicker —— 面板布局', () => {
	it('表情按钮无边框、默认浅色、hover 变 link 色，图标来自 Material Icons', () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		const button = trigger(container);

		expect(button.className).not.toContain('border');
		// 默认取文字色的 60%（浅色），hover 换成 link 色
		expect(button.className).toContain('text-[var(--text-color)]/60');
		expect(button.className).toContain('hover:text-[var(--link-color)]');
		expect(button.className).not.toContain('hover:bg-');
		expect(button.className).not.toContain('hover:opacity-');
		// 预览态（disabled）不再压暗：颜色与编辑态完全一致
		expect(button.className).not.toContain('disabled:opacity-');
		expect(button.className).toContain('disabled:cursor-not-allowed');
		const icon = button.querySelector('svg');
		expect(icon).toBeTruthy();
		expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
		expect(icon.getAttribute('class')).toContain('w-5');
		// Material 的 mood 图标：单条 currentColor 路径
		const path = icon.querySelector('path');
		expect(path.getAttribute('fill')).toBe('currentColor');
		expect(path.getAttribute('d').startsWith('M11.99 2C6.47 2')).toBe(true);
	});

	it('面板被 portal 到 body：脱离 overflow-hidden 裁剪盒与祖先层叠上下文', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel()).toBeTruthy());

		// 二级回复外面套着 overflow-hidden 的容器（CommentItem 的回复列表），
		// absolute 面板会被裁掉；只有挂到 body 才能同时摆脱裁剪和 z-index 比较范围
		expect(panel().parentElement).toBe(document.body);
		expect(container.querySelector('[data-test="emoji-panel"]')).toBeNull();
		// fixed 定位由 JS 写入（不再依赖 top-full / mt-2 / absolute）
		expect(panel().className).toContain('fixed');
		expect(panel().className).not.toContain('absolute');
		expect(panel().style.position).toBe('fixed');
		// 圆角比原来的 rounded-lg（0.5rem）更小
		expect(panel().className).toContain('rounded ');
		expect(panel().className).not.toContain('rounded-lg');
	});

	it('默认向下展开：top 取按钮底边 + 间距，视口下方空间充足时高度用上限封顶', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel()).toBeTruthy());

		// happy-dom 里 getBoundingClientRect 全为 0，等价于按钮就在视口顶部
		expect(panel().dataset.placement).toBe('bottom');
		expect(panel().style.maxHeight).toBe('256px');
		expect(panel().style.top).toBe('8px'); // 0 (按钮底边) + 8 (间距)
	});

	it('窄屏时面板宽度与左边缘被夹进可视视口，不会从右边溢出被裁掉', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const restoreViewport = stubVisualViewport({ width: 390, height: 700 });
		const restoreRect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
			top: 300, bottom: 360, left: 100, right: 140, width: 40, height: 60, x: 100, y: 300,
		});
		try {
			const { container } = renderPicker();
			await fireEvent.click(trigger(container));
			await waitFor(() => expect(panel()).toBeTruthy());

			// 宽度 = min(24rem, 390 - 24) = 366；左边缘被夹到 12（左留白），右边缘 = 378 < 390
			expect(panel().style.width).toBe('366px');
			expect(panel().style.left).toBe('12px');
			expect(12 + 366).toBeLessThanOrEqual(390);
		} finally {
			restoreRect.mockRestore();
			restoreViewport();
		}
	});

	it('下方连最小高度都放不下且上方更宽裕时，翻到按钮上方展开', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
			top: 600, bottom: 660, left: 0, right: 40, width: 40, height: 60, x: 0, y: 600,
		});

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel()).toBeTruthy());

		// 下方只剩 768 - 660 - 8 - 12 = 88 < 96，上方有 580：翻上去，底边贴在按钮上方
		expect(panel().dataset.placement).toBe('top');
		expect(panel().style.maxHeight).toBe('256px');
		expect(panel().style.bottom).toBe(`${window.innerHeight - (600 - 8)}px`);
		expect(panel().style.top).toBe('');
	});

	it('页面滚动时面板跟随按钮重新定位', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
			top: 0, bottom: 60, left: 0, right: 40, width: 40, height: 60, x: 0, y: 0,
		});
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel(container)).toBeTruthy());
		expect(panel(container).style.top).toBe('68px');

		rectSpy.mockReturnValue({
			top: 200, bottom: 260, left: 0, right: 40, width: 40, height: 60, x: 0, y: 200,
		});
		window.dispatchEvent(new Event('scroll'));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(panel(container).style.top).toBe('268px');
	});

	it('颜文字按内容自适应排布，图片表情仍用等宽网格', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));

		// 颜文字：flex 换行 + 条目宽度随内容（不再塞进固定列宽的网格里互相挤压）
		const textRow = items(container)[0].parentElement;
		expect(textRow.className).toContain('flex-wrap');
		expect(textRow.className).not.toContain('grid-cols');
		expect(items(container)[0].className).toContain('min-w-[2rem]');
		expect(items(container)[0].className).not.toContain('w-8');
		expect(items(container)[0].className).toContain('max-w-full');
		// 颜文字字号比图片网格里的文本更小
		expect(items(container)[0].className).toContain('text-sm');
		// 深色模式：颜文字自带文字色，不靠从宿主 body 继承（面板已 portal 到 body）
		expect(items(container)[0].className).toContain('text-[var(--text-color)]');
		// 超长颜文字在按钮内部换行，不会顶出横向滚动
		expect(items(container)[0].querySelector('span').className).toContain('break-all');

		await fireEvent.click(tabs(container)[1]);
		await waitFor(() => expect(items(container).map((item) => item.dataset.insert)).toEqual([':doge:']));
		// 图片：2rem 等宽列，列数随宽度 auto-fill（不是写死 8 列）
		expect(items(container)[0].parentElement.className).toContain('repeat(auto-fill,2rem)');
		expect(items(container)[0].className).toContain('h-8');
	});

	it('标签栏与表情区都不出现横向滚动条', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(tabs(container).length).toBe(2));

		const tablist = byTest('emoji-tablist');
		expect(tablist.className).not.toContain('overflow-x-auto');
		expect(tablist.className).toContain('flex-wrap');

		const list = byTest('emoji-list');
		expect(list.className).toContain('overflow-x-hidden');
		expect(list.className).toContain('overflow-y-auto');

		expect(panel(container).className).toContain('overflow-hidden');
		expect(panel(container).className).toContain('flex-col');
	});

	it('表情项与未选中标签有可见的 hover 高亮（面板底色就是 hover 底色，不能再复用它）', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));

		// 颜文字项
		expect(items(container)[0].className).toContain('emoji-hoverable');
		expect(items(container)[0].className).not.toContain('hover:bg-');

		// 图片项
		await fireEvent.click(tabs(container)[1]);
		await waitFor(() => expect(items(container).map((item) => item.dataset.insert)).toEqual([':doge:']));
		expect(items(container)[0].className).toContain('emoji-hoverable');
		expect(items(container)[0].className).not.toContain('hover:bg-');

		// 未选中标签高亮，选中标签交给 emoji-tab-active（上面已切到 Bilibili）
		const tabNodes = tabs(container);
		expect(tabNodes[1].className).toContain('emoji-tab-active');
		expect(tabNodes[1].className).not.toContain('emoji-hoverable');
		expect(tabNodes[0].className).toContain('emoji-hoverable');
		expect(tabNodes[0].className).not.toContain('emoji-tab-active');
		expect(tabNodes[0].className).not.toContain('hover:bg-');
	});
});

describe('EmojiPicker —— 跨标签重名（动图不被同名静图顶掉）', () => {
	const GIF = 'https://cdn.example.com/emoji/qq_doge.gif';
	const PNG = 'https://cdn.example.com/emoji/bili_doge.png';
	const DUP_OWO = {
		颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }] },
		Bilibili: { type: 'image', container: [{ icon: `<img src="${PNG}">`, text: 'doge' }] },
		QQ: { type: 'image', container: [{ icon: `<img src="${GIF}">`, text: 'doge' }] },
	};

	it('从后一个包选同名表情时插入 -2 短代码，水合回它自己的动图', async () => {
		const onPick = vi.fn();
		fetchMock(async () => jsonResponse(DUP_OWO));
		const { container } = renderPicker({ onPick });
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(tabs(container).length).toBe(3));

		await fireEvent.click(tabs(container)[2]); // QQ
		await waitFor(() => expect(items(container).map((item) => item.dataset.insert)).toEqual([':doge-2:']));
		// 面板里显示的仍是 QQ 自己的动图
		expect(items(container)[0].querySelector('img').getAttribute('src')).toBe(GIF);

		await fireEvent.click(items(container)[0]);
		expect(onPick).toHaveBeenLastCalledWith(':doge-2:');
	});
});

describe('EmojiPicker —— 缓存更新（后台校验 / 手动刷新）', () => {
	const HOUR = 60 * 60 * 1000;
	const NEW_OWO = { 新标签: { type: 'emoticon', container: [{ icon: '🆕' }] } };

	/** 预置一份本地缓存；`revalidatedAt` 缺省时按 savedAt 计算（旧缓存格式） */
	function seedCache(packs, { savedAt, revalidatedAt } = {}) {
		const entry = { savedAt, packs };
		if (revalidatedAt !== undefined) entry.revalidatedAt = revalidatedAt;
		localStorage.setItem(cacheStorageKey([CDN]), JSON.stringify(entry));
	}

	it('缓存已到点：先用缓存立刻渲染，再静默校验一次（内容变了自动替换）', async () => {
		seedCache(OWO, { savedAt: Date.now() - HOUR, revalidatedAt: Date.now() - 7 * HOUR });
		const fetch = fetchMock(async () => jsonResponse(NEW_OWO));
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		// 缓存里的表情先出现，不闪「正在加载表情...」
		await waitFor(() => expect(tabs(container).length).toBe(2));
		expect(panel(container).textContent).not.toContain('正在加载表情...');

		await waitFor(() => expect(tabs(container).map((tab) => tab.textContent.trim())).toEqual(['新标签']));
		expect(fetch.calls.length).toBe(1);
		expect(fetch.calls[0].url).toBe(CDN);
		// 源站只有 max-age=3600 且没有 ETag：不指定 no-cache 会吃到老内容
		expect(fetch.calls[0].init.cache).toBe('no-cache');
	});

	it('缓存未到点（刚校验过）时一个请求都不发', async () => {
		seedCache(OWO, { savedAt: Date.now() - HOUR, revalidatedAt: Date.now() - HOUR });
		const fetch = fetchMock(async () => jsonResponse(NEW_OWO));
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(items(container).length).toBeGreaterThan(0));
		expect(fetch.calls).toEqual([]);
		expect(tabs(container).map((tab) => tab.textContent.trim())).toEqual(['颜文字', 'Bilibili']);
	});

	it('后台校验拿到的内容没变时界面不动，也不会清空表情', async () => {
		seedCache(OWO, { savedAt: Date.now() - HOUR, revalidatedAt: Date.now() - 7 * HOUR });
		const fetch = fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(fetch.calls.length).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(tabs(container).map((tab) => tab.textContent.trim())).toEqual(['颜文字', 'Bilibili']);
		expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']);
		expect(panel(container).textContent).not.toContain('表情加载失败');
	});

	it('后台校验失败时保留缓存里的表情，不显示错误、不变成空态', async () => {
		seedCache(OWO, { savedAt: Date.now() - HOUR, revalidatedAt: Date.now() - 7 * HOUR });
		const fetch = fetchMock(async () => {
			throw new Error('network down');
		});
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(fetch.calls.length).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(tabs(container).length).toBe(2);
		expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']);
		expect(panel(container).textContent).not.toContain('表情加载失败');
		expect(byTest('emoji-empty')).toBeNull();
	});

	it('手动刷新入口：缓存再新也能强拉一次（no-cache），成功后替换面板', async () => {
		seedCache(OWO, { savedAt: Date.now(), revalidatedAt: Date.now() });
		const fetch = fetchMock(async () => jsonResponse(NEW_OWO));
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(tabs(container).length).toBe(2));
		expect(fetch.calls).toEqual([]);

		const refreshButton = byTest('emoji-refresh');
		expect(refreshButton).toBeTruthy();
		expect(refreshButton.getAttribute('aria-label')).toBe('刷新表情');

		await fireEvent.click(refreshButton);
		await waitFor(() => expect(tabs(container).map((tab) => tab.textContent.trim())).toEqual(['新标签']));
		expect(fetch.calls.length).toBe(1);
		expect(fetch.calls[0].init.cache).toBe('no-cache');
	});

	it('手动刷新失败时保留已有表情并用 stale 提示（不整块变错误页）', async () => {
		seedCache(OWO, { savedAt: Date.now(), revalidatedAt: Date.now() });
		fetchMock(async () => {
			throw new Error('network down');
		});
		const { container } = renderPicker();

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(tabs(container).length).toBe(2));

		await fireEvent.click(byTest('emoji-refresh'));
		await waitFor(() => expect(byTest('emoji-stale')).toBeTruthy());
		expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']);
		expect(panel(container).textContent).not.toContain('表情加载失败');
	});
});
