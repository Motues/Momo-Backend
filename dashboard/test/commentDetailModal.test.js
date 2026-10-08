import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CommentDetailModal from '../src/components/CommentDetailModal.vue';
import { makeComment } from './support/harness.js';

const mountModal = (props = {}) =>
	mount(CommentDetailModal, {
		props: { visible: true, comment: makeComment(), ...props },
	});

const byText = (wrapper, text) =>
	wrapper.findAll('button').find((button) => button.text().replace(/\s+/g, '') === text);

const editButton = (wrapper) => wrapper.find('button[title="编辑"]');

const startEditing = async (wrapper) => {
	await editButton(wrapper).trigger('click');
};

describe('CommentDetailModal - 显示与隐藏', () => {
	it('visible=false 时不渲染任何内容', () => {
		const wrapper = mountModal({ visible: false });
		expect(wrapper.find('div.fixed.inset-0').exists()).toBe(false);
		expect(wrapper.text()).toBe('');
	});

	it('visible=true 时渲染弹窗容器', () => {
		const wrapper = mountModal();
		expect(wrapper.find('div.fixed.inset-0').exists()).toBe(true);
		expect(wrapper.text()).toContain('评论详情');
	});

	it('传入空评论对象不会崩溃并展示占位文案', () => {
		const wrapper = mountModal({ comment: {} });
		const text = wrapper.text();
		expect(text).toContain('无邮箱');
		expect(text).toContain('未知');
		expect(text).toContain('-');
		expect(text).toContain('Unknown / Unknown');
	});

	it('不传 comment 时使用默认空对象', () => {
		const wrapper = mount(CommentDetailModal, { props: { visible: true } });
		expect(wrapper.text()).toContain('无邮箱');
	});
});

describe('CommentDetailModal - 字段展示', () => {
	it('展示作者与邮箱', () => {
		const wrapper = mountModal({ comment: makeComment({ author: '李四', email: 'lisi@example.com' }) });
		expect(wrapper.text()).toContain('李四');
		expect(wrapper.text()).toContain('lisi@example.com');
	});

	it('展示评论内容', () => {
		const wrapper = mountModal({ comment: makeComment({ contentText: '你好世界' }) });
		expect(wrapper.text()).toContain('你好世界');
	});

	it('展示来源文章 slug', () => {
		const wrapper = mountModal({ comment: makeComment({ postSlug: 'my-post' }) });
		expect(wrapper.text()).toContain('my-post');
	});

	it('缺少 slug 时展示「未知」', () => {
		const wrapper = mountModal({ comment: makeComment({ postSlug: '' }) });
		expect(wrapper.text()).toContain('未知');
	});

	it('展示 IP 地址', () => {
		const wrapper = mountModal({ comment: makeComment({ ipAddress: '10.0.0.1' }) });
		expect(wrapper.text()).toContain('10.0.0.1');
	});

	it('缺少 IP 时展示 "-"', () => {
		const wrapper = mountModal({ comment: makeComment({ ipAddress: '' }) });
		expect(wrapper.text()).toContain('-');
	});

	it('展示操作系统与浏览器', () => {
		const wrapper = mountModal({ comment: makeComment({ os: 'macOS', browser: 'Safari' }) });
		expect(wrapper.text()).toContain('macOS / Safari');
	});

	it('展示评论 ID 与状态', () => {
		const wrapper = mountModal({ comment: makeComment({ id: 321, status: 'approved' }) });
		expect(wrapper.text()).toContain('ID: 321');
		expect(wrapper.text()).toContain('approved');
	});

	it('缺失 pubDate 时展示「未知」', () => {
		const wrapper = mountModal({ comment: makeComment({ pubDate: undefined }) });
		expect(wrapper.text()).toContain('未知');
	});

	it('存在 pubDate 时展示本地化时间', () => {
		const wrapper = mountModal({ comment: makeComment({ pubDate: '2024-05-06T07:08:09.000Z' }) });
		expect(wrapper.text()).toMatch(/\d{4}\/\d{2}\/\d{2}/);
	});

	it('有头像时渲染 img', () => {
		const wrapper = mountModal({ comment: makeComment({ avatar: 'https://cdn.example.com/a.png' }) });
		const img = wrapper.find('img[alt="avatar"]');
		expect(img.exists()).toBe(true);
		expect(img.attributes('src')).toBe('https://cdn.example.com/a.png');
	});

	it('没有头像时不渲染 img', () => {
		const wrapper = mountModal({ comment: makeComment({ avatar: undefined }) });
		expect(wrapper.find('img[alt="avatar"]').exists()).toBe(false);
	});

	it.each([
		['approved', 'bg-green-100'],
		['pending', 'bg-amber-100'],
		['deleted', 'bg-red-100'],
		['other', 'bg-gray-100'],
	])('状态 %s 使用 %s 样式', (status, cls) => {
		const wrapper = mountModal({ comment: makeComment({ status }) });
		expect(wrapper.find(`span.${cls}`).exists()).toBe(true);
	});
});

