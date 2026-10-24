import { describe, it, expect, beforeEach, vi } from 'vitest';

const putMock = vi.hoisted(() => vi.fn());
vi.mock('../src/utils/request.js', () => ({ default: { put: putMock } }));

import {
	BATCH_CASCADE_STATUSES,
	BATCH_STATUS_LABELS,
	updateCommentsStatus,
} from '../src/utils/batchModeration.js';

beforeEach(() => {
	putMock.mockReset();
	putMock.mockResolvedValue({ code: 200 });
});

describe('batchModeration - updateCommentsStatus', () => {
	it('逐条调用既有单条接口，参数形式与单条审核一致', async () => {
		const result = await updateCommentsStatus([1, 2], 'approved');

		expect(putMock.mock.calls.map((call) => call[0])).toEqual([
			'/admin/comments/status?id=1&status=approved',
			'/admin/comments/status?id=2&status=approved',
		]);
		expect(result).toMatchObject({ total: 2, succeeded: 2, failed: [], failedIds: [] });
	});

	it('id 去重，空输入不发请求', async () => {
		const empty = await updateCommentsStatus([], 'approved');
		expect(empty).toEqual({ total: 0, succeeded: 0, failed: [], failedIds: [] });
		expect(putMock).not.toHaveBeenCalled();

		await updateCommentsStatus([3, 3, 3], 'deleted');
		expect(putMock).toHaveBeenCalledTimes(1);
		expect(putMock).toHaveBeenCalledWith('/admin/comments/status?id=3&status=deleted');
	});

	it('单条失败不影响其它项，返回失败 id 便于重试', async () => {
		putMock.mockImplementation(async (url) => {
			if (url.includes('id=2')) throw new Error('boom');
			return { code: 200 };
		});

		const result = await updateCommentsStatus([1, 2, 3], 'pending');

		expect(result.total).toBe(3);
		expect(result.succeeded).toBe(2);
		expect(result.failedIds).toEqual([2]);
		expect(result.failed[0].id).toBe(2);
	});

	it('并发受 concurrency 限制（默认 4，上限 10）', async () => {
		let active = 0;
		let peak = 0;
		putMock.mockImplementation(async () => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return { code: 200 };
		});

		await updateCommentsStatus([1, 2, 3, 4, 5, 6], 'approved', { concurrency: 2 });
		expect(peak).toBeLessThanOrEqual(2);
		expect(putMock).toHaveBeenCalledTimes(6);
	});

	it('状态文案与级联状态清单是稳定契约', () => {
		expect(BATCH_STATUS_LABELS).toEqual({
			approved: '通过',
			pending: '打回待审',
			deleted: '删除',
		});
		// deleted / pending 在单条接口里会级联到子孙回复，确认框必须提示
		expect(BATCH_CASCADE_STATUSES).toEqual(['pending', 'deleted']);
	});
});
