import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

// 趋势横坐标与区间文本都按浏览器本地时区换算，断言因此依赖进程时区：
// 固定成 Asia/Shanghai（UTC+8），保证在任何机器上跑出的结果一致。
process.env.TZ = 'Asia/Shanghai';

/* ---------- 依赖 mock ---------- */
const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import VerifyRecords from '../src/views/VerifyRecords.vue';
import MultiLineChart from '../src/components/charts/MultiLineChart.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

/**
 * 认证记录页的约束：
 *  - 指标卡、趋势、Top 榜单、明细四块都要用同一份 overview 数据渲染；
 *  - Node / Go 部署返回 geoSupported: false 时，地区与运营商榜单必须整块消失
 *    （否则页面会长期显示两个「暂无数据」的空面板）；
 *  - 时间范围与窗口偏移必须真实传给接口，翻页与筛选改变对应查询参数。
 */

const makeOverview = (overrides = {}) => ({
	code: 200,
	message: 'Verify stats fetched successfully',
	data: {
		range: {
			days: 30,
			offset: 0,
			from: '2026-03-28T00:00:00.000Z',
			to: '2026-04-26T23:59:59.999Z',
			bucket: 'day',
		},
		summary: {
			challenges: 2400,
			challengesDelta: 20,
			verified: 2200,
			verifiedDelta: 11,
			failed: 142,
			failedDelta: -85,
			avgDurationMs: 5000,
			avgDurationDelta: -12,
			passRate: 93.9,
		},
		trend: [
			{ date: '2026-04-25', challenges: 120, verified: 110, failed: 7 },
			{ date: '2026-04-26', challenges: 98, verified: 90, failed: 5 },
		],
		geoSupported: true,
		topCountries: [{ name: 'US', count: 852, percent: 30.1 }],
		topNetworks: [{ name: 'Comcast Cable Communications', asn: 7922, count: 202, percent: 7.1 }],
		topReasons: [{ reason: 'ip mismatch', count: 12, percent: 0.4 }],
		...overrides,
	},
});

const makeRecords = (overrides = {}) => ({
	code: 200,
	message: 'Verify records fetched successfully',
	data: {
		list: [
			{
				id: 10241,
				createdAt: '2026-04-26T12:34:56.789Z',
				event: 'fail',
				reason: 'ip mismatch',
				elapsedMs: 4200,
				difficulty: 1000000,
				challengeId: 'cid-1',
				postSlug: '/posts/hello-world',
				ipAddress: '203.0.113.42',
				country: 'US',
				network: 'Comcast Cable Communications',
				asn: 7922,
			},
			{
				id: 10240,
				createdAt: '2026-04-26T12:34:50.000Z',
				event: 'pass',
				reason: '',
				elapsedMs: 900,
				difficulty: 1000000,
				challengeId: 'cid-0',
				postSlug: '/posts/hello-world',
				ipAddress: '203.0.113.42',
				country: 'US',
				network: '',
				asn: null,
			},
		],
		total: 42,
		page: 1,
		pageSize: 20,
		...overrides,
	},
});

let router;
let wrapper;

const mountPage = async ({ overview = makeOverview(), records = makeRecords() } = {}) => {
	requestMock.get.mockImplementation((url) => {
		if (url === '/admin/verify/overview') return Promise.resolve(overview);
		if (url === '/admin/verify/records') return Promise.resolve(records);
		return Promise.resolve({ code: 200, data: {} });
	});
	router = await createTestRouter('/');
	wrapper = mount(VerifyRecords, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

/** 上一次 overview / records 请求的查询参数 */
const lastParams = (url) => {
	const call = [...requestMock.get.mock.calls].reverse().find(([target]) => target === url);
	return call?.[1]?.params ?? {};
};

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
});

