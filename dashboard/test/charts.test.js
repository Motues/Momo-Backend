import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DonutChart from '../src/components/charts/DonutChart.vue';
import LineAreaChart from '../src/components/charts/LineAreaChart.vue';

/**
 * 自研 SVG 图表的几何与交互约束。
 *
 * 测试环境（happy-dom）不做布局，组件会回退到 480×props.height 的坐标系，
 * 且 SVG 的 viewBox 宽度即实测像素宽度，所以断言可以直接写具体坐标。
 * 折线图默认高度 260：绘制区 top=16、bottom=226、left=40、right=464。
 */
const mountDonut = (props = {}) =>
	mount(DonutChart, {
		props: {
			data: [
				{ name: '已通过', value: 8, color: '#10b981' },
				{ name: '待审核', value: 2, color: '#f59e0b' },
				{ name: '已删除', value: 2, color: '#ef4444' },
			],
			...props,
		},
	});

const mountLine = (props = {}) =>
	mount(LineAreaChart, { props: { labels: ['05-06', '05-07'], values: [3, 0], ...props } });

const texts = (wrapper) => wrapper.findAll('svg text').map((node) => node.text());
const yTicks = (wrapper) => wrapper.findAll('.axis-label-y').map((node) => node.text());
const xTicks = (wrapper) => wrapper.findAll('.axis-label-x').map((node) => node.text());

describe('DonutChart - 扇区绘制', () => {
	it('每个非零数值渲染一个扇区并使用给定配色', () => {
		const wrapper = mountDonut();
		const paths = wrapper.findAll('svg path');
		expect(paths).toHaveLength(3);
		expect(paths.map((path) => path.attributes('fill'))).toEqual(['#10b981', '#f59e0b', '#ef4444']);
	});

	it('扇区路径是闭合的圆环（含内外两段弧）', () => {
		const wrapper = mountDonut({ data: [{ name: 'A', value: 1 }] });
		const d = wrapper.find('svg path').attributes('d');
		expect(d.startsWith('M ')).toBe(true);
		expect(d.endsWith('Z')).toBe(true);
		expect(d).toContain(' A ');
	});

	it('单个扇区占满 100% 时按 90° 分段绘制整圆', () => {
		const wrapper = mountDonut({ data: [{ name: 'A', value: 5 }] });
		const d = wrapper.find('svg path').attributes('d');
		// 整圆无法用一条弧表示，必须拆成 4 段外弧 + 4 段内弧
		expect(d.split(' ').filter((token) => token === 'A')).toHaveLength(8);
	});

	it('数值为 0 的扇区不绘制路径也不显示标签', () => {
		const wrapper = mountDonut({
			data: [
				{ name: '已通过', value: 2 },
				{ name: '待审核', value: 0 },
			],
		});
		expect(wrapper.findAll('svg path')).toHaveLength(1);
		expect(texts(wrapper)).toEqual(['已通过', '100%']);
	});

	it('全部为 0 时展示灰色占位环与「暂无数据」', () => {
		const wrapper = mountDonut({ data: [{ name: 'A', value: 0 }] });
		expect(wrapper.findAll('svg path')).toHaveLength(0);
		expect(texts(wrapper)).toContain('暂无数据');
		expect(wrapper.find('svg circle').attributes('stroke')).toBe('#e5e7eb');
	});
});

describe('DonutChart - 占比与提示', () => {
	it('占比按一位小数四舍五入展示', () => {
		const wrapper = mountDonut({
			data: [
				{ name: 'A', value: 1 },
				{ name: 'B', value: 2 },
				{ name: 'C', value: 4 },
			],
		});
		expect(texts(wrapper)).toEqual(['A', '14.3%', 'B', '28.6%', 'C', '57.1%']);
	});

	it('整数占比不带多余小数位', () => {
		const wrapper = mountDonut({
			data: [
				{ name: 'A', value: 1 },
				{ name: 'B', value: 1 },
			],
		});
		expect(texts(wrapper)).toContain('50%');
	});

	it('悬浮扇区展示「名称: 数值 (占比%)」，移出后消失', async () => {
		const wrapper = mountDonut();
		expect(wrapper.find('.chart-tooltip').exists()).toBe(false);
		await wrapper.findAll('svg path')[0].trigger('mousemove', { clientX: 100, clientY: 100 });
		expect(wrapper.find('.chart-tooltip').text()).toBe('已通过: 8 (66.7%)');
		await wrapper.find('svg').trigger('mouseleave');
		expect(wrapper.find('.chart-tooltip').exists()).toBe(false);
	});

	it('悬浮时其余扇区降低不透明度', async () => {
		const wrapper = mountDonut();
		await wrapper.findAll('svg path')[0].trigger('mousemove', { clientX: 100, clientY: 100 });
		expect(wrapper.findAll('svg path')[0].classes()).toContain('opacity-100');
		expect(wrapper.findAll('svg path')[1].classes()).toContain('opacity-50');
	});

	it('未指定颜色时回落到内置配色', () => {
		const wrapper = mountDonut({ data: [{ name: 'A', value: 1 }] });
		expect(wrapper.find('svg path').attributes('fill')).toBe('#10b981');
	});
});

