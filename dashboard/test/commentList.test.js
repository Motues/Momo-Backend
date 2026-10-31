import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import CommentList from '../src/components/CommentList.vue';
import { makeComment } from './support/harness.js';

/** CommentDetailModal 的占位组件：只暴露 props 与事件，避免连带挂载真实弹窗 */
const ModalStub = defineComponent({
	name: 'CommentDetailModal',
	props: {
		visible: { type: Boolean, default: false },
		comment: { type: Object, default: () => ({}) },
	},
	emits: ['close', 'update', 'delete', 'edit', 'view-user'],
	template: '<div class="modal-stub" />',
});

const mountList = (props = {}) =>
	mount(CommentList, {
		props: {
			data: [],
			pagination: { page: 1, totalPage: 1 },
			...props,
		},
		global: { stubs: { CommentDetailModal: ModalStub } },
	});

const rows = (wrapper) => wrapper.findAll('tbody tr');
const modal = (wrapper) => wrapper.findComponent(ModalStub);
const pagerButtons = (wrapper) =>
	wrapper.findAll('button').filter((button) => ['上一页', '下一页'].includes(button.text().trim()));

beforeEach(() => {
	localStorage.clear();
});

describe('CommentList - 列表渲染', () => {
	it('渲染作者、邮箱、IP 与评论内容', () => {
		const wrapper = mountList({ data: [makeComment()] });
		const text = wrapper.text();
		expect(text).toContain('张三');
		expect(text).toContain('zhangsan@example.com');
		expect(text).toContain('203.0.113.9');
		expect(text).toContain('这是一条测试评论');
	});

	it('渲染评论状态文本', () => {
		const wrapper = mountList({ data: [makeComment({ status: 'approved' })] });
		expect(wrapper.text()).toContain('approved');
	});

	it('列表条数与数据条数一致', () => {
		const wrapper = mountList({
			data: [makeComment({ id: 1 }), makeComment({ id: 2 }), makeComment({ id: 3 })],
		});
		expect(rows(wrapper)).toHaveLength(3);
	});

	it('空列表不渲染任何行', () => {
		const wrapper = mountList({ data: [] });
		expect(rows(wrapper)).toHaveLength(0);
	});

	it('未知状态回落到灰色样式', () => {
		const wrapper = mountList({ data: [makeComment({ status: 'unknown-status' })] });
		expect(wrapper.find('tbody span.bg-gray-100').exists()).toBe(true);
	});

	it.each([
		['approved', 'bg-green-100'],
		['pending', 'bg-amber-100'],
		['deleted', 'bg-red-100'],
	])('状态 %s 使用 %s 徽章样式', (status, cls) => {
		const wrapper = mountList({ data: [makeComment({ status })] });
		expect(wrapper.find(`tbody span.${cls}`).exists()).toBe(true);
	});

	it('展示格式化后的发布时间', () => {
		const wrapper = mountList({ data: [makeComment({ pubDate: '2024-05-06T07:08:09.000Z' })] });
		expect(wrapper.text()).toMatch(/\d{2}\/\d{2}\s+\d{1,2}:\d{2}/);
	});

	it('缺少 pubDate 时渲染 Invalid Date（已记录的缺陷：缺少空值兜底）', () => {
		const wrapper = mountList({ data: [makeComment({ pubDate: undefined })] });
		expect(wrapper.text()).toContain('Invalid Date');
	});
});

