import { describe, it, expect, beforeEach } from 'vitest';
import { emojify, hydrateEmojis } from '../src/emoji/render';

const PNG = 'https://cdn.example.com/emoji/doge.png';
const PNG2 = 'https://cdn.example.com/emoji/hi.png';

function images(pairs = [[ 'doge', PNG ]]) {
	return new Map(pairs);
}

/** 造一个挂在 document 上的容器（水合器需要 ownerDocument） */
function container(html) {
	const el = document.createElement('div');
	el.innerHTML = html;
	document.body.appendChild(el);
	return el;
}

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('emoji/render —— hydrateEmojis', () => {
	it('把 :name: 替换成 <img class="momo-emoji">，两侧文本保留', () => {
		const root = container('<p>你好 :doge: 世界</p>');
		expect(hydrateEmojis(root, images())).toBe(1);

		const img = root.querySelector('img.momo-emoji');
		expect(img).toBeTruthy();
		expect(img.getAttribute('src')).toBe(PNG);
		expect(img.getAttribute('alt')).toBe(':doge:');
		expect(img.getAttribute('title')).toBe(':doge:');
		expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(root.querySelector('p').textContent).toBe('你好  世界');
		expect(root.querySelectorAll('img').length).toBe(1);
	});

	it('同一段文本里的多个短代码都会被替换', () => {
		const root = container('<p>:doge: 和 :hi:</p>');
		hydrateEmojis(root, images([
			['doge', PNG],
			['hi', PNG2],
		]));
		const srcs = [...root.querySelectorAll('img.momo-emoji')].map((img) => img.getAttribute('src'));
		expect(srcs).toEqual([PNG, PNG2]);
	});

	it('<code> / <pre> 内的文本不替换，普通文本照常替换', () => {
		const root = container('<p>:doge:</p><code>:doge:</code><pre>:doge:</pre>');
		hydrateEmojis(root, images());
		expect(root.querySelectorAll('img.momo-emoji').length).toBe(1);
		expect(root.querySelector('code').textContent).toBe(':doge:');
		expect(root.querySelector('pre').textContent).toBe(':doge:');
	});

	it('未命中的短代码原样保留（表情换源后优雅降级为纯文本）', () => {
		const root = container('<p>:unknown: 与 :doge:</p>');
		hydrateEmojis(root, images());
		expect(root.textContent).toBe(':unknown: 与 ');
		expect(root.querySelectorAll('img').length).toBe(1);
	});

	it('幂等：跑两次不会重复插图片', () => {
		const root = container('<p>:doge:</p>');
		expect(hydrateEmojis(root, images())).toBe(1);
		expect(hydrateEmojis(root, images())).toBe(0);
		expect(root.querySelectorAll('img.momo-emoji').length).toBe(1);
	});

	it('images 为 null / 空 Map / 空容器时是安全的空操作', () => {
		const root = container('<p>:doge:</p>');
		expect(hydrateEmojis(root, undefined)).toBe(0);
		expect(hydrateEmojis(root, new Map())).toBe(0);
		expect(hydrateEmojis(null, images())).toBe(0);
		expect(root.textContent).toBe(':doge:');
	});
});

describe('emoji/render —— emojify action', () => {
	it('初始参数就带 images 时立即水合', () => {
		const node = document.createElement('div');
		node.innerHTML = '<p>:doge:</p>';
		const action = emojify(node, { images: images(), html: '<p>:doge:</p>' });
		expect(node.querySelectorAll('img.momo-emoji').length).toBe(1);
		action.destroy();
	});

	it('初始 images 为空，集合异步到达后 update 会补水合', () => {
		const node = document.createElement('div');
		node.innerHTML = '<p>:doge:</p>';
		const action = emojify(node, { images: null, html: '<p>:doge:</p>' });
		expect(node.querySelectorAll('img').length).toBe(0);

		action.update({ images: images(), html: '<p>:doge:</p>' });
		expect(node.querySelectorAll('img.momo-emoji').length).toBe(1);

		// 再次 update（例如本地缓存被写回）依旧幂等
		action.update({ images: images(), html: '<p>:doge:</p>' });
		expect(node.querySelectorAll('img.momo-emoji').length).toBe(1);
		action.destroy();
	});

	it('{@html} 整体替换 innerHTML 后 update 能重新水合', () => {
		const node = document.createElement('div');
		node.innerHTML = '<p>:doge:</p>';
		const action = emojify(node, { images: images(), html: '<p>:doge:</p>' });
		expect(node.querySelectorAll('img').length).toBe(1);

		// 模拟 Svelte 的 {@html} 更新：内容被整体替换，之前的水合结果丢失
		node.innerHTML = '<p>:doge: 追加</p>';
		action.update({ images: images(), html: '<p>:doge: 追加</p>' });
		expect(node.querySelectorAll('img.momo-emoji').length).toBe(1);
		expect(node.textContent).toBe(' 追加');
		action.destroy();
	});
});
