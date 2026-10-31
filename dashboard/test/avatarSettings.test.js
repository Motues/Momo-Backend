import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import AvatarSettings from '../src/views/AvatarSettings.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

let wrapper;

const mountPage = async (data = {}) => {
	requestMock.get.mockResolvedValue({ code: 200, data });
	requestMock.put.mockResolvedValue({ code: 200 });
	const router = await createTestRouter('/settings/avatar');
	wrapper = mount(AvatarSettings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
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

describe('AvatarSettings - 加载', () => {
	it('只请求 avatar 分组', async () => {
		await mountPage({ avatar_source: 'gravatar', avatar_custom_url: '' });
		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'avatar' } });
	});

	it('回显已保存来源；选择 custom 时显示模板输入框', async () => {
		await mountPage({
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/{hash}',
		});
		expect(wrapper.get('[data-test="avatar-custom-section"]').exists()).toBe(true);
		expect(wrapper.get('[data-test="avatar-custom-url"]').element.value).toBe(
			'https://cdn.example.com/{hash}'
		);
		expect(wrapper.get('[data-test="avatar-source-custom"]').text()).toContain('已选择');
	});

	it('未配置时默认选中内置源，不显示自定义区域', async () => {
		await mountPage({});
		expect(wrapper.get('[data-test="avatar-source-default"]').text()).toContain('已选择');
		expect(wrapper.find('[data-test="avatar-custom-section"]').exists()).toBe(false);
	});

	it('已关闭头像时开关为关闭态、隐藏来源并展示默认头像', async () => {
		await mountPage({ avatar_enabled: 'false', avatar_source: 'custom', avatar_custom_url: 'https://x/{hash}' });
		expect(wrapper.get('[data-test="avatar-enabled"]').element.checked).toBe(false);
		expect(wrapper.find('[data-test="avatar-source-list"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="avatar-custom-section"]').exists()).toBe(false);
		expect(wrapper.get('[data-test="avatar-default-preview"]').text()).toContain('默认头像');
	});
});

describe('AvatarSettings - 交互与保存', () => {
	it('点击来源卡片切换选择', async () => {
		await mountPage({});
		await wrapper.get('[data-test="avatar-source-gravatar"]').trigger('click');
		expect(wrapper.get('[data-test="avatar-source-gravatar"]').text()).toContain('已选择');
		expect(wrapper.get('[data-test="avatar-source-default"]').text()).not.toContain('已选择');
	});

	it('占位符按钮把对应标记追加到模板', async () => {
		await mountPage({ avatar_source: 'custom', avatar_custom_url: 'https://x/' });
		await wrapper.get('[data-test="avatar-placeholder-hash"]').trigger('click');
		await wrapper.get('[data-test="avatar-placeholder-email"]').trigger('click');
		expect(wrapper.get('[data-test="avatar-custom-url"]').element.value).toBe(
			'https://x/{hash}{email}'
		);
	});

	it('选择 custom 但模板为空时拦截保存并提示', async () => {
		await mountPage({});
		await wrapper.get('[data-test="avatar-source-custom"]').trigger('click');
		await wrapper.get('[data-test="save-avatar"]').trigger('click');
		await flushPromises();

		expect(wrapper.get('[data-test="avatar-error"]').text()).toBe('选择自定义头像来源时必须填写头像地址');
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('保存默认源时提交归一化后的两个键', async () => {
		await mountPage({});
		await wrapper.get('[data-test="save-avatar"]').trigger('click');
		await flushPromises();

		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			avatar_enabled: 'true',
			avatar_source: 'default',
			avatar_custom_url: '',
		});
		expect(toastMock.success).toHaveBeenCalledWith('设置已保存');
	});

	it('保存自定义模板时 trim 后提交', async () => {
		await mountPage({
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/{hash}',
		});
		await wrapper.get('[data-test="avatar-custom-url"]').setValue('  https://cdn.example.com/{hash}.png  ');
		await wrapper.get('[data-test="save-avatar"]').trigger('click');
		await flushPromises();

		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			avatar_enabled: 'true',
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/{hash}.png',
		});
	});

	it('关闭开关后保存 avatar_enabled=false，且保留来源配置', async () => {
		await mountPage({
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/{hash}',
		});
		await wrapper.get('[data-test="avatar-enabled"]').setValue(false);
		await flushPromises();
		expect(wrapper.find('[data-test="avatar-source-list"]').exists()).toBe(false);

		await wrapper.get('[data-test="save-avatar"]').trigger('click');
		await flushPromises();

		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			avatar_enabled: 'false',
			avatar_source: 'custom',
			avatar_custom_url: 'https://cdn.example.com/{hash}',
		});
	});
});