describe('CommentList - 状态切换按钮', () => {
	it('未通过的评论显示「通过」按钮、不显示「撤回」按钮', () => {
		const wrapper = mountList({ data: [makeComment({ status: 'pending' })] });
		const row = rows(wrapper)[0];
		expect(row.findAll('button')).toHaveLength(2); // 通过 + 删除
		expect(row.findAll('button')[0].find('.fa-check').exists()).toBe(true);
		expect(row.find('.fa-ban').exists()).toBe(false);
	});

	it('已通过的评论显示「撤回」按钮、不显示「通过」按钮', () => {
		const wrapper = mountList({ data: [makeComment({ status: 'approved' })] });
		const row = rows(wrapper)[0];
		expect(row.find('.fa-ban').exists()).toBe(true);
		expect(row.find('.fa-check').exists()).toBe(false);
	});

	it('点击「通过」emit update(id, "approved")', async () => {
		const wrapper = mountList({ data: [makeComment({ id: 7, status: 'pending' })] });
		await rows(wrapper)[0].findAll('button')[0].trigger('click');
		expect(wrapper.emitted('update')).toEqual([[7, 'approved']]);
	});

	it('点击「撤回」emit update(id, "pending")', async () => {
		const wrapper = mountList({ data: [makeComment({ id: 8, status: 'approved' })] });
		await rows(wrapper)[0].findAll('button')[0].trigger('click');
		expect(wrapper.emitted('update')).toEqual([[8, 'pending']]);
	});

	it('点击删除按钮 emit update(id, "deleted")', async () => {
		const wrapper = mountList({ data: [makeComment({ id: 9, status: 'pending' })] });
		await rows(wrapper)[0].findAll('button')[1].trigger('click');
		expect(wrapper.emitted('update')).toEqual([[9, 'deleted']]);
	});

	it('已删除的评论删除按钮被禁用', () => {
		const wrapper = mountList({ data: [makeComment({ status: 'deleted' })] });
		expect(rows(wrapper)[0].findAll('button')[1].attributes('disabled')).toBeDefined();
	});

	it('未删除的评论删除按钮可用', () => {
		const wrapper = mountList({ data: [makeComment({ status: 'pending' })] });
		expect(rows(wrapper)[0].findAll('button')[1].attributes('disabled')).toBeUndefined();
	});

	it('已删除的评论仍可通过「通过」按钮恢复', async () => {
		const wrapper = mountList({ data: [makeComment({ id: 11, status: 'deleted' })] });
		await rows(wrapper)[0].findAll('button')[0].trigger('click');
		expect(wrapper.emitted('update')).toEqual([[11, 'approved']]);
	});

	it('点击行内按钮不会同时打开详情弹窗（事件隔离）', async () => {
		const wrapper = mountList({ data: [makeComment()] });
		await rows(wrapper)[0].findAll('button')[1].trigger('click');
		expect(wrapper.emitted('update')).toHaveLength(1);
		expect(modal(wrapper).props('visible')).toBe(false);
	});

	it('多行数据时每行操作对应各自的 id', async () => {
		const wrapper = mountList({
			data: [
				makeComment({ id: 101, status: 'approved' }),
				makeComment({ id: 202, status: 'approved' }),
			],
		});
		await rows(wrapper)[1].findAll('button')[0].trigger('click');
		expect(wrapper.emitted('update')).toEqual([[202, 'pending']]);
	});
});

describe('CommentList - 详情弹窗', () => {
	it('初始不展示弹窗', () => {
		const wrapper = mountList({ data: [makeComment()] });
		expect(modal(wrapper).props('visible')).toBe(false);
	});

	it('点击行打开弹窗并传入该行数据', async () => {
		const comment = makeComment({ id: 55, author: '李四' });
		const wrapper = mountList({ data: [comment] });
		await rows(wrapper)[0].trigger('click');
		expect(modal(wrapper).props('visible')).toBe(true);
		expect(modal(wrapper).props('comment')).toEqual(comment);
	});

	it('弹窗 close 事件关闭弹窗并清空选中评论', async () => {
		const wrapper = mountList({ data: [makeComment()] });
		await rows(wrapper)[0].trigger('click');
		modal(wrapper).vm.$emit('close');
		await wrapper.vm.$nextTick();
		expect(modal(wrapper).props('visible')).toBe(false);
		expect(modal(wrapper).props('comment')).toEqual({});
	});

	it('弹窗 update 事件向外透传', async () => {
		const wrapper = mountList({ data: [makeComment()] });
		modal(wrapper).vm.$emit('update', 66, 'approved');
		expect(wrapper.emitted('update')).toEqual([[66, 'approved']]);
	});

	it('弹窗 delete 事件转换成 update(id, "deleted")', async () => {
		const wrapper = mountList({ data: [makeComment()] });
		modal(wrapper).vm.$emit('delete', 77);
		expect(wrapper.emitted('update')).toEqual([[77, 'deleted']]);
	});

	it('弹窗 edit 事件向外透传 edit', async () => {
		const wrapper = mountList({ data: [makeComment()] });
		const payload = { id: 88, author: '新作者' };
		modal(wrapper).vm.$emit('edit', payload);
		expect(wrapper.emitted('edit')).toEqual([[payload]]);
	});

	it('弹窗 view-user 事件向外透传（昵称跳转）', async () => {
		const wrapper = mountList({ data: [makeComment()] });
		const payload = { author: '张三', email: 'zhangsan@example.com' };
		modal(wrapper).vm.$emit('view-user', payload);
		expect(wrapper.emitted('view-user')).toEqual([[payload]]);
	});
});

