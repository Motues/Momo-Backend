import { vi } from 'vitest';

/**
 * 构造一条「组件口径」的评论对象。
 *
 * 注意：后端返回的是 snake_case（pub_date / content_html / parent_id ...），
 * 组件内部统一使用 camelCase。这里刻意不提供 snake_case 字段，
 * 以便测试能暴露字段口径不一致的问题。
 */
export function makeComment(overrides = {}) {
	return {
		id: 1,
		author: 'Alice',
		contentHtml: '<p>hello</p>',
		contentText: 'hello',
		pubDate: 1730000000000, // Unix 毫秒
		status: 'approved',
		parentId: null,
		avatar: '',
		url: '',
		device: '',
		browser: '',
		os: '',
		...overrides,
	};
}

/** fetch 响应替身：默认 200 + JSON */
export function jsonResponse(body, init = {}) {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		...init,
	};
}

/**
 * 覆盖 window.matchMedia。
 * happy-dom 默认窗口宽度 1024，`(max-width: 767px)` 不匹配（桌面端路径）。
 *
 * 返回的函数用于还原；额外挂载 `change(matches)` 可手动触发媒体查询变化，
 * 以及 `listenerCount()` 用于断言监听器是否被正确清理。
 * @param {boolean} matches 是否命中媒体查询（true = 移动端）
 */
export function stubMatchMedia(matches) {
	const original = window.matchMedia;
	const listeners = new Set();
	let current = matches;

	window.matchMedia = (query) => ({
		get matches() {
			return current;
		},
		media: query,
		onchange: null,
		addEventListener(type, fn) {
			if (type === 'change') listeners.add(fn);
		},
		removeEventListener(type, fn) {
			listeners.delete(fn);
		},
		addListener(fn) {
			listeners.add(fn);
		},
		removeListener(fn) {
			listeners.delete(fn);
		},
		dispatchEvent: () => false,
	});

	const restore = () => {
		window.matchMedia = original;
	};
	restore.change = (next) => {
		current = next;
		for (const fn of [...listeners]) fn({ matches: next, media: '(max-width: 767px)' });
	};
	restore.listenerCount = () => listeners.size;
	return restore;
}

/** 安装可观测的 alert（happy-dom 默认没有可用的 alert） */
export function stubAlert() {
	const spy = vi.fn();
	vi.stubGlobal('alert', spy);
	return spy;
}

/** 按文本找按钮 */
export function findButton(container, text) {
	return [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
}

/** 计算 SHA-256 十六进制（与组件内部口径一致：先 toLowerCase().trim()） */
export async function sha256HexOf(text) {
	const data = new TextEncoder().encode(text.toLowerCase().trim());
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * 中和 happy-dom + WAAPI 的测试环境噪声。
 *
 * CommentItem 的回复框用了 `transition:slide`，Svelte 在销毁该元素时会调用
 * `animation.cancel()`；happy-dom 的 `Animation.cancel()` 会 reject 内部的
 * `finished` promise，而 Svelte 只使用 `onfinish`、不消费该 promise，
 * 于是 vitest 会把它报成 Unhandled Rejection 并让进程以非 0 退出。
 *
 * 这里在 cancel 之前给 finished 挂一个空 catch（纯测试环境处理，不涉及生产代码，
 * 也不影响任何断言）。每个测试文件调用一次即可。
 */
export function patchHappyDomAnimation() {
	const proto = window.Animation?.prototype;
	if (!proto || proto.cancel.patchedByMomo) return;

	const original = proto.cancel;
	const patched = function patchedCancel(...args) {
		this.finished?.catch?.(() => {});
		return original.apply(this, args);
	};
	patched.patchedByMomo = true;
	proto.cancel = patched;
}
