/**
 * src/utils/rateLimit.ts —— 单 isolate 滑动窗口限流。
 *
 * 模块级 buckets 在同一个测试文件内跨用例共享，因此每个用例都使用独立的 key。
 */
import { describe, it, expect } from 'vitest';
import { allowRequest } from '../../src/utils/rateLimit';

const WINDOW = 60 * 1000;

/** 把限制填满（返回第 1..limit 次的结果） */
function fill(key: string, limit: number) {
	return Array.from({ length: limit }, () => allowRequest(key, limit, WINDOW));
}

describe('allowRequest —— 基本计数', () => {
	it('未超过上限时全部放行', () => {
		expect(fill('basic-allow', 5)).toEqual([true, true, true, true, true]);
	});

	it('达到上限后拒绝', () => {
		expect(fill('basic-deny', 3)).toEqual([true, true, true]);
		expect(allowRequest('basic-deny', 3, WINDOW)).toBe(false);
		expect(allowRequest('basic-deny', 3, WINDOW)).toBe(false);
	});

	it('limit = 1 时第二次即被拒绝', () => {
		expect(allowRequest('one', 1, WINDOW)).toBe(true);
		expect(allowRequest('one', 1, WINDOW)).toBe(false);
	});

	it('不同 key 互不影响', () => {
		expect(allowRequest('key-a', 1, WINDOW)).toBe(true);
		expect(allowRequest('key-a', 1, WINDOW)).toBe(false);
		expect(allowRequest('key-b', 1, WINDOW)).toBe(true);
		expect(allowRequest('key-b', 1, WINDOW)).toBe(false);
	});

	it('limit = 0 时已有 key 立即被拒绝', () => {
		// key 需要先存在于 buckets 中，否则会走 MAX_BUCKETS 兜底分支
		expect(allowRequest('zero-limit', 1, WINDOW)).toBe(true);
		expect(allowRequest('zero-limit', 0, WINDOW)).toBe(false);
	});
});

describe('allowRequest —— 滑动窗口', () => {
	// 窗口取 60ms：既能稳定观察到「窗口内拒绝」，也能在短暂等待后观察到窗口滑过，
	// 不会因为两次调用之间刚好跨过 1ms 而抖动。
	it('窗口过期后重新放行', async () => {
		const key = 'expire-60ms';
		expect(allowRequest(key, 1, 60)).toBe(true);
		expect(allowRequest(key, 1, 60)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(allowRequest(key, 1, 60)).toBe(true);
	});

	it('窗口滑过后旧命中被丢弃，计数从头开始', async () => {
		const key = 'partial-window';
		expect(allowRequest(key, 3, 60)).toBe(true);
		expect(allowRequest(key, 3, 60)).toBe(true);
		expect(allowRequest(key, 3, 60)).toBe(true);
		expect(allowRequest(key, 3, 60)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(allowRequest(key, 3, 60)).toBe(true);
		expect(allowRequest(key, 3, 60)).toBe(true);
		expect(allowRequest(key, 3, 60)).toBe(true);
		expect(allowRequest(key, 3, 60)).toBe(false);
	});
});

describe('allowRequest —— 桶数量上限的 fail-open 行为', () => {
	it('桶数达到 MAX_BUCKETS(2000) 后，新 key 一律放行', () => {
		// 填满桶表：每个 key 占一个桶
		for (let i = 0; i < 2000; i++) {
			expect(allowRequest(`cap-${i}`, 100, WINDOW)).toBe(true);
		}
		// 新 key + limit=0：若桶表未满本应被拒绝，这里应当 fail-open 返回 true
		expect(allowRequest('cap-overflow', 0, WINDOW)).toBe(true);
		// 已有 key 仍按 limit 判定
		expect(allowRequest('cap-0', 0, WINDOW)).toBe(false);
	});
});
