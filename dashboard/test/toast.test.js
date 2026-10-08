import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import toast, { toast as namedToast } from '../src/utils/toast.js';

const allToasts = () => [...document.body.querySelectorAll('[id^="toast-"]')];
const lastToast = () => document.body.lastElementChild;
const textOf = (el) => el.querySelector('span')?.textContent;

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

describe('toast 导出形态', () => {
	it('默认导出与具名导出是同一个函数', () => {
		expect(namedToast).toBe(toast);
		expect(typeof toast).toBe('function');
	});

	it.each(['success', 'error', 'warning', 'info'])('挂载了 %s 方法', (level) => {
		expect(typeof toast[level]).toBe('function');
	});

	it('各方法返回 undefined', () => {
		expect(toast.success('a')).toBeUndefined();
		expect(toast.error('b')).toBeUndefined();
		expect(toast.warning('c')).toBeUndefined();
		expect(toast.info('d')).toBeUndefined();
		expect(toast('e')).toBeUndefined();
	});
});

describe('toast 渲染与分级', () => {
	it('success 把消息渲染到 body 中的 span 里', () => {
		toast.success('保存成功');
		const el = lastToast();
		expect(el.id).toMatch(/^toast-\d+$/);
		expect(el.parentElement).toBe(document.body);
		expect(textOf(el)).toBe('保存成功');
	});

	it.each([
		['success', 'fa-circle-check'],
		['error', 'fa-circle-xmark'],
		['warning', 'fa-circle-exclamation'],
		['info', 'fa-circle-info'],
	])('%s 使用图标 %s', (level, iconClass) => {
		toast[level]('消息');
		const icon = lastToast().querySelector('i');
		expect(icon.className).toContain('fa-solid');
		expect(icon.className).toContain(iconClass);
	});

	it('未指定类型时按 info 渲染', () => {
		toast('默认消息');
		expect(lastToast().querySelector('i').className).toContain('fa-circle-info');
	});

	it('不同级别的配色互不相同', () => {
		const backgrounds = new Map();
		for (const level of ['success', 'error', 'warning', 'info']) {
			toast[level]('x');
			backgrounds.set(level, lastToast().style.backgroundColor || lastToast().style.background);
		}
		const values = [...backgrounds.values()];
		values.forEach((v) => expect(v).toBeTruthy());
		expect(new Set(values).size).toBe(4);
	});

	it('固定定位在右上角且 z-index 最高', () => {
		toast.info('x');
		const { style } = lastToast();
		expect(style.position).toBe('fixed');
		expect(style.top).toBe('16px');
		expect(style.right).toBe('16px');
		expect(style.zIndex).toBe('9999');
		expect(style.display).toBe('flex');
	});

	it('初始不可见（opacity 0 + 位移）', () => {
		toast.info('x');
		const { style } = lastToast();
		expect(style.opacity).toBe('0');
		expect(style.transform).toBe('translateX(100%)');
	});

	it('下一帧切换为可见状态', async () => {
		toast.info('x');
		const el = lastToast();
		await new Promise((resolve) => requestAnimationFrame(() => resolve()));
		expect(el.style.opacity).toBe('1');
		expect(el.style.transform).toBe('translateX(0)');
	});
});

describe('toast 消息内容与安全性', () => {
	it('undefined 渲染为空文本', () => {
		toast.success(undefined);
		expect(textOf(lastToast())).toBe('');
	});

	it('null 渲染为空文本', () => {
		toast.error(null);
		expect(textOf(lastToast())).toBe('');
	});

	it('数字会被转成字符串', () => {
		toast.info(42);
		expect(textOf(lastToast())).toBe('42');
	});

	it('对象会被转成字符串', () => {
		toast.info({ a: 1 });
		expect(textOf(lastToast())).toBe('[object Object]');
	});

	it('HTML 消息不会被解析为 DOM（防 DOM XSS）', () => {
		const payload = '<img src=x onerror="window.__xss=1">';
		toast.error(payload);
		const el = lastToast();
		expect(el.querySelector('img')).toBeNull();
		expect(textOf(el)).toBe(payload);
		expect(window.__xss).toBeUndefined();
	});

	it('script 标签也不会被解析', () => {
		toast.warning('<script>window.__xss2=1</script>');
		expect(lastToast().querySelector('script')).toBeNull();
		expect(window.__xss2).toBeUndefined();
	});

	it('消息来自服务端响应时按纯文本处理', () => {
		toast.error('<b>bold</b>');
		const el = lastToast();
		expect(el.querySelector('b')).toBeNull();
		expect(textOf(el)).toBe('<b>bold</b>');
	});
});

describe('toast 生命周期', () => {
	it('多次调用生成递增且唯一的 id', () => {
		toast.info('1');
		toast.info('2');
		toast.info('3');
		const ids = allToasts().map((el) => el.id);
		expect(new Set(ids).size).toBe(3);
		expect(ids).toHaveLength(3);
	});

	it('多次调用会叠加而不会移除已有提示', () => {
		toast.info('1');
		toast.success('2');
		expect(allToasts()).toHaveLength(2);
	});

	it('默认 3000ms 内元素保留在 DOM 中', () => {
		vi.useFakeTimers();
		toast.info('x');
		const el = lastToast();
		vi.advanceTimersByTime(2999);
		expect(document.body.contains(el)).toBe(true);
		vi.useRealTimers();
	});

	it('默认 3000ms 后淡出，再过 250ms 移除元素', () => {
		vi.useFakeTimers();
		toast.info('x');
		const el = lastToast();
		vi.advanceTimersByTime(3000);
		expect(el.style.opacity).toBe('0');
		expect(el.style.transform).toBe('translateX(100%)');
		expect(document.body.contains(el)).toBe(true);
		vi.advanceTimersByTime(250);
		expect(document.body.contains(el)).toBe(false);
		vi.useRealTimers();
	});

	it('未知级别因缺少兜底会抛 TypeError（已记录的缺陷）', () => {
		// show() 里 styles[type] 未做 fallback：type 非法时读取 iconClass 抛错。
		expect(() => toast('msg', 'nope')).toThrow(TypeError);
	});
});
