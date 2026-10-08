import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { waitFor, cleanup } from '@testing-library/svelte';
import momoDefault from '../src/main.ts';

/**
 * 这里是 IIFE 包的入口：`window.momo.init(...)` 是宿主页面唯一的调用方式。
 * 注意：main.ts 会 import './style/main.css'（含 @import "tailwindcss"），
 * 首个用例会有几秒的 CSS 处理耗时，属于正常现象。
 */
const API_URL = 'https://api.example.com';
const listBody = (comments = []) => ({ data: { comments, pagination: { totalPage: 1 } } });

const makeComment = (over = {}) => ({
	id: 1,
	author: 'Alice',
	contentHtml: '<p>hello</p>',
	contentText: 'hello',
	pubDate: 1730000000000,
	parentId: null,
	url: '',
	...over,
});

function mountTarget(id = 'momo-root') {
	const el = document.createElement('div');
	el.id = id;
	document.body.appendChild(el);
	return el;
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, status: 200, json: async () => listBody([makeComment()]) }))
	);
});

afterEach(() => {
	// main.ts 的 init 不返回实例，这里直接清空 DOM（组件本身已不在测试断言范围内）
	document.body.innerHTML = '';
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('main.ts —— 全局入口', () => {
	it('import 时把 momo 挂到 window 上', () => {
		expect(typeof window.momo).toBe('object');
		expect(typeof window.momo.init).toBe('function');
	});

	it('默认导出与 window.momo 是同一个对象', () => {
		expect(momoDefault).toBe(window.momo);
		expect(momoDefault.init).toBe(window.momo.init);
	});

	it('目标元素不存在时报错但不抛异常', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => window.momo.init({ el: '#not-exist', apiUrl: API_URL, slugId: '/posts/demo' })).not.toThrow();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0][0]).toBe('Target element #not-exist not found.');
	});

	it('目标元素存在时挂载评论组件并加载评论', async () => {
		mountTarget();
		window.momo.init({ el: '#momo-root', apiUrl: API_URL, slugId: '/posts/demo' });
		await waitFor(() => expect(document.querySelector('#comments')).toBeTruthy());
		await waitFor(() => expect(document.querySelector('#comments').textContent).toContain('1 条评论'));
		expect(document.querySelector('#momo-root #comments')).toBeTruthy();
	});

	it('默认语言为 zh-cn', async () => {
		mountTarget();
		window.momo.init({ el: '#momo-root', apiUrl: API_URL, slugId: '/posts/demo' });
		await waitFor(() => expect(document.querySelector('#author')).toBeTruthy());
		expect(document.querySelector('label[for="author"]').textContent).toContain('昵称');
	});

	it('lang 选项会传给组件（en）', async () => {
		mountTarget();
		window.momo.init({ el: '#momo-root', apiUrl: API_URL, slugId: '/posts/demo', lang: 'en' });
		await waitFor(() => expect(document.querySelector('#author')).toBeTruthy());
		expect(document.querySelector('label[for="author"]').textContent).toContain('Name');
	});

	it('slugId 会作为请求参数', async () => {
		mountTarget();
		window.momo.init({ el: '#momo-root', apiUrl: API_URL, slugId: '/posts/带中文' });
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		expect(String(fetch.mock.calls[0][0])).toContain(`post_slug=${encodeURIComponent('/posts/带中文')}`);
	});

	it('未传 title 时回退到 document.title（提交请求里会带上）', async () => {
		const alertSpy = vi.fn();
		vi.stubGlobal('alert', alertSpy);
		document.title = '页面标题';
		mountTarget();
		window.momo.init({ el: '#momo-root', apiUrl: API_URL, slugId: '/posts/demo' });
		await waitFor(() => expect(document.querySelector('#comments')).toBeTruthy());
		await waitFor(() => expect(document.querySelector('#comments').textContent).toContain('1 条评论'));

		const { fireEvent } = await import('@testing-library/svelte');
		await fireEvent.input(document.querySelector('#author'), { target: { value: 'Me' } });
		await fireEvent.input(document.querySelector('#email'), { target: { value: 'me@example.com' } });
		await fireEvent.input(document.querySelector('textarea'), { target: { value: 'hi' } });
		await fireEvent.submit(document.querySelector('form'));
		await waitFor(() => expect(fetch.mock.calls.some((c) => c[1]?.method === 'POST')));
		const post = fetch.mock.calls.find((c) => c[1]?.method === 'POST');
		expect(JSON.parse(post[1].body).post_title).toBe('页面标题');
		expect(JSON.parse(post[1].body).post_slug).toBe('/posts/demo');
	});
});
