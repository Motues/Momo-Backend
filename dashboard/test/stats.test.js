import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

/* ---------- 依赖 mock：echarts 与 request/toast ---------- */
const chartMock = vi.hoisted(() => {
	const instances = [];
	return {
		instances,
		init: vi.fn(() => {
			const instance = { setOption: vi.fn(), dispose: vi.fn() };
			instances.push(instance);
			return instance;
		}),
	};
});

const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('echarts/core', () => ({ use: vi.fn(), init: chartMock.init }));
vi.mock('echarts/charts', () => ({ PieChart: {}, LineChart: {} }));
vi.mock('echarts/components', () => ({ TooltipComponent: {}, GridComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));
vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import Stats from '../src/views/Stats.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

const DEFAULT_DATA = {
	totalComments: 12,
	totalUsers: 5,
	totalPosts: 3,
	statusDistribution: { approved: 8, pending: 2, deleted: 2 },
	recentComments: [
		{ date: '2024-05-06', count: 3 },
		{ date: '2024-05-07', count: 0 },
	],
	topCommenters: [
		{ author: '张三', email: 'z@example.com', count: 7, lastCommentDate: '2024-05-06T07:08:09.000Z' },
	],
};

let router;
let pushSpy;
let wrapper;

const mountStats = async (data = DEFAULT_DATA) => {
	requestMock.get.mockResolvedValue({ code: 200, data });
	router = await createTestRouter('/');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(Stats, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

const optionsOfType = (type) =>
	chartMock.instances
		.filter((instance) => instance.setOption.mock.calls.some((call) => call[0]?.series?.[0]?.type === type))
		.map((instance) => instance.setOption.mock.calls.find((call) => call[0]?.series?.[0]?.type === type)[0]);

const lastOptionOfType = (type) => optionsOfType(type).at(-1);

const cardByText = (text) => wrapper.findAll('div.cursor-pointer').find((card) => card.text().includes(text));

beforeEach(() => {
	localStorage.clear();
	chartMock.instances.length = 0;
	chartMock.init.mockClear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
	pushSpy?.mockRestore();
});

describe('Stats - 数据加载', () => {
	it('挂载时以默认 7 天范围请求概览接口', async () => {
		await mountStats();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/stats/overview?range=7');
	});

	it('加载中显示加载动画、不显示统计卡片', async () => {
		requestMock.get.mockReturnValue(new Promise(() => {}));
		router = await createTestRouter('/');
		wrapper = mount(Stats, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await nextTick();
		expect(wrapper.find('.animate-spin').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('评论总数');
	});

	it('加载完成后渲染统计数字', async () => {
		await mountStats();
		expect(wrapper.find('.animate-spin').exists()).toBe(false);
		const text = wrapper.text();
		expect(text).toContain('评论总数');
		expect(text).toContain('12');
		expect(text).toContain('5');
		expect(text).toContain('3');
	});

	it('待审核数量取自 statusDistribution.pending', async () => {
		await mountStats({ ...DEFAULT_DATA, statusDistribution: { pending: 4 } });
		expect(cardByText('待审核').text()).toContain('4');
	});

	it('statusDistribution 缺失字段补 0', async () => {
		await mountStats({ ...DEFAULT_DATA, statusDistribution: { approved: 2 } });
		const option = lastOptionOfType('pie');
		expect(option.series[0].data.map((d) => [d.name, d.value])).toEqual([
			['已通过', 2],
			['待审核', 0],
			['已删除', 0],
		]);
	});

	it('响应缺少 statusDistribution 时三个状态全为 0', async () => {
		await mountStats({ totalComments: 1 });
		const option = lastOptionOfType('pie');
		expect(option.series[0].data.map((d) => d.value)).toEqual([0, 0, 0]);
	});

	it('响应缺少 topCommenters 时展示「暂无数据」', async () => {
		await mountStats({ totalComments: 1 });
		expect(wrapper.text()).toContain('暂无数据');
	});

	it('topCommenters 为空数组时展示「暂无数据」', async () => {
		await mountStats({ ...DEFAULT_DATA, topCommenters: [] });
		expect(wrapper.text()).toContain('暂无数据');
	});

	it('响应没有 data 字段时保留默认零值', async () => {
		requestMock.get.mockResolvedValue({ code: 500, message: 'err' });
		router = await createTestRouter('/');
		wrapper = mount(Stats, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('评论总数');
		expect(cardByText('待审核').text()).toContain('0');
	});

	it('请求失败时提示加载失败并结束加载态', async () => {
		requestMock.get.mockRejectedValue(new Error('boom'));
		router = await createTestRouter('/');
		wrapper = mount(Stats, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();
		expect(toastMock.error).toHaveBeenCalledWith('加载统计数据失败');
		expect(wrapper.find('.animate-spin').exists()).toBe(false);
	});
});

describe('Stats - 热门评论者表格', () => {
	it('渲染作者、邮箱与评论数', async () => {
		await mountStats();
		const text = wrapper.text();
		expect(text).toContain('张三');
		expect(text).toContain('z@example.com');
		expect(text).toContain('7');
	});

	it('渲染序号从 1 开始', async () => {
		await mountStats({
			...DEFAULT_DATA,
			topCommenters: [
				{ author: 'A', email: 'a@x.com', count: 2, lastCommentDate: '2024-05-06T00:00:00.000Z' },
				{ author: 'B', email: 'b@x.com', count: 1, lastCommentDate: '2024-05-06T00:00:00.000Z' },
			],
		});
		const firstCell = wrapper.findAll('tbody tr')[0].find('td');
		expect(firstCell.text()).toBe('1');
	});

	it('缺少最后评论时间时展示 "-"', async () => {
		await mountStats({
			...DEFAULT_DATA,
			topCommenters: [{ author: 'A', email: 'a@x.com', count: 1, lastCommentDate: null }],
		});
		expect(wrapper.find('tbody tr').text()).toContain('-');
	});

	it('点击评论者行跳转到用户评论页并带查询参数', async () => {
		await mountStats();
		await wrapper.find('tbody tr').trigger('click');
		expect(pushSpy).toHaveBeenCalledWith({
			path: '/user-comments',
			query: { author: '张三', email: 'z@example.com' },
		});
	});
});

describe('Stats - 卡片跳转', () => {
	it('点击评论总数卡片跳转 /comments', async () => {
		await mountStats();
		await cardByText('评论总数').trigger('click');
		expect(pushSpy).toHaveBeenCalledWith('/comments');
	});

	it('点击待审核卡片跳转 /comments?status=pending', async () => {
		await mountStats();
		await cardByText('待审核').trigger('click');
		expect(pushSpy).toHaveBeenCalledWith('/comments?status=pending');
	});

	it('点击评论用户卡片跳转 /users', async () => {
		await mountStats();
		await cardByText('评论用户').trigger('click');
		expect(pushSpy).toHaveBeenCalledWith('/users');
	});

	it('点击文章数卡片跳转 /comments', async () => {
		await mountStats();
		await cardByText('文章数').trigger('click');
		expect(pushSpy).toHaveBeenCalledWith('/comments');
	});
});

describe('Stats - 趋势范围切换', () => {
	it('默认选中 7 天', async () => {
		await mountStats();
		const active = wrapper.findAll('button').find((b) => b.text() === '7天');
		expect(active.classes()).toContain('bg-white');
		expect(active.classes()).toContain('text-blue-600');
	});

	it('切换 14 天会以 range=14 重新请求', async () => {
		await mountStats();
		await wrapper.findAll('button').find((b) => b.text() === '14天').trigger('click');
		await flushPromises();
		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/stats/overview?range=14');
	});

	it('切换 1 个月会以 range=30 重新请求', async () => {
		await mountStats();
		await wrapper.findAll('button').find((b) => b.text() === '1个月').trigger('click');
		await flushPromises();
		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/stats/overview?range=30');
	});

	it('切换 1 年会以 range=0 重新请求', async () => {
		await mountStats();
		await wrapper.findAll('button').find((b) => b.text() === '1年').trigger('click');
		await flushPromises();
		expect(requestMock.get).toHaveBeenLastCalledWith('/admin/stats/overview?range=0');
	});

	it('切换后高亮样式跟随选中项', async () => {
		await mountStats();
		await wrapper.findAll('button').find((b) => b.text() === '14天').trigger('click');
		await flushPromises();
		expect(wrapper.findAll('button').find((b) => b.text() === '14天').classes()).toContain('bg-white');
		expect(wrapper.findAll('button').find((b) => b.text() === '7天').classes()).not.toContain('bg-white');
	});

	it('静默刷新失败时不弹错误提示', async () => {
		await mountStats();
		toastMock.error.mockClear();
		requestMock.get.mockRejectedValue(new Error('boom'));
		await wrapper.findAll('button').find((b) => b.text() === '14天').trigger('click');
		await flushPromises();
		expect(toastMock.error).not.toHaveBeenCalled();
	});
});

describe('Stats - 图表数据聚合', () => {
	it('饼图系列包含三个状态与配色', async () => {
		await mountStats();
		const option = lastOptionOfType('pie');
		expect(option.series[0].type).toBe('pie');
		expect(option.color).toEqual(['#10b981', '#f59e0b', '#ef4444']);
		expect(option.tooltip.formatter).toBe('{b}: {c} ({d}%)');
	});

	it('饼图数值来自 statusDistribution', async () => {
		await mountStats({ ...DEFAULT_DATA, statusDistribution: { approved: 1, pending: 2, deleted: 3 } });
		const option = lastOptionOfType('pie');
		expect(option.series[0].data.map((d) => d.value)).toEqual([1, 2, 3]);
	});

	it('折线图按日粒度展示 MM-DD 标签', async () => {
		await mountStats();
		const option = lastOptionOfType('line');
		expect(option.xAxis.data).toEqual(['05-06', '05-07']);
		expect(option.series[0].data).toEqual([3, 0]);
	});

	it('折线图按月粒度展示「24年」与「6月」', async () => {
		await mountStats({
			...DEFAULT_DATA,
			recentComments: [
				{ date: '2024-01', count: 2 },
				{ date: '2024-06', count: 5 },
			],
		});
		const option = lastOptionOfType('line');
		expect(option.xAxis.data).toEqual(['24年', '6月']);
	});

	it('月度数据缺少 count 时按 0 处理', async () => {
		await mountStats({ ...DEFAULT_DATA, recentComments: [{ date: '2024-06' }] });
		expect(lastOptionOfType('line').series[0].data).toEqual([0]);
	});

	it('日期缺失时标签回落为空字符串', async () => {
		await mountStats({ ...DEFAULT_DATA, recentComments: [{ count: 1 }] });
		expect(lastOptionOfType('line').xAxis.data).toEqual(['']);
	});

	it('数据点超过 14 个时 X 轴标签旋转 45 度', async () => {
		const many = Array.from({ length: 15 }, (_, i) => ({ date: `2024-05-${String(i + 1).padStart(2, '0')}`, count: i }));
		await mountStats({ ...DEFAULT_DATA, recentComments: many });
		expect(lastOptionOfType('line').xAxis.axisLabel.rotate).toBe(45);
	});

	it('数据点不超过 14 个时不旋转', async () => {
		await mountStats();
		expect(lastOptionOfType('line').xAxis.axisLabel.rotate).toBe(0);
	});

	it('折线图 tooltip 使用原始日期与评论数', async () => {
		await mountStats();
		const option = lastOptionOfType('line');
		expect(option.tooltip.formatter([{ dataIndex: 1 }])).toBe('2024-05-07<br/>评论数: 0');
	});

	it('折线图 Y 轴最小间隔为 1', async () => {
		await mountStats();
		expect(lastOptionOfType('line').yAxis.minInterval).toBe(1);
	});

	it('两个图表都会被初始化', async () => {
		await mountStats();
		expect(chartMock.init).toHaveBeenCalledTimes(2);
	});

	it('刷新时先销毁旧图表实例', async () => {
		await mountStats();
		const firstInstances = chartMock.instances.slice();
		await wrapper.findAll('button').find((b) => b.text() === '14天').trigger('click');
		await flushPromises();
		firstInstances.forEach((instance) => expect(instance.dispose).toHaveBeenCalled());
	});

	it('卸载组件时销毁图表实例', async () => {
		await mountStats();
		const instances = chartMock.instances.slice();
		wrapper.unmount();
		wrapper = undefined;
		instances.forEach((instance) => expect(instance.dispose).toHaveBeenCalled());
	});
});

describe('Stats - 布局交互', () => {
	it('刷新事件重新请求数据', async () => {
		await mountStats();
		wrapper.findComponent({ name: 'AdminLayout' }).vm.$emit('refresh');
		await flushPromises();
		expect(requestMock.get).toHaveBeenCalledTimes(2);
	});

	it('登出清除 token 并跳转登录页', async () => {
		await mountStats();
		localStorage.setItem('token', 'tk');
		wrapper.findComponent({ name: 'AdminLayout' }).vm.$emit('logout');
		await flushPromises();
		expect(localStorage.getItem('token')).toBeNull();
		expect(pushSpy).toHaveBeenCalledWith('/login');
	});
});