describe('VerifyRecords - 加载与指标卡', () => {
	it('挂载时同时拉取概览与明细', async () => {
		await mountPage();
		expect(lastParams('/admin/verify/overview')).toEqual({ days: 30, offset: 0 });
		expect(lastParams('/admin/verify/records')).toMatchObject({ page: 1, pageSize: 20, days: 30 });
	});

	it('四张指标卡展示数据，平均耗时按秒格式化', async () => {
		await mountPage();
		const text = wrapper.text();
		expect(text).toContain('认证挑战数');
		expect(text).toContain('2,400');
		expect(text).toContain('2,200');
		expect(text).toContain('142');
		expect(text).toContain('5.0s');
	});

	it('通过卡展示通过率，环比按方向给出箭头', async () => {
		await mountPage();
		expect(wrapper.text()).toContain('通过率 93.9%');
		// 失败数环比 -85%，向下箭头；挑战数 +20%，向上箭头
		expect(wrapper.text()).toContain('85%');
		expect(wrapper.text()).toContain('20%');
	});

	it('无对照数据时环比位置不显示百分比', async () => {
		await mountPage({
			overview: makeOverview({
				summary: {
					challenges: 10, challengesDelta: null,
					verified: 10, verifiedDelta: null,
					failed: 0, failedDelta: null,
					avgDurationMs: null, avgDurationDelta: null,
					passRate: null,
				},
			}),
		});
		expect(wrapper.text()).toContain('较上一周期无对照数据');
		// 平均耗时无数据时展示占位符
		expect(wrapper.text()).toContain('—');
	});

	it('日期区间按浏览器本地时区展示为 from ~ to', async () => {
		await mountPage();
		// from 2026-03-28T00:00Z → 本地 2026-03-28 08:00；to 2026-04-26T23:59:59.999Z → 本地 2026-04-27 07:59
		expect(wrapper.text()).toContain('2026-03-28 ~ 2026-04-27');
	});
});

describe('VerifyRecords - 趋势与 Top 榜单', () => {
	it('趋势图渲染三条序列并带图例', async () => {
		await mountPage();
		const paths = wrapper.findAll('.line-path');
		expect(paths).toHaveLength(3);
		expect(paths.map((path) => path.attributes('data-series'))).toEqual(['签发', '通过', '失败']);
		expect(wrapper.text()).toContain('签发');
		expect(wrapper.text()).toContain('通过');
	});

	it('趋势横坐标按浏览器本地时区展示（后端分桶键为 UTC）', async () => {
		await mountPage();
		const labels = wrapper.findAll('.axis-label-x').map((node) => node.text());
		// UTC 日桶 2026-04-25 / 2026-04-26 在 UTC+8 下分别是本地 04-25 08:00 与 04-26 08:00
		expect(labels).toEqual(['04-25', '04-26']);
	});

	it('小时粒度的横坐标与悬浮提示都按本地时区换算', async () => {
		await mountPage({
			overview: makeOverview({
				range: {
					days: 1,
					offset: 0,
					from: '2026-04-25T16:00:00.000Z',
					to: '2026-04-26T15:59:59.999Z',
					bucket: 'hour',
				},
				trend: [
					{ date: '2026-04-25T16', challenges: 5, verified: 4, failed: 1 },
					{ date: '2026-04-25T20', challenges: 2, verified: 2, failed: 0 },
				],
			}),
		});

		// UTC 16:00 → 本地次日 00:00；UTC 20:00 → 本地次日 04:00
		const labels = wrapper.findAll('.axis-label-x').map((node) => node.text());
		expect(labels).toEqual(['00:00', '04:00']);
		expect(wrapper.findComponent(MultiLineChart).props('rawLabels')).toEqual([
			'2026-04-26 00:00',
			'2026-04-26 04:00',
		]);
	});

	it('geoSupported 为 true 时展示地区与运营商榜单', async () => {
		await mountPage();
		const text = wrapper.text();
		expect(text).toContain('来源地区 Top 5');
		expect(text).toContain('网络运营商 Top 5');
		expect(text).toContain('美国');
		expect(text).toContain('Comcast Cable Communications');
		expect(text).toContain('AS7922');
	});

	it('geoSupported 为 false 时整块隐藏地区与运营商榜单，只留失败原因', async () => {
		await mountPage({
			overview: makeOverview({
				geoSupported: false,
				topCountries: [],
				topNetworks: [],
			}),
		});
		const text = wrapper.text();
		expect(text).not.toContain('来源地区 Top 5');
		expect(text).not.toContain('网络运营商 Top 5');
		expect(text).toContain('失败原因 Top 5');
		// 失败原因用中文可读文案，原始 reason 作为副标题保留
		expect(text).toContain('IP 不一致');
		expect(text).toContain('ip mismatch');
	});
});

