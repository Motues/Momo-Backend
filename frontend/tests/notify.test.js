import { describe, it, expect, vi, afterEach } from 'vitest';
import { notify } from '../src/utils/notify';

// 说明：notify 只是 alert 的一层「防宿主拦截」包装，不做 DOM 渲染、不区分类型、
// 也不存在「清理上一次插入的节点」的逻辑（详见最终报告中的说明）。
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('notify —— 正常路径', () => {
	it('调用全局 alert 且只传一条消息', () => {
		const alertSpy = vi.fn();
		vi.stubGlobal('alert', alertSpy);

		notify('hello');

		expect(alertSpy).toHaveBeenCalledTimes(1);
		expect(alertSpy).toHaveBeenCalledWith('hello');
	});

	it('返回 undefined（调用方无法感知是否弹出）', () => {
		vi.stubGlobal('alert', vi.fn());
		expect(notify('x')).toBeUndefined();
	});

	it('连续调用会重复弹窗，没有去重或节流', () => {
		const alertSpy = vi.fn();
		vi.stubGlobal('alert', alertSpy);

		notify('a');
		notify('b');

		expect(alertSpy.mock.calls).toEqual([['a'], ['b']]);
	});

	it('空字符串也会原样传给 alert', () => {
		const alertSpy = vi.fn();
		vi.stubGlobal('alert', alertSpy);

		notify('');

		expect(alertSpy).toHaveBeenCalledWith('');
	});

	it('不修改传入的字符串，也不写 DOM', () => {
		vi.stubGlobal('alert', vi.fn());
		const before = document.body.innerHTML;

		notify('中文提示 🎉');

		expect(document.body.innerHTML).toBe(before);
	});
});

describe('notify —— alert 不可用时的降级', () => {
	it('alert 抛错时被吞掉，并输出 console.warn', () => {
		const error = new Error('alert blocked');
		vi.stubGlobal('alert', () => {
			throw error;
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		expect(() => notify('boom')).not.toThrow();

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toBe('[momo-comment] alert is unavailable:');
		expect(warn.mock.calls[0][1]).toBe('boom');
		expect(warn.mock.calls[0][2]).toBe(error);
	});

	it('alert 不是函数（宿主页面删掉了它）时不抛错', () => {
		vi.stubGlobal('alert', undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		expect(() => notify('still fine')).not.toThrow();

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][1]).toBe('still fine');
	});

	it('alert 抛非 Error 值也能被吞掉', () => {
		vi.stubGlobal('alert', () => {
			throw 'string-error';
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		expect(() => notify('weird')).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('宿主 alert 抛错后，后续逻辑仍可继续（返回值 undefined）', () => {
		vi.stubGlobal('alert', () => {
			throw new Error('nope');
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		let reached = false;
		notify('x');
		reached = true;

		expect(reached).toBe(true);
	});
});