describe('LineAreaChart - 坐标轴', () => {
	it('无数据时展示「暂无数据」且不绘制折线与面积', () => {
		const wrapper = mountLine({ labels: [], values: [] });
		expect(texts(wrapper)).toContain('暂无数据');
		expect(wrapper.find('.line-path').exists()).toBe(false);
		expect(wrapper.find('.area-path').exists()).toBe(false);
	});

	it('Y 轴按整数间隔取值（maxInterval = 1）', () => {
		expect(yTicks(mountLine({ labels: ['a'], values: [3] }))).toEqual(['0', '1', '2', '3']);
	});

	it('Y 轴刻度取整并覆盖最大值', () => {
		expect(yTicks(mountLine({ labels: ['a'], values: [12] }))).toEqual(['0', '3', '6', '9', '12']);
	});

	it('全为 0 时 Y 轴退化为 0/1', () => {
		expect(yTicks(mountLine({ labels: ['a', 'b'], values: [0, 0] }))).toEqual(['0', '1']);
	});

	it('单点数据水平居中、按比例定位', () => {
		const wrapper = mountLine({ labels: ['05-06'], values: [4] });
		const point = wrapper.find('.data-point');
		expect(point.attributes('cx')).toBe('252'); // 40 + (464 - 40) / 2
		expect(point.attributes('cy')).toBe('16'); // 顶部：4 / 4 满量程
	});

	it('X 轴标签数量不超过 14 个时不旋转', () => {
		const wrapper = mountLine();
		expect(xTicks(wrapper)).toEqual(['05-06', '05-07']);
		expect(wrapper.find('.axis-label-x').attributes('transform')).toBeUndefined();
	});

	it('X 轴标签超过 14 个时旋转 45 度并按需抽稀', () => {
		const labels = Array.from({ length: 15 }, (_, i) => `05-${String(i + 1).padStart(2, '0')}`);
		const values = labels.map((_, i) => i);
		const wrapper = mountLine({ labels, values });
		const rendered = wrapper.findAll('.axis-label-x');
		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered.length).toBeLessThan(15);
		rendered.forEach((label) => expect(label.attributes('transform')).toContain('rotate(-45'));
	});
});

describe('LineAreaChart - 曲线与交互', () => {
	it('折线使用三次贝塞尔平滑（含 C 指令）', () => {
		const wrapper = mountLine();
		expect(wrapper.find('.line-path').attributes('d')).toContain('C');
	});

	it('面积路径闭合回 X 轴基线', () => {
		const wrapper = mountLine();
		const d = wrapper.find('.area-path').attributes('d');
		expect(d.endsWith('Z')).toBe(true);
		// 基线即绘制区底部：260 - 34 = 226
		expect(d).toContain('226');
	});

	it('每个数据点渲染一个圆点标记', () => {
		const wrapper = mountLine({ labels: ['a', 'b', 'c'], values: [1, 2, 3] });
		expect(wrapper.findAll('.data-point')).toHaveLength(3);
	});

	it('悬浮时显示原始日期与评论数', async () => {
		const wrapper = mountLine({
			labels: ['05-06', '05-07'],
			values: [3, 0],
			rawLabels: ['2024-05-06', '2024-05-07'],
		});
		expect(wrapper.find('.chart-tooltip').exists()).toBe(false);
		await wrapper.find('svg').trigger('mousemove', { clientX: 464, clientY: 120 });
		const tooltip = wrapper.find('.chart-tooltip');
		expect(tooltip.text()).toContain('2024-05-07');
		expect(tooltip.text()).toContain('评论数: 0');
		expect(wrapper.findAll('line[stroke-dasharray]')).toHaveLength(1);
	});

	it('鼠标在最左侧时命中第 1 个数据点', async () => {
		const wrapper = mountLine({ rawLabels: ['2024-05-06', '2024-05-07'] });
		await wrapper.find('svg').trigger('mousemove', { clientX: 40, clientY: 120 });
		expect(wrapper.find('.chart-tooltip').text()).toContain('2024-05-06');
	});

	it('移出图表后清除悬浮态', async () => {
		const wrapper = mountLine();
		await wrapper.find('svg').trigger('mousemove', { clientX: 100, clientY: 120 });
		expect(wrapper.find('.chart-tooltip').exists()).toBe(true);
		await wrapper.find('svg').trigger('mouseleave');
		expect(wrapper.find('.chart-tooltip').exists()).toBe(false);
	});
});
