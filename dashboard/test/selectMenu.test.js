import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SelectMenu from '../src/components/SelectMenu.vue';

/**
 * 自定义下拉框（替代浏览器原生 <select>）的行为约束。
 * 原生控件已不再出现在页面中，因此这里锁定自绘实现的交互契约。
 */
const OPTIONS = [
	{ label: '全部用户', value: 'all' },
	{ label: '邮箱已验证', value: 'true' },
	{ label: '邮箱未验证', value: 'false' },
];

const mountMenu = (props = {}) => mount(SelectMenu, { props: { options: OPTIONS, modelValue: 'all', ...props } });

const trigger = (wrapper) => wrapper.find('[role="combobox"]');
const listbox = (wrapper) => wrapper.find('[role="listbox"]');
const options = (wrapper) => wrapper.findAll('[role="option"]');
const optionByText = (wrapper, text) => options(wrapper).find((item) => item.text().includes(text));

describe('SelectMenu - 渲染', () => {
	it('不使用原生 select 元素', () => {
		const wrapper = mountMenu();
		expect(wrapper.find('select').exists()).toBe(false);
	});

	it('触发器上展示当前选中项文案', () => {
		const wrapper = mountMenu({ modelValue: 'true' });
		expect(trigger(wrapper).text()).toContain('邮箱已验证');
	});

	it('modelValue 未命中任何选项时展示占位文案', () => {
		const wrapper = mountMenu({ modelValue: 'nope', placeholder: '请选择' });
		expect(trigger(wrapper).text()).toContain('请选择');
	});

	it('默认不渲染下拉面板', () => {
		const wrapper = mountMenu();
		expect(listbox(wrapper).exists()).toBe(false);
	});

	it('用当前选中项文案作为默认 tooltip', () => {
		const wrapper = mountMenu({ modelValue: 'false' });
		expect(trigger(wrapper).attributes('title')).toBe('邮箱未验证');
	});

	it('支持字符串数组选项', () => {
		const wrapper = mount(SelectMenu, { props: { options: ['甲', '乙'], modelValue: '乙' } });
		expect(trigger(wrapper).text()).toContain('乙');
		expect(options(wrapper)).toHaveLength(0);
	});

	it('选项为空时展开面板展示「无可选项」', async () => {
		const wrapper = mountMenu({ options: [], modelValue: '' });
		await trigger(wrapper).trigger('click');
		expect(listbox(wrapper).text()).toContain('无可选项');
	});
});

describe('SelectMenu - 选择交互', () => {
	it('点击触发器展开面板并渲染全部选项', async () => {
		const wrapper = mountMenu();
		await trigger(wrapper).trigger('click');
		expect(listbox(wrapper).exists()).toBe(true);
		expect(options(wrapper).map((item) => item.text())).toEqual(['全部用户', '邮箱已验证', '邮箱未验证']);
	});

	it('当前选中项带 aria-selected 与勾选图标', async () => {
		const wrapper = mountMenu({ modelValue: 'true' });
		await trigger(wrapper).trigger('click');
		const selected = optionByText(wrapper, '邮箱已验证');
		expect(selected.attributes('aria-selected')).toBe('true');
		expect(selected.find('.fa-check').exists()).toBe(true);
	});

	it('点击选项 emit update:modelValue 与 change 并关闭面板', async () => {
		const wrapper = mountMenu();
		await trigger(wrapper).trigger('click');
		await optionByText(wrapper, '邮箱未验证').trigger('click');
		expect(wrapper.emitted('update:modelValue')).toEqual([['false']]);
		expect(wrapper.emitted('change')).toEqual([['false']]);
		expect(listbox(wrapper).exists()).toBe(false);
	});

	it('重复选择当前项不产生新事件', async () => {
		const wrapper = mountMenu({ modelValue: 'all' });
		await trigger(wrapper).trigger('click');
		await optionByText(wrapper, '全部用户').trigger('click');
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
		expect(wrapper.emitted('change')).toBeUndefined();
	});

	it('点击外部关闭面板', async () => {
		const wrapper = mountMenu();
		await trigger(wrapper).trigger('click');
		document.dispatchEvent(new Event('mousedown', { bubbles: true }));
		await wrapper.vm.$nextTick();
		expect(listbox(wrapper).exists()).toBe(false);
	});

	it('点击组件内部不关闭面板', async () => {
		const wrapper = mountMenu();
		await trigger(wrapper).trigger('click');
		await trigger(wrapper).trigger('mousedown');
		expect(listbox(wrapper).exists()).toBe(true);
	});

	it('再次点击触发器收起面板', async () => {
		const wrapper = mountMenu();
		await trigger(wrapper).trigger('click');
		await trigger(wrapper).trigger('click');
		expect(listbox(wrapper).exists()).toBe(false);
	});

	it('disabled 时不可展开', async () => {
		const wrapper = mountMenu({ disabled: true });
		await trigger(wrapper).trigger('click');
		expect(listbox(wrapper).exists()).toBe(false);
		expect(trigger(wrapper).attributes('disabled')).toBeDefined();
	});
});

describe('SelectMenu - 键盘操作', () => {
	it('ArrowDown 打开面板并高亮当前项', async () => {
		const wrapper = mountMenu({ modelValue: 'true' });
		await trigger(wrapper).trigger('keydown', { key: 'ArrowDown' });
		expect(listbox(wrapper).exists()).toBe(true);
		expect(options(wrapper)[1].classes()).toContain('bg-gray-100');
	});

	it('ArrowDown / ArrowUp 循环移动高亮', async () => {
		const wrapper = mountMenu({ modelValue: 'all' });
		await trigger(wrapper).trigger('keydown', { key: 'ArrowDown' });
		await trigger(wrapper).trigger('keydown', { key: 'ArrowDown' });
		expect(options(wrapper)[1].classes()).toContain('bg-gray-100');
		await trigger(wrapper).trigger('keydown', { key: 'ArrowUp' });
		expect(options(wrapper)[0].classes()).toContain('bg-gray-100');
		await trigger(wrapper).trigger('keydown', { key: 'ArrowUp' });
		expect(options(wrapper)[2].classes()).toContain('bg-gray-100');
	});

	it('Enter 选中高亮项', async () => {
		const wrapper = mountMenu({ modelValue: 'all' });
		await trigger(wrapper).trigger('keydown', { key: 'ArrowDown' });
		await trigger(wrapper).trigger('keydown', { key: 'ArrowDown' });
		await trigger(wrapper).trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted('update:modelValue')).toEqual([['true']]);
	});

	it('Escape 关闭面板且不改变取值', async () => {
		const wrapper = mountMenu();
		await trigger(wrapper).trigger('keydown', { key: 'ArrowDown' });
		await trigger(wrapper).trigger('keydown', { key: 'Escape' });
		expect(listbox(wrapper).exists()).toBe(false);
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});
});

describe('SelectMenu - 主题色', () => {
	it('默认使用蓝色强调色', async () => {
		const wrapper = mountMenu({ modelValue: 'all' });
		await trigger(wrapper).trigger('click');
		expect(optionByText(wrapper, '全部用户').classes()).toContain('text-blue-600');
	});

	it('可切换为 emerald 强调色', async () => {
		const wrapper = mountMenu({ modelValue: 'all', accent: 'emerald' });
		await trigger(wrapper).trigger('click');
		expect(optionByText(wrapper, '全部用户').classes()).toContain('text-emerald-600');
	});
});