describe('CommentDetailModal - 作者链接安全校验', () => {
	it('https 链接渲染成可点击的 a 标签', () => {
		const wrapper = mountModal({ comment: makeComment({ url: 'https://a.example.com' }) });
		const a = wrapper.find('a');
		expect(a.exists()).toBe(true);
		expect(a.attributes('href')).toBe('https://a.example.com');
		expect(a.attributes('target')).toBe('_blank');
		expect(a.attributes('rel')).toContain('noopener');
	});

	it('mailto 链接允许点击', () => {
		const wrapper = mountModal({ comment: makeComment({ url: 'mailto:a@example.com' }) });
		expect(wrapper.find('a').attributes('href')).toBe('mailto:a@example.com');
	});

	it('相对路径链接允许点击', () => {
		const wrapper = mountModal({ comment: makeComment({ url: '/about' }) });
		expect(wrapper.find('a').attributes('href')).toBe('/about');
	});

	it('javascript: 链接被禁止点击并提示', () => {
		const wrapper = mountModal({ comment: makeComment({ url: 'javascript:alert(1)' }) });
		expect(wrapper.find('a').exists()).toBe(false);
		expect(wrapper.text()).toContain('（链接协议不受支持，已禁止点击）');
	});

	it('大小写混写的 JaVaScRiPt: 同样被禁止', () => {
		const wrapper = mountModal({ comment: makeComment({ url: 'JaVaScRiPt:alert(1)' }) });
		expect(wrapper.find('a').exists()).toBe(false);
	});

	it('data: 链接被禁止点击', () => {
		const wrapper = mountModal({ comment: makeComment({ url: 'data:text/html,<script>1</script>' }) });
		expect(wrapper.find('a').exists()).toBe(false);
		expect(wrapper.text()).toContain('（链接协议不受支持，已禁止点击）');
	});

	it('ftp: 链接被禁止点击', () => {
		const wrapper = mountModal({ comment: makeComment({ url: 'ftp://example.com/x' }) });
		expect(wrapper.find('a').exists()).toBe(false);
	});

	it('没有 url 时展示「无」', () => {
		const wrapper = mountModal({ comment: makeComment({ url: '' }) });
		expect(wrapper.find('a').exists()).toBe(false);
		expect(wrapper.text()).toContain('无');
	});

	it('url 为非字符串时按无链接处理', () => {
		const wrapper = mountModal({ comment: makeComment({ url: 12345 }) });
		expect(wrapper.find('a').exists()).toBe(false);
	});
});

