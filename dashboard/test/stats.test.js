import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

// 趋势横坐标按浏览器本地时区换算，因此断言依赖进程时区：
// 固定成 Asia/Shanghai（UTC+8），保证在任何机器上跑出的结果一致。
process.env.TZ = 'Asia/Shanghai';

/* ---------- 依赖 mock：request / toast ---------- */
const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import Stats from '../src/views/Stats.vue';
import DonutChart from '../src/components/charts/DonutChart.vue';
import LineAreaChart from '../src/components/charts/LineAreaChart.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

const STATS_URL = '/admin/stats/overview';
const VERIFY_URL = '/admin/verify/overview';

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
	// —— 数据统计页新增字段 ——
	windowComments: 9,
	prevWindowComments: 6,
	commentsDelta: 50,
	windowUsers: 4,
	prevWindowUsers: 3,
	usersDelta: 33,
	todayComments: 2,
	last7DaysComments: 5,
	topPosts: [
		{ postSlug: '/posts/hello', count: 8, lastCommentDate: '2024-05-06T07:08:09.000Z' },
		{ postSlug: '/posts/second', count: 4, lastCommentDate: null },
	],
	deviceDistribution: [
		{ name: '桌面', count: 9 },
		{ name: '移动', count: 3 },
	],
	browserDistribution: [
		{ name: 'Chrome', count: 11 },
		{ name: '未知', count: 1 },
	],
	osDistribution: [{ name: 'Windows', count: 12 }],
	latestComments: [
		{
			id: 2,
			author: '李四',
			email: 'l@example.com',
			postSlug: '/posts/hello',
			contentText: '写得很好',
			status: 'pending',
			pubDate: '2024-05-07T08:00:00.000Z',
		},
		{
			id: 1,
			author: '张三',
			email: 'z@example.com',
			postSlug: '/posts/second',
			contentText: '收藏了',
			status: 'approved',
			pubDate: '2024-05-06T07:08:09.000Z',
		},
	],
};

const DEFAULT_VERIFY = {
	range: { days: 30, offset: 0, from: '', to: '', bucket: 'day' },
	summary: {
		challenges: 240,
		challengesDelta: 20,
		verified: 220,
		verifiedDelta: 11,
		failed: 14,
		failedDelta: -85,
		avgDurationMs: 5000,
		avgDurationDelta: -12,
		passRate: 93.9,
	},
	trend: [],
	geoSupported: false,
	topCountries: [],
	topNetworks: [],
	topReasons: [],
};

/** 组件内 SVG 的定位器：图表已改为自绘 SVG，不再有 echarts 实例 */
const DONUT_SVG = 'svg[aria-label="评论状态分布环形图"]';
const LINE_SVG = 'svg[aria-label="评论趋势折线图"]';

/** SVG 中标签/刻度文本（不包含 hover 内联提示） */
const svgTexts = (wrapper, selector) => wrapper.findAll(`${selector} text`).map((node) => node.text());
const xAxisTexts = (wrapper) => wrapper.findAll(`${LINE_SVG} .axis-label-x`).map((node) => node.text());
const yAxisTexts = (wrapper) => wrapper.findAll(`${LINE_SVG} .axis-label-y`).map((node) => node.text());

/** 图表绘制区的横向像素中心：用于模拟鼠标悬浮 */
const hoverPlot = async (wrapper, clientX) => {
	await wrapper.find(LINE_SVG).trigger('mousemove', { clientX, clientY: 120 });
};

/** 只统计概览接口的调用（首页还会拉一次人机验证概览） */
const statsCalls = () => requestMock.get.mock.calls.filter(([url]) => String(url).startsWith(STATS_URL));

let router;
let pushSpy;
let wrapper;

const mountStats = async (data = DEFAULT_DATA, verifyData = DEFAULT_VERIFY) => {
	requestMock.get.mockImplementation((url) =>
		String(url).startsWith(VERIFY_URL)
			? Promise.resolve({ code: 200, data: verifyData })
			: Promise.resolve({ code: 200, data }),
	);
	router = await createTestRouter('/');
	pushSpy = vi.spyOn(router, 'push');
	wrapper = mount(Stats, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
};

/** 顶部核心指标卡（.stat-card）；其余卡片也含这些文案，必须按类名定位 */
const cardByText = (text) => wrapper.findAll('.stat-card').find((card) => card.text().includes(text));
const recentCards = () => wrapper.findAll('.recent-card');
const distributionPanels = () => wrapper.findAll('.distribution-panel');

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
	pushSpy?.mockRestore();
});