describe('CommentList - 昵称跳转用户评论页', () => {
	it('点击昵称 emit view-user，且不会打开详情弹窗', async () => {
		const wrapper = mountList({
			data: [makeComment({ author: '李四', email: 'lisi@example.com' })],
		});
		await wrapper.get('tbody [data-test="comment-author-link"]').trigger('click');

		expect(wrapper.emitted('view-user')).toEqual([
			[{ author: '李四', email: 'lisi@example.com' }],
		]);
		expect(modal(wrapper).props('visible')).toBe(false);
	});

	it('昵称链接指向 /user-comments 并携带 author + email', () => {
		const wrapper = mountList({
			data: [makeComment({ author: '张 三', email: 'a+b@example.com' })],
		});
		const link = wrapper.get('tbody [data-test="comment-author-link"]');
		expect(link.attributes('href')).toBe(
			'/user-comments?author=%E5%BC%A0%20%E4%B8%89&email=a%2Bb%40example.com'
		);
		expect(link.attributes('title')).toContain('查看');
	});

	it('没有邮箱时昵称退化为纯文本（不提供跳转）', () => {
		const wrapper = mountList({ data: [makeComment({ email: '' })] });
		expect(wrapper.find('tbody [data-test="comment-author-link"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('张三');
	});
});

describe('CommentList - 分页', () => {
	it('展示总页数', () => {
		const wrapper = mountList({ pagination: { page: 2, totalPage: 9 } });
		expect(wrapper.text()).toContain('共 9 页数据');
	});

	it('展示当前页码', () => {
		const wrapper = mountList({ pagination: { page: 3, totalPage: 9 } });
		expect(wrapper.text()).toContain('3');
	});

	it('第一页时「上一页」禁用', () => {
		const wrapper = mountList({ pagination: { page: 1, totalPage: 5 } });
		expect(pagerButtons(wrapper)[0].attributes('disabled')).toBeDefined();
	});

	it('第一页点击「下一页」emit page-change(2)', async () => {
		const wrapper = mountList({ pagination: { page: 1, totalPage: 5 } });
		await pagerButtons(wrapper)[1].trigger('click');
		expect(wrapper.emitted('page-change')).toEqual([[2]]);
	});

	it('最后一页时「下一页」禁用', () => {
		const wrapper = mountList({ pagination: { page: 5, totalPage: 5 } });
		expect(pagerButtons(wrapper)[1].attributes('disabled')).toBeDefined();
	});

	it('最后一页点击「上一页」emit page-change(4)', async () => {
		const wrapper = mountList({ pagination: { page: 5, totalPage: 5 } });
		await pagerButtons(wrapper)[0].trigger('click');
		expect(wrapper.emitted('page-change')).toEqual([[4]]);
	});

	it('中间页两个按钮都可用', () => {
		const wrapper = mountList({ pagination: { page: 3, totalPage: 5 } });
		expect(pagerButtons(wrapper)[0].attributes('disabled')).toBeUndefined();
		expect(pagerButtons(wrapper)[1].attributes('disabled')).toBeUndefined();
	});

	it('空列表时仍保留分页信息', () => {
		const wrapper = mountList({ data: [], pagination: { page: 1, totalPage: 1 } });
		expect(wrapper.text()).toContain('共 1 页数据');
		expect(pagerButtons(wrapper)).toHaveLength(2);
	});
});

describe('CommentList - 批量审核勾选', () => {
	const threeComments = () => [
		makeComment({ id: 1 }),
		makeComment({ id: 2 }),
		makeComment({ id: 3 }),
	];

	it('默认不渲染工具栏，勾选一条后出现并显示数量', async () => {
		const wrapper = mountList({ data: threeComments() });
		expect(wrapper.find('[data-test="batch-action-bar"]').exists()).toBe(false);

		await wrapper.findAll('[data-test="comment-select"]')[0].trigger('change');
		const bar = wrapper.get('[data-test="batch-action-bar"]');
		expect(bar.exists()).toBe(true);
		expect(bar.text()).toContain('1');
	});

	it('表头全选勾上当前页全部，再次点击清空', async () => {
		const wrapper = mountList({ data: threeComments() });
		await wrapper.get('[data-test="comments-select-all"]').trigger('change');
		expect(wrapper.get('[data-test="batch-count"]').text()).toBe('3');

		await wrapper.get('[data-test="comments-select-all"]').trigger('change');
		expect(wrapper.find('[data-test="batch-action-bar"]').exists()).toBe(false);
	});

	it('勾选部分时全选框为 indeterminate', async () => {
		const wrapper = mountList({ data: threeComments() });
		await wrapper.findAll('[data-test="comment-select"]')[0].trigger('change');
		expect(wrapper.get('[data-test="comments-select-all"]').element.indeterminate).toBe(true);
	});

	it('点击批量通过 emit batch-update(ids, approved)', async () => {
		const wrapper = mountList({ data: threeComments() });
		await wrapper.get('[data-test="comments-select-all"]').trigger('change');
		await wrapper.get('[data-test="batch-approve"]').trigger('click');

		expect(wrapper.emitted('batch-update')).toEqual([[[1, 2, 3], 'approved']]);
	});

	it('批量删除 emit 的是 deleted（级联语义由后端单条接口保证）', async () => {
		const wrapper = mountList({ data: threeComments() });
		await wrapper.findAll('[data-test="comment-select"]')[1].trigger('change');
		await wrapper.get('[data-test="batch-delete"]').trigger('click');

		expect(wrapper.emitted('batch-update')).toEqual([[[2], 'deleted']]);
	});

	it('数据刷新后自动移出已不存在的勾选', async () => {
		const wrapper = mountList({ data: threeComments() });
		await wrapper.get('[data-test="comments-select-all"]').trigger('change');

		await wrapper.setProps({ data: [makeComment({ id: 1 })] });
		expect(wrapper.get('[data-test="batch-count"]').text()).toBe('1');
	});

	it('暴露 clearSelection / setSelection，供父组件在批量操作后回填失败项', async () => {
		const wrapper = mountList({ data: threeComments() });
		await wrapper.get('[data-test="comments-select-all"]').trigger('change');

		wrapper.vm.setSelection([2, 99]);
		await wrapper.vm.$nextTick();
		expect(wrapper.get('[data-test="batch-count"]').text()).toBe('1');

		wrapper.vm.clearSelection();
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-test="batch-action-bar"]').exists()).toBe(false);
	});

	it('批量处理中禁用三个动作按钮', async () => {
		const wrapper = mountList({ data: threeComments(), batchLoading: true });
		await wrapper.get('[data-test="comments-select-all"]').trigger('change');

		for (const name of ['batch-approve', 'batch-pending', 'batch-delete']) {
			expect(wrapper.get(`[data-test="${name}"]`).attributes('disabled')).toBeDefined();
		}
	});
});

describe('CommentList - 来源文章列', () => {
	it('表头在「评论内容」与「状态」之间新增「来源文章」', () => {
		const wrapper = mountList({ data: [makeComment()] });
		expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual([
			'',
			'作者',
			'评论内容',
			'来源文章',
			'状态',
			'管理',
		]);
	});

	it('展示文章 slug，并用 title 提示可点击筛选', () => {
		const wrapper = mountList({ data: [makeComment({ postSlug: 'blog/2026/hello-world' })] });
		const cell = wrapper.get('tbody [data-test="comment-post-slug"]');
		expect(cell.text()).toBe('blog/2026/hello-world');
		expect(cell.attributes('title')).toContain('blog/2026/hello-world');
		expect(cell.classes()).toEqual(expect.arrayContaining(['truncate', 'max-w-[180px]']));
	});

	it('点击来源文章 emit filter-slug，且不会打开详情弹窗', async () => {
		const wrapper = mountList({ data: [makeComment({ postSlug: 'blog/2026/hello-world' })] });
		await wrapper.get('tbody [data-test="comment-post-slug"]').trigger('click');

		expect(wrapper.emitted('filter-slug')).toEqual([['blog/2026/hello-world']]);
		expect(modal(wrapper).props('visible')).toBe(false);
	});

	it('没有文章标识时显示占位符', () => {
		const wrapper = mountList({ data: [makeComment({ postSlug: '' })] });
		expect(wrapper.get('tbody [data-test="comment-post-slug-empty"]').text()).toBe('—');
	});
});