describe('VerifyRecords - 明细表与筛选', () => {
	it('渲染明细行、事件徽标与耗时', async () => {
		await mountPage();
		const rows = wrapper.findAll('tbody tr');
		expect(rows).toHaveLength(2);
		const text = wrapper.text();
		expect(text).toContain('失败');
		expect(text).toContain('4.2s');
		expect(text).toContain('203.0.113.42');
		expect(text).toContain('/posts/hello-world');
	});

	it('geoSupported 为 false 时不渲染地区列', async () => {
		await mountPage({
			overview: makeOverview({ geoSupported: false, topCountries: [], topNetworks: [] }),
		});
		const headers = wrapper.findAll('thead th').map((th) => th.text());
		expect(headers).not.toContain('地区');
	});

	it('筛选后按事件/IP/文章重新请求第一页', async () => {
		await mountPage();
		wrapper.vm.eventFilter = 'fail';
		wrapper.vm.ipFilter = '203.0.113.';
		wrapper.vm.slugFilter = '/posts/hello-world';
		await wrapper.vm.applyFilters();
		await flushPromises();

		const params = lastParams('/admin/verify/records');
		expect(params).toMatchObject({
			page: 1,
			event: 'fail',
			ip: '203.0.113.',
			slug: '/posts/hello-world',
		});
	});

	it('分页：首页禁用「上一页」，下一页请求 page=2', async () => {
		await mountPage({ records: makeRecords({ total: 60 }) });
		const buttons = wrapper.findAll('button');
		const prev = buttons.find((button) => button.text() === '上一页');
		const next = buttons.find((button) => button.text() === '下一页');
		expect(prev.attributes('disabled')).toBeDefined();
		expect(next.attributes('disabled')).toBeUndefined();

		await next.trigger('click');
		await flushPromises();
		expect(lastParams('/admin/verify/records').page).toBe(2);
	});

	it('无数据时展示空态文案（区分「无记录」与「筛选无结果」）', async () => {
		await mountPage({ records: makeRecords({ list: [], total: 0 }) });
		expect(wrapper.text()).toContain('该时间段内没有认证记录');

		wrapper.vm.eventFilter = 'fail';
		await wrapper.vm.applyFilters();
		await flushPromises();
		expect(wrapper.text()).toContain('没有符合条件的认证记录');
	});
});

describe('VerifyRecords - 时间范围与窗口平移', () => {
	it('切换范围会重置偏移并按新天数请求', async () => {
		await mountPage();
		wrapper.vm.offset = 2;
		await wrapper.vm.switchRange(7);
		await flushPromises();
		expect(lastParams('/admin/verify/overview')).toEqual({ days: 7, offset: 0 });
	});

	it('窗口平移只改变 offset；当前窗口没有数据时不再允许继续往前翻', async () => {
		await mountPage();
		await wrapper.vm.shiftWindow(1);
		await flushPromises();
		expect(lastParams('/admin/verify/overview')).toEqual({ days: 30, offset: 1 });

		await mountPage({
			overview: makeOverview({
				summary: {
					challenges: 0, challengesDelta: null,
					verified: 0, verifiedDelta: null,
					failed: 0, failedDelta: null,
					avgDurationMs: null, avgDurationDelta: null,
					passRate: null,
				},
			}),
		});
		expect(wrapper.vm.canShiftBack).toBe(false);
	});

	it('总览请求失败时弹出错误提示但不影响页面渲染', async () => {
		requestMock.get.mockImplementation((url) => {
			if (url === '/admin/verify/overview') return Promise.reject(new Error('boom'));
			return Promise.resolve(makeRecords());
		});
		router = await createTestRouter('/');
		wrapper = mount(VerifyRecords, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('加载认证统计失败');
		expect(wrapper.text()).toContain('认证挑战数');
	});
});
