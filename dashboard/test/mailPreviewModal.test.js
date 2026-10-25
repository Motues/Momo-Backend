import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MailPreviewModal from '../src/components/MailPreviewModal.vue';

/**
 * 预览弹窗：重点是 `sandbox=""` 的 iframe（模板是管理员自己写的 HTML，
 * 预览也不能执行脚本 / 提交表单），以及跟随主题（这里只测宽度切换与关闭）。
 */

let wrapper;

const mountModal = (props = {}) => {
	wrapper = mount(MailPreviewModal, {
		props: { kind: 'reply', title: '回复通知预览', siteName: '我的博客', ...props },
	});
	return wrapper;
};

const frame = () => wrapper.get('[data-test="mail-preview-frame"]');

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
});

describe('MailPreviewModal —— 渲染', () => {
	it('iframe 带 sandbox 限制且不透传 referrer', () => {
		mountModal();
		expect(frame().attributes('sandbox')).toBe('');
		expect(frame().attributes('referrerpolicy')).toBe('no-referrer');
	});

	it('默认模板渲染进 srcdoc（含演示数据）', () => {
		mountModal();
		const srcdoc = frame().attributes('srcdoc');
		expect(srcdoc).toContain('回复了您在');
		expect(srcdoc).toContain('Momo &lt;站长&gt;');
		expect(srcdoc).toContain('data:image/svg+xml');
	});

	it('主题文案按站点名拼出', () => {
		mountModal();
		expect(wrapper.get('[data-test="mail-preview-subject"]').text()).toBe(
			'主题：您在 我的博客 上的评论有了新回复',
		);
	});

	it('自定义模板原样渲染（跟随 props 变化）', async () => {
		mountModal({ template: '<p>自定义 {{postTitle}}</p>' });
		expect(frame().attributes('srcdoc')).toContain('<p>自定义 如何在 Momo 里自定义邮件模板</p>');

		await wrapper.setProps({ template: '<p>换了一份模板</p>' });
		expect(frame().attributes('srcdoc')).toContain('<p>换了一份模板</p>');
	});

	it('模板留空时提示正在预览默认模板，否则提示按当前模板渲染', async () => {
		mountModal({ template: '' });
		expect(wrapper.get('[data-test="mail-preview-hint"]').text()).toContain('内置默认模板');

		await wrapper.setProps({ template: '<p>x</p>' });
		expect(wrapper.get('[data-test="mail-preview-hint"]').text()).toContain('按面板里当前的模板渲染');
	});

	it('提示里说明表情短代码不会在预览里水合', () => {
		mountModal();
		expect(wrapper.get('[data-test="mail-preview-hint"]').text()).toContain(':name:');
	});
});

describe('MailPreviewModal —— 宽度切换', () => {
	it('默认桌面宽度 640px，切到手机 375px', async () => {
		mountModal();
		expect(frame().attributes('style')).toContain('width: 640px');
		expect(wrapper.get('[data-test="mail-preview-width-desktop"]').attributes('aria-pressed')).toBe('true');

		await wrapper.get('[data-test="mail-preview-width-mobile"]').trigger('click');
		expect(frame().attributes('style')).toContain('width: 375px');
		expect(wrapper.get('[data-test="mail-preview-width-mobile"]').attributes('aria-pressed')).toBe('true');
		expect(wrapper.get('[data-test="mail-preview-width-desktop"]').attributes('aria-pressed')).toBe('false');
	});
});

describe('MailPreviewModal —— 关闭', () => {
	it('点右上角关闭按钮触发 close', async () => {
		mountModal();
		await wrapper.get('[data-test="mail-preview-close"]').trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('点遮罩触发 close', async () => {
		mountModal();
		await wrapper.get('[data-test="mail-preview-modal"] > div').trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('按 Esc 触发 close', async () => {
		mountModal();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('其它按键不关闭', async () => {
		mountModal();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		expect(wrapper.emitted('close')).toBeUndefined();
	});

	it('卸载时移除 window 上的 Esc 监听（避免弹窗关掉后还在响应）', () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');
		mountModal();
		wrapper.unmount();
		wrapper = undefined;
		expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
		removeSpy.mockRestore();
	});
});
