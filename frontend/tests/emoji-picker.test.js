import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import EmojiPicker from '../src/emoji/EmojiPicker.svelte';
import { EMOJI_CACHE_PREFIX, resetEmojiSetCache } from '../src/emoji/owo';

const CDN = 'https://cdn.example.com/emoji/owo.json';
const PNG = 'https://cdn.example.com/emoji/doge.png';

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
	return render(EmojiPicker, { props: { cdnUrl: CDN, language: 'zh-cn', ...props } });
}

const trigger = (container) => container.querySelector('[data-test="emoji-trigger"]');
const panel = (container) => container.querySelector('[data-test="emoji-panel"]');
const tabs = (container) => [...container.querySelectorAll('[data-test="emoji-tab"]')];
const items = (container) => [...container.querySelectorAll('[data-test="emoji-item"]')];

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
			`${EMOJI_CACHE_PREFIX}${CDN}`,
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

	it('cdnUrl 为空时按钮禁用：点击不打开面板也不发请求', async () => {
		const fetch = fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker({ cdnUrl: '' });

		expect(trigger(container).disabled).toBe(true);
		await fireEvent.click(trigger(container));
		expect(panel(container)).toBeNull();
		expect(fetch.calls).toEqual([]);
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
		await waitFor(() => expect(container.querySelector('[data-test="emoji-retry"]')).toBeTruthy());
		expect(panel(container).textContent).toContain('表情加载失败');
		expect(items(container)).toEqual([]);

		await fireEvent.click(container.querySelector('[data-test="emoji-retry"]'));
		await waitFor(() => expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']));
		expect(fetch.calls.length).toBe(2);
	});

	it('拉取失败但本地有过期缓存时用旧缓存并显示 stale 提示', async () => {
		fetchMock(async () => {
			throw new Error('network down');
		});
		localStorage.setItem(
			`${EMOJI_CACHE_PREFIX}${CDN}`,
			JSON.stringify({ savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, packs: OWO })
		);
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(container.querySelector('[data-test="emoji-stale"]')).toBeTruthy());
		expect(items(container).map((item) => item.dataset.insert)).toEqual(['OωO']);
		expect(panel(container).textContent).toContain('本地缓存');
	});

	it('没有可渲染的表情时显示空态', async () => {
		fetchMock(async () => jsonResponse({ 空标签: { type: 'image', container: [] } }));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(container.querySelector('[data-test="emoji-empty"]')).toBeTruthy());
		expect(panel(container).textContent).toContain('暂无可用的表情');
		expect(items(container)).toEqual([]);
	});

	it('响应形状不对时按加载失败处理（重试按钮而非空态）', async () => {
		fetchMock(async () => jsonResponse(['not', 'an', 'object']));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));

		await waitFor(() => expect(container.querySelector('[data-test="emoji-retry"]')).toBeTruthy());
		expect(container.querySelector('[data-test="emoji-empty"]')).toBeNull();
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

	it('面板开在按钮下方（top-full），不与输入框争位置', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel(container)).toBeTruthy());

		expect(panel(container).className).toContain('top-full');
		expect(panel(container).className).not.toContain('bottom-full');
		expect(panel(container).className).toContain('mt-2');
		// 圆角比原来的 rounded-lg（0.5rem）更小
		expect(panel(container).className).toContain('rounded ');
		expect(panel(container).className).not.toContain('rounded-lg');
	});

	it('视口下方空间充足时面板高度用上限封顶', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel(container)).toBeTruthy());

		// happy-dom 里 getBoundingClientRect 全为 0，等价于按钮就在视口顶部
		expect(panel(container).style.maxHeight).toBe('256px');
	});

	it('页面底部空间不足时按剩余空间压低面板高度', async () => {
		fetchMock(async () => jsonResponse(OWO));
		const { container } = renderPicker();
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
			top: 600, bottom: 660, left: 0, right: 40, width: 40, height: 60, x: 0, y: 600,
		});

		await fireEvent.click(trigger(container));
		await waitFor(() => expect(panel(container)).toBeTruthy());

		// 768 - 660 - 8（mt-2）- 12（视口留白）= 88 → 取最小高度 96
		const expected = Math.round(
			Math.min(256, Math.max(96, window.innerHeight - 660 - 20))
		);
		expect(expected).toBeLessThan(256);
		expect(panel(container).style.maxHeight).toBe(`${expected}px`);
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

		const tablist = container.querySelector('[role="tablist"]');
		expect(tablist.className).not.toContain('overflow-x-auto');
		expect(tablist.className).toContain('flex-wrap');

		const list = container.querySelector('[data-test="emoji-list"]');
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