describe('CommentDetailModal - 编辑流程', () => {
	it('初始不在编辑态，没有编辑输入框', () => {
		const wrapper = mountModal();
		expect(wrapper.text()).not.toContain('编辑评论');
		expect(wrapper.find('input[placeholder="作者昵称"]').exists()).toBe(false);
	});

	it('点击编辑按钮进入编辑态并预填表单', async () => {
		const wrapper = mountModal({
			comment: makeComment({ author: '张三', email: 'z@example.com', contentText: '内容', url: 'https://x.example.com' }),
		});
		await startEditing(wrapper);
		expect(wrapper.text()).toContain('编辑评论');
		expect(wrapper.find('input[placeholder="作者昵称"]').element.value).toBe('张三');
		expect(wrapper.find('input[placeholder="邮箱地址"]').element.value).toBe('z@example.com');
		expect(wrapper.find('textarea[placeholder="评论内容"]').element.value).toBe('内容');
		expect(wrapper.find('input[placeholder="个人网站 URL"]').element.value).toBe('https://x.example.com');
	});

	it('编辑态隐藏只读内容并显示可编辑控件', async () => {
		const wrapper = mountModal({ comment: makeComment({ contentText: '原始内容' }) });
		await startEditing(wrapper);
		expect(wrapper.find('textarea[placeholder="评论内容"]').exists()).toBe(true);
		expect(wrapper.find('button[title="编辑"]').exists()).toBe(false);
	});

	it('修改作者后保存：emit edit 且只包含变更字段', async () => {
		const wrapper = mountModal({ comment: makeComment({ id: 5, author: '旧名字' }) });
		await startEditing(wrapper);
		await wrapper.find('input[placeholder="作者昵称"]').setValue('新名字');
		await byText(wrapper, '保存').trigger('click');
		expect(wrapper.emitted('edit')).toEqual([[{ id: 5, author: '新名字' }]]);
	});

	it('保存后退出编辑态', async () => {
		const wrapper = mountModal();
		await startEditing(wrapper);
		await wrapper.find('input[placeholder="作者昵称"]').setValue('新名字');
		await byText(wrapper, '保存').trigger('click');
		expect(wrapper.text()).not.toContain('编辑评论');
	});

	it('修改多个字段时 payload 包含全部变更键', async () => {
		const wrapper = mountModal({
			comment: makeComment({ id: 6, author: 'A', email: 'a@b.com', contentText: 'c', url: 'https://u.example.com' }),
		});
		await startEditing(wrapper);
		await wrapper.find('input[placeholder="作者昵称"]').setValue('B');
		await wrapper.find('input[placeholder="邮箱地址"]').setValue('b@c.com');
		await byText(wrapper, '保存').trigger('click');
		expect(wrapper.emitted('edit')[0][0]).toEqual({ id: 6, author: 'B', email: 'b@c.com' });
	});

	it('只修改链接时只提交 url', async () => {
		const wrapper = mountModal({ comment: makeComment({ id: 9, url: 'https://old.example.com' }) });
		await startEditing(wrapper);
		await wrapper.find('input[placeholder="个人网站 URL"]').setValue('https://new.example.com');
		await byText(wrapper, '保存').trigger('click');
		expect(wrapper.emitted('edit')).toEqual([[{ id: 9, url: 'https://new.example.com' }]]);
	});

	it('未做任何修改就保存：不触发 edit 且退出编辑态', async () => {
		const wrapper = mountModal();
		await startEditing(wrapper);
		await byText(wrapper, '保存').trigger('click');
		expect(wrapper.emitted('edit')).toBeUndefined();
		expect(wrapper.text()).not.toContain('编辑评论');
	});

	it('把字段清空也算修改（提交空字符串）', async () => {
		const wrapper = mountModal({ comment: makeComment({ id: 3, author: '有名字' }) });
		await startEditing(wrapper);
		await wrapper.find('input[placeholder="作者昵称"]').setValue('');
		await byText(wrapper, '保存').trigger('click');
		expect(wrapper.emitted('edit')).toEqual([[{ id: 3, author: '' }]]);
	});

	it('点击取消放弃修改并恢复只读内容', async () => {
		const wrapper = mountModal({ comment: makeComment({ contentText: '原始内容' }) });
		await startEditing(wrapper);
		await wrapper.find('textarea[placeholder="评论内容"]').setValue('改过的内容');
		await byText(wrapper, '取消').trigger('click');
		expect(wrapper.text()).not.toContain('编辑评论');
		expect(wrapper.text()).toContain('原始内容');
		expect(wrapper.emitted('edit')).toBeUndefined();
	});

	it('取消后再次进入编辑，表单回到服务端数据而不是上次的草稿', async () => {
		const wrapper = mountModal({ comment: makeComment({ author: '原名' }) });
		await startEditing(wrapper);
		await wrapper.find('input[placeholder="作者昵称"]').setValue('草稿');
		await byText(wrapper, '取消').trigger('click');
		await startEditing(wrapper);
		expect(wrapper.find('input[placeholder="作者昵称"]').element.value).toBe('原名');
	});

	it('编辑态点击遮罩只退出编辑态、不关闭弹窗', async () => {
		const wrapper = mountModal();
		await startEditing(wrapper);
		await wrapper.find('div.absolute.inset-0').trigger('click');
		expect(wrapper.emitted('close')).toBeUndefined();
		expect(wrapper.text()).not.toContain('编辑评论');
	});

	it('只读态点击遮罩关闭弹窗', async () => {
		const wrapper = mountModal();
		await wrapper.find('div.absolute.inset-0').trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('只读态点击右上角关闭按钮 emit close', async () => {
		const wrapper = mountModal();
		await wrapper.findAll('div.sticky.top-0 button').at(-1).trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('重新打开弹窗时重置编辑状态', async () => {
		const wrapper = mountModal({ comment: makeComment({ author: '原名' }) });
		await startEditing(wrapper);
		await wrapper.find('input[placeholder="作者昵称"]').setValue('草稿');
		await wrapper.setProps({ visible: false });
		await wrapper.setProps({ visible: true });
		await wrapper.vm.$nextTick();
		expect(wrapper.text()).not.toContain('编辑评论');
		expect(wrapper.text()).toContain('原名');
	});
});

describe('CommentDetailModal - 状态操作', () => {
	it('未通过时点击「通过」emit update(id, "approved")', async () => {
		const wrapper = mountModal({ comment: makeComment({ id: 21, status: 'pending' }) });
		await wrapper.find('button .fa-check').trigger('click');
		expect(wrapper.emitted('update')).toEqual([[21, 'approved']]);
	});

	it('已通过时点击「撤回」emit update(id, "pending")', async () => {
		const wrapper = mountModal({ comment: makeComment({ id: 22, status: 'approved' }) });
		await wrapper.find('button .fa-ban').trigger('click');
		expect(wrapper.emitted('update')).toEqual([[22, 'pending']]);
	});

	it('点击删除 emit delete(id)', async () => {
		const wrapper = mountModal({ comment: makeComment({ id: 23, status: 'pending' }) });
		await wrapper.find('button .fa-trash-can').trigger('click');
		expect(wrapper.emitted('delete')).toEqual([[23]]);
	});

	it('已删除的评论删除按钮禁用', () => {
		const wrapper = mountModal({ comment: makeComment({ status: 'deleted' }) });
		const deleteButton = wrapper.find('button .fa-trash-can').element.closest('button');
		expect(deleteButton.disabled).toBe(true);
	});

	it('编辑态不展示状态操作按钮', async () => {
		const wrapper = mountModal();
		await startEditing(wrapper);
		expect(wrapper.find('button .fa-trash-can').exists()).toBe(false);
		expect(wrapper.find('button .fa-check').exists()).toBe(false);
	});
});