describe('Stats - 数据加载', () => {
	it('挂载时以默认 7 天范围请求概览接口，并同时拉取人机验证概览', async () => {
		await mountStats();
		expect(requestMock.get).toHaveBeenCalledWith('/admin/stats/overview?range=7');
		expect(requestMock.get).toHaveBeenCalledWith('/admin/verify/overview?days=30');
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
		// 只有「已通过」有数据，其余两个状态值为 0，不绘制扇区也不显示标签
		const labels = svgTexts(wrapper, DONUT_SVG);
		expect(labels).toEqual(['已通过', '100%']);
		expect(wrapper.findAll(`${DONUT_SVG} path`)).toHaveLength(1);
	});

	it('响应缺少 statusDistribution 时展示空数据占位', async () => {
		await mountStats({ totalComments: 1 });
		expect(svgTexts(wrapper, DONUT_SVG)).toContain('暂无数据');
		expect(wrapper.findAll(`${DONUT_SVG} path`)).toHaveLength(0);
	});

	it('响应缺少 topCommenters 时展示「暂无数据」', async () => {
		await mountStats({ totalComments: 1 });
		expect(wrapper.text()).toContain('暂无数据');
	});

	it('topCommenters 为空数组时展示「暂无数据」', async () => {
		await mountStats({ ...DEFAULT_DATA, topCommenters: [] });
		expect(wrapper.text()).toContain('暂无数据');
	});

	it('新增字段缺失时回落为空数组而不是渲染成 undefined', async () => {
		await mountStats({ totalComments: 1 });
		expect(wrapper.findAll('.post-row')).toHaveLength(0);
		expect(wrapper.findAll('.latest-row')).toHaveLength(0);
		expect(wrapper.findAll('.distribution-row')).toHaveLength(0);
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

describe('Stats - 核心指标卡', () => {
	it('评论总数卡片带通过率（已通过 ÷ 已判定）', async () => {
		await mountStats();
		expect(cardByText('评论总数').text()).toContain('通过率 66.7%');
	});

	it('用户卡/文章卡分别显示人均与篇均评论数', async () => {
		await mountStats();
		expect(cardByText('评论用户').text()).toContain('人均 2.4 条评论');
		expect(cardByText('文章数').text()).toContain('篇均 4.0 条评论');
	});

	it('没有任何已判定评论时通过率显示「—」', async () => {
		await mountStats({ ...DEFAULT_DATA, statusDistribution: { approved: 0, pending: 0, deleted: 0 } });
		expect(cardByText('评论总数').text()).toContain('通过率 —');
	});

	it('没有文章/用户数据时人均与篇均显示「—」', async () => {
		await mountStats({ totalComments: 0, totalUsers: 0, totalPosts: 0 });
		expect(cardByText('评论用户').text()).toContain('人均 — 条评论');
		expect(cardByText('文章数').text()).toContain('篇均 — 条评论');
	});
});

describe('Stats - 近况指标与环比', () => {
	it('渲染今日 / 近 7 天 / 本周期新增 / 本周期活跃用户四项', async () => {
		await mountStats();
		const cards = recentCards();
		expect(cards).toHaveLength(4);
		expect(cards[0].text()).toContain('今日新增');
		expect(cards[0].text()).toContain('2');
		expect(cards[1].text()).toContain('近 7 天新增');
		expect(cards[1].text()).toContain('日均 0.7 条');
		expect(cards[2].text()).toContain('本周期新增');
		expect(cards[2].text()).toContain('9');
		expect(cards[3].text()).toContain('本周期活跃用户');
		expect(cards[3].text()).toContain('4');
	});

	it('本周期新增带环比涨幅与上一周期对照', async () => {
		await mountStats();
		const card = recentCards()[2];
		expect(card.text()).toContain('50%');
		expect(card.text()).toContain('近 7 天 · 上一周期 6 条');
		expect(card.find('.fa-arrow-up').exists()).toBe(true);
	});

	it('环比为负时显示下降箭头', async () => {
		await mountStats({ ...DEFAULT_DATA, commentsDelta: -25 });
		const card = recentCards()[2];
		expect(card.text()).toContain('25%');
		expect(card.find('.fa-arrow-down').exists()).toBe(true);
	});

	it('上一周期无数据时显示「暂无可比数据」', async () => {
		await mountStats({ ...DEFAULT_DATA, commentsDelta: null, usersDelta: null });
		expect(recentCards()[2].text()).toContain('暂无可比数据');
		expect(recentCards()[3].text()).toContain('暂无可比数据');
	});

	it('切换范围后卡片标题里的周期文案随之变化', async () => {
		await mountStats();
		await wrapper.findAll('button').find((b) => b.text() === '1个月').trigger('click');
		await flushPromises();
		expect(recentCards()[2].text()).toContain('近 30 天');
	});
});

describe('Stats - 待审核提醒', () => {
	it('有待审核评论时置顶提醒并显示占比', async () => {
		await mountStats();
		const alert = wrapper.find('.pending-alert');
		expect(alert.exists()).toBe(true);
		expect(alert.text()).toContain('有 2 条评论等待审核');
		expect(alert.text()).toContain('16.7%');
	});

	it('点击「立即处理」跳转待审核列表', async () => {
		await mountStats();
		await wrapper.find('.pending-alert button').trigger('click');
		expect(pushSpy).toHaveBeenCalledWith('/comments?status=pending');
	});

	it('没有待审核评论时不显示提醒条', async () => {
		await mountStats({
			...DEFAULT_DATA,
			statusDistribution: { approved: 10, pending: 0, deleted: 2 },
		});
		expect(wrapper.find('.pending-alert').exists()).toBe(false);
	});
});

describe('Stats - 热门文章', () => {
	it('渲染文章标识、评论数与最后评论时间', async () => {
		await mountStats();
		const rows = wrapper.findAll('.post-row');
		expect(rows).toHaveLength(2);
		expect(rows[0].text()).toContain('/posts/hello');
		expect(rows[0].text()).toContain('8');
		expect(rows[0].text()).toContain('05/06 15:08');
	});

	it('缺少最后评论时间时展示 "-"', async () => {
		await mountStats();
		expect(wrapper.findAll('.post-row')[1].text()).toContain('-');
	});

	it('点击文章行跳转到评论管理页并带上文章标识筛选', async () => {
		await mountStats();
		await wrapper.findAll('.post-row')[0].trigger('click');
		expect(pushSpy).toHaveBeenCalledWith({ path: '/comments', query: { slug: '/posts/hello' } });
	});
});

describe('Stats - 热门评论者', () => {
	it('渲染作者、邮箱与评论数', async () => {
		await mountStats();
		const row = wrapper.find('.commenter-row');
		expect(row.text()).toContain('张三');
		expect(row.text()).toContain('z@example.com');
		expect(row.text()).toContain('7');
	});

	it('渲染序号从 1 开始', async () => {
		await mountStats({
			...DEFAULT_DATA,
			topCommenters: [
				{ author: 'A', email: 'a@x.com', count: 2, lastCommentDate: '2024-05-06T00:00:00.000Z' },
				{ author: 'B', email: 'b@x.com', count: 1, lastCommentDate: '2024-05-06T00:00:00.000Z' },
			],
		});
		const rows = wrapper.findAll('.commenter-row');
		expect(rows[0].find('span').text()).toBe('1');
		expect(rows[1].find('span').text()).toBe('2');
	});

	it('缺少最后评论时间时展示 "-"', async () => {
		await mountStats({
			...DEFAULT_DATA,
			topCommenters: [{ author: 'A', email: 'a@x.com', count: 1, lastCommentDate: null }],
		});
		expect(wrapper.find('.commenter-row').text()).toContain('-');
	});

	it('点击评论者行跳转到用户评论页并带查询参数', async () => {
		await mountStats();
		await wrapper.find('.commenter-row').trigger('click');
		expect(pushSpy).toHaveBeenCalledWith({
			path: '/user-comments',
			query: { author: '张三', email: 'z@example.com' },
		});
	});
});

describe('Stats - 最新评论动态', () => {
	it('渲染作者、内容、状态与文章标识', async () => {
		await mountStats();
		const rows = wrapper.findAll('.latest-row');
		expect(rows).toHaveLength(2);
		expect(rows[0].text()).toContain('李四');
		expect(rows[0].text()).toContain('写得很好');
		expect(rows[0].text()).toContain('待审核');
		expect(rows[0].text()).toContain('/posts/hello');
		expect(rows[1].text()).toContain('已通过');
	});

	it('点击动态跳转到该文章的评论列表', async () => {
		await mountStats();
		await wrapper.findAll('.latest-row')[1].trigger('click');
		expect(pushSpy).toHaveBeenCalledWith({ path: '/comments', query: { slug: '/posts/second' } });
	});
});

describe('Stats - 客户端分布', () => {
	it('渲染设备 / 浏览器 / 操作系统三块分布与占比', async () => {
		await mountStats();
		const panels = distributionPanels();
		expect(panels).toHaveLength(3);
		expect(panels[0].text()).toContain('设备分布');
		expect(panels[0].text()).toContain('桌面');
		// 9 / 12 = 75%
		expect(panels[0].text()).toContain('75%');
		expect(panels[1].text()).toContain('浏览器分布');
		expect(panels[1].text()).toContain('Chrome');
		expect(panels[2].text()).toContain('操作系统分布');
		expect(panels[2].text()).toContain('Windows');
	});

	it('Top 5 之外的长尾合并成「其他」', async () => {
		await mountStats({ ...DEFAULT_DATA, browserDistribution: [{ name: 'Chrome', count: 8 }] });
		const browserPanel = distributionPanels()[1];
		expect(browserPanel.text()).toContain('其他');
		// 12 - 8 = 4
		expect(browserPanel.text()).toContain('4 · 33.3%');
	});

	it('没有长尾时不显示「其他」', async () => {
		await mountStats({ ...DEFAULT_DATA, browserDistribution: [{ name: 'Chrome', count: 12 }] });
		expect(distributionPanels()[1].text()).not.toContain('其他');
	});

	it('分布为空时显示暂无数据', async () => {
		await mountStats({
			...DEFAULT_DATA,
			deviceDistribution: [],
			browserDistribution: [],
			osDistribution: [],
		});
		distributionPanels().forEach((panel) => expect(panel.text()).toContain('暂无数据'));
	});

	it('评论总数为 0 时占比按 0% 处理而不出现 NaN', async () => {
		await mountStats({ ...DEFAULT_DATA, totalComments: 0 });
		expect(wrapper.text()).not.toContain('NaN');
	});
});

describe('Stats - 人机验证概览', () => {
	it('渲染通过率、失败数与平均耗时', async () => {
		await mountStats();
		const text = wrapper.text();
		expect(text).toContain('人机验证概览');
		expect(text).toContain('93.9%');
		expect(text).toContain('14');
		expect(text).toContain('5.0 s');
		expect(text).toContain('较上一周期 ↓ 85%');
	});

	it('接口失败时静默隐藏整块，且不影响其它统计', async () => {
		requestMock.get.mockImplementation((url) =>
			String(url).startsWith(VERIFY_URL)
				? Promise.reject(new Error('boom'))
				: Promise.resolve({ code: 200, data: DEFAULT_DATA }),
		);
		router = await createTestRouter('/');
		wrapper = mount(Stats, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();
		expect(wrapper.text()).not.toContain('人机验证概览');
		expect(wrapper.text()).toContain('评论总数');
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	it('后端未返回 summary 时不渲染指标但也不报错', async () => {
		await mountStats(DEFAULT_DATA, { trend: [] });
		expect(wrapper.text()).toContain('人机验证概览');
		expect(wrapper.text()).toContain('近 30 天');
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

	it('切换范围只重新请求概览接口，不重复请求人机验证概览', async () => {
		await mountStats();
		await wrapper.findAll('button').find((b) => b.text() === '14天').trigger('click');
		await flushPromises();
		const verifyCalls = requestMock.get.mock.calls.filter(([url]) => String(url).startsWith(VERIFY_URL));
		expect(verifyCalls).toHaveLength(1);
	});
});

describe('Stats - 图表渲染', () => {
	it('同时渲染环形图与折线图两个自绘图表', async () => {
		await mountStats();
		expect(wrapper.findComponent(DonutChart).exists()).toBe(true);
		expect(wrapper.findComponent(LineAreaChart).exists()).toBe(true);
		expect(wrapper.findAll('svg[role="img"]')).toHaveLength(2);
	});

	it('环形图按状态顺序使用绿色/琥珀色/红色', async () => {
		await mountStats();
		const fills = wrapper.findAll(`${DONUT_SVG} path`).map((path) => path.attributes('fill'));
		expect(fills).toEqual(['#10b981', '#f59e0b', '#ef4444']);
	});

	it('环形图数值来自 statusDistribution 并换算为占比', async () => {
		await mountStats({ ...DEFAULT_DATA, statusDistribution: { approved: 1, pending: 2, deleted: 3 } });
		expect(svgTexts(wrapper, DONUT_SVG)).toEqual(['已通过', '16.7%', '待审核', '33.3%', '已删除', '50%']);
	});

	it('悬浮扇区时提示名称、数值与占比', async () => {
		await mountStats();
		expect(wrapper.find('.chart-tooltip').exists()).toBe(false);
		await wrapper.findAll(`${DONUT_SVG} path`)[0].trigger('mousemove', { clientX: 120, clientY: 120 });
		const tooltip = wrapper.find('.chart-tooltip');
		expect(tooltip.text()).toContain('已通过');
		expect(tooltip.text()).toContain('8');
		expect(tooltip.text()).toContain('66.7%');
	});

	it('折线图按日粒度展示 MM-DD 标签', async () => {
		await mountStats();
		expect(xAxisTexts(wrapper)).toEqual(['05-06', '05-07']);
	});

	it('折线图按月粒度展示「24年」与「6月」', async () => {
		await mountStats({
			...DEFAULT_DATA,
			recentComments: [
				{ date: '2024-01', count: 2 },
				{ date: '2024-06', count: 5 },
			],
		});
		expect(xAxisTexts(wrapper)).toEqual(['24年', '6月']);
	});

	it('月度数据缺少 count 时按 0 处理', async () => {
		await mountStats({ ...DEFAULT_DATA, recentComments: [{ date: '2024-06' }] });
		const points = wrapper.findAll(`${LINE_SVG} .data-point`);
		expect(points).toHaveLength(1);
		// 值为 0 时应落在 X 轴基线（高度 260 - 底部留白 34 = 226）
		expect(points[0].attributes('cy')).toBe('226');
	});

	it('日期缺失时标签回落为空字符串', async () => {
		await mountStats({ ...DEFAULT_DATA, recentComments: [{ count: 1 }] });
		expect(xAxisTexts(wrapper)).toEqual(['']);
	});

	it('数据点超过 14 个时 X 轴标签旋转 45 度', async () => {
		const many = Array.from({ length: 15 }, (_, i) => ({ date: `2024-05-${String(i + 1).padStart(2, '0')}`, count: i }));
		await mountStats({ ...DEFAULT_DATA, recentComments: many });
		const labels = wrapper.findAll(`${LINE_SVG} .axis-label-x`);
		expect(labels.length).toBeGreaterThan(0);
		labels.forEach((label) => expect(label.attributes('transform')).toContain('rotate(-45'));
	});

	it('数据点不超过 14 个时不旋转', async () => {
		await mountStats();
		wrapper.findAll(`${LINE_SVG} .axis-label-x`).forEach((label) => {
			expect(label.attributes('transform') || '').not.toContain('rotate');
		});
	});

	it('折线图悬浮时展示原始日期与评论数', async () => {
		await mountStats();
		// 共 2 个数据点，绘制区从 40px 起、宽 424px，最右侧对应第 2 个点
		await hoverPlot(wrapper, 464);
		const tooltip = wrapper.find('.chart-tooltip');
		expect(tooltip.text()).toContain('2024-05-07');
		expect(tooltip.text()).toContain('评论数: 0');
	});

	it('折线图 Y 轴按整数间隔取值（minInterval 1）', async () => {
		await mountStats();
		expect(yAxisTexts(wrapper)).toEqual(['0', '1', '2', '3']);
	});

	it('渲染平滑折线、渐变面积与数据点', async () => {
		await mountStats();
		expect(wrapper.find(`${LINE_SVG} .line-path`).attributes('d')).toContain('C');
		expect(wrapper.find(`${LINE_SVG} .area-path`).attributes('fill')).toContain('url(#line-area-gradient');
		expect(wrapper.findAll(`${LINE_SVG} .data-point`)).toHaveLength(2);
	});

	it('趋势数据为空时展示「暂无数据」且不画线', async () => {
		await mountStats({ ...DEFAULT_DATA, recentComments: [] });
		expect(svgTexts(wrapper, LINE_SVG)).toContain('暂无数据');
		expect(wrapper.find(`${LINE_SVG} .line-path`).exists()).toBe(false);
	});

	it('切换范围后图表数据随之刷新', async () => {
		await mountStats();
		requestMock.get.mockResolvedValue({
			code: 200,
			data: { ...DEFAULT_DATA, recentComments: [{ date: '2024-06-01', count: 9 }] },
		});
		await wrapper.findAll('button').find((b) => b.text() === '1个月').trigger('click');
		await flushPromises();
		expect(xAxisTexts(wrapper)).toEqual(['06-01']);
	});
});

describe('Stats - 布局交互', () => {
	it('刷新事件同时重新请求概览与人机验证概览', async () => {
		await mountStats();
		expect(statsCalls()).toHaveLength(1);
		wrapper.findComponent({ name: 'AdminLayout' }).vm.$emit('refresh');
		await flushPromises();
		expect(statsCalls()).toHaveLength(2);
		const verifyCalls = requestMock.get.mock.calls.filter(([url]) => String(url).startsWith(VERIFY_URL));
		expect(verifyCalls).toHaveLength(2);
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
