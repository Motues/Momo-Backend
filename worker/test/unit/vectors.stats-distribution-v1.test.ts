import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/stats-distribution-v1.json';
import {
	DISTRIBUTION_LIMIT,
	mergeDistribution,
	normalizeBrowserFamily,
	normalizeDeviceType,
	normalizeOSFamily
} from '../../src/utils/statsDistribution';

/**
 * 客户端分布归一化契约 v1 的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里没有文件系统，vitest 会把 JSON 打包进来。
 */

describe('vectors/stats-distribution-v1 — 浏览器家族名', () => {
	for (const testCase of fixture.browser) {
		it(`${JSON.stringify(testCase.raw)} → ${testCase.expected}`, () => {
			expect(normalizeBrowserFamily(testCase.raw)).toBe(testCase.expected);
		});
	}
});

describe('vectors/stats-distribution-v1 — 操作系统家族名', () => {
	for (const testCase of fixture.os) {
		it(`${JSON.stringify(testCase.raw)} → ${testCase.expected}`, () => {
			expect(normalizeOSFamily(testCase.raw)).toBe(testCase.expected);
		});
	}
});

describe('vectors/stats-distribution-v1 — 设备类型', () => {
	for (const testCase of fixture.device) {
		it(`${JSON.stringify(testCase.raw)} → ${testCase.expected}`, () => {
			expect(normalizeDeviceType(testCase.raw)).toBe(testCase.expected);
		});
	}
});

describe('vectors/stats-distribution-v1 — 合并 / 排序 / 截断', () => {
	it('同名家族合并计数', () => {
		const merged = mergeDistribution(
			[
				{ name: 'Chrome 142.0.0.0', count: 2 },
				{ name: 'Chrome 145.0.0.0', count: 3 },
				{ name: '  Chrome  ', count: 1 }
			],
			normalizeBrowserFamily
		);
		expect(merged).toEqual([{ name: 'Chrome', count: 6 }]);
	});

	it('按数量降序，并列按名称升序（Unicode 码点序）', () => {
		const merged = mergeDistribution(
			[
				{ name: 'Safari 17.0', count: 2 },
				{ name: 'Edge 147.0.0.0', count: 2 },
				{ name: 'Chrome 142.0.0.0', count: 2 }
			],
			normalizeBrowserFamily
		);
		expect(merged.map((item) => item.name)).toEqual(['Chrome', 'Edge', 'Safari']);
	});

	it(`默认最多下发 ${DISTRIBUTION_LIMIT} 档`, () => {
		const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((letter) => ({
			name: `${letter} 1.0`,
			count: 1
		}));
		expect(mergeDistribution(rows, normalizeBrowserFamily)).toHaveLength(DISTRIBUTION_LIMIT);
		expect(DISTRIBUTION_LIMIT).toBe(5);
	});

	it('空行集返回空数组', () => {
		expect(mergeDistribution([], normalizeBrowserFamily)).toEqual([]);
	});

	it('设备列的空值与原始 UA 分别归入桌面与未知', () => {
		const merged = mergeDistribution(
			[
				{ name: null, count: 1 },
				{ name: '', count: 1 },
				{ name: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', count: 1 },
				{ name: 'iPhone', count: 1 }
			],
			normalizeDeviceType
		);
		// 数量降序：桌面(2)；并列的 未知 / 移动 按名称升序（未 U+672A < 移 U+79FB）
		expect(merged).toEqual([
			{ name: '桌面', count: 2 },
			{ name: '未知', count: 1 },
			{ name: '移动', count: 1 }
		]);
	});
});
