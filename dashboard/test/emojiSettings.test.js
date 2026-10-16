import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

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

import EmojiSettings from '../src/views/EmojiSettings.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';
import { DEFAULT_EMOJI_CDN_URL } from '../src/utils/emoji.js';

let router;
let wrapper;

async function mountPage() {
	router = await createTestRouter('/settings/emoji');
	wrapper = mount(EmojiSettings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	await flushPromises();
	return wrapper;
}

/** 设置列表接口的响应 */
const settingsResponse = (data) => ({ code: 200, message: 'Settings fetched', data });

/** 假的 fetch 响应（组件里的在线校验走 globalThis.fetch） */
const jsonResponse = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const OWO_OK = {
	颜文字: { type: 'emoticon', container: [{ icon: 'OωO' }, { icon: '(๑•̀ㅂ•́)و✧' }] },
	Emoji: { type: 'emoji', container: [{ icon: '😂' }] },
};

const urlInput = () => wrapper.get('[data-test="emoji-cdn-url"]');
const enabledInput = () => wrapper.get('[data-test="emoji-enabled"]');
const checkResultBox = () => wrapper.find('[data-test="emoji-check-result"]');

/** 组件里的在线校验走 globalThis.fetch，这里统一留一个可断言的替身 */
let fetchMock;
function stubFetch(impl) {
	fetchMock = vi.fn(impl);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

async function clickCheck() {
	await wrapper.get('[data-test="emoji-check"]').trigger('click');
	await flushPromises();
}

async function clickSave() {
	await wrapper.get('[data-test="save-emoji"]').trigger('click');
	await flushPromises();
}

beforeEach(() => {
	localStorage.clear();
	Object.values(requestMock).forEach((fn) => fn.mockClear());
	Object.values(toastMock).forEach((fn) => fn.mockClear());
	requestMock.get.mockResolvedValue(settingsResponse({}));
	requestMock.put.mockResolvedValue({ code: 200, message: 'ok' });
	stubFetch(async () => jsonResponse(OWO_OK));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('加载设置', () => {
	it('按 type=emoji 拉取，并渲染开关与地址', async () => {
		requestMock.get.mockResolvedValue(
			settingsResponse({
				emoji_enabled: 'false',
				emoji_cdn_url: 'https://cdn.example.com/owo.json?group=Emoji',
			})
		);

		await mountPage();

		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'emoji' } });
		expect(urlInput().element.value).toBe('https://cdn.example.com/owo.json?group=Emoji');
		expect(enabledInput().element.checked).toBe(false);
		// 页面不再有自定义表情包那一套 UI
		expect(wrapper.find('[data-test="add-pack"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="import-input"]').exists()).toBe(false);
	});

	it('未配置过两个键时：地址回落默认源、开关默认启用', async () => {
		await mountPage();
		expect(urlInput().element.value).toBe(DEFAULT_EMOJI_CDN_URL);
		expect(enabledInput().element.checked).toBe(true);
	});

	it('地址只有空白时同样回落默认源', async () => {
		requestMock.get.mockResolvedValue(settingsResponse({ emoji_cdn_url: '   ', emoji_enabled: '' }));
		await mountPage();
		expect(urlInput().element.value).toBe(DEFAULT_EMOJI_CDN_URL);
		expect(enabledInput().element.checked).toBe(true);
	});

	it('历史脏值 FALSE 判为关闭，无法识别的值 fail-open 为启用', async () => {
		requestMock.get.mockResolvedValue(settingsResponse({ emoji_enabled: 'FALSE' }));
		await mountPage();
		expect(enabledInput().element.checked).toBe(false);

		wrapper.unmount();
		requestMock.get.mockResolvedValue(settingsResponse({ emoji_enabled: 'yes' }));
		await mountPage();
		expect(enabledInput().element.checked).toBe(true);
	});

	it('接口失败时仍渲染页面骨架', async () => {
		requestMock.get.mockRejectedValue(new Error('network'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await mountPage();
		expect(urlInput().element.value).toBe(DEFAULT_EMOJI_CDN_URL);
		expect(enabledInput().element.checked).toBe(true);
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe('校验格式（在线）', () => {
	it('合法 owo.json → 绿色「校验通过：N 个标签 / M 个表情」', async () => {
		await mountPage();
		await clickCheck();

		const box = checkResultBox();
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain('校验通过：2 个标签 / 3 个表情');
		expect(box.classes()).toContain('text-emerald-700');
		expect(fetchMock).toHaveBeenCalledWith(DEFAULT_EMOJI_CDN_URL, expect.anything());
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('拉取成功但不是 owo.json → 红色显示原因', async () => {
		stubFetch(async () => jsonResponse({ hello: 'world' }));
		await mountPage();
		await clickCheck();

		const box = checkResultBox();
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain('标签「hello」不是对象');
		expect(box.classes()).toContain('text-red-600');
	});

	it('不是合法 JSON → 红色', async () => {
		stubFetch(async () => jsonResponse('<html>nope</html>'));
		await mountPage();
		await clickCheck();
		expect(checkResultBox().text()).toContain('JSON');
		expect(checkResultBox().classes()).toContain('text-red-600');
	});

	it('网络 / 跨域失败 → 琥珀色「仍可保存」', async () => {
		stubFetch(async () => {
			throw new TypeError('Failed to fetch');
		});
		await mountPage();
		await clickCheck();

		const box = checkResultBox();
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain('无法在线校验（可能被跨域限制拦截），仍可保存');
		expect(box.classes()).toContain('text-amber-700');
	});

	it('非 2xx 也算「无法在线校验」', async () => {
		stubFetch(async () => jsonResponse('oops', 500));
		await mountPage();
		await clickCheck();
		expect(checkResultBox().text()).toContain('仍可保存');
	});

	it('地址为空时不发请求，提示先填地址', async () => {
		await mountPage();
		await urlInput().setValue('');
		await clickCheck();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(checkResultBox().exists()).toBe(false);
		expect(toastMock.error).toHaveBeenCalledWith('请先填写表情来源地址');
	});
});

describe('保存', () => {
	it('提交 emoji_enabled 与 trim 后的 emoji_cdn_url 两个键', async () => {
		requestMock.get.mockResolvedValue(
			settingsResponse({ emoji_enabled: ' TRUE ', emoji_cdn_url: '  https://cdn.example.com/owo.json  ' })
		);
		await mountPage();

		await clickSave();

		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			emoji_enabled: 'true',
			emoji_cdn_url: 'https://cdn.example.com/owo.json',
		});
		expect(toastMock.success).toHaveBeenCalledWith('设置已保存');
		expect(wrapper.text()).toContain('保存成功');
	});

	it('开关关闭时仍提交地址（关闭不等于清空配置）', async () => {
		requestMock.get.mockResolvedValue(settingsResponse({ emoji_enabled: 'true' }));
		await mountPage();

		await enabledInput().setValue(false);
		await clickSave();

		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			emoji_enabled: 'false',
			emoji_cdn_url: DEFAULT_EMOJI_CDN_URL,
		});
	});

	it('非法地址阻止保存', async () => {
		await mountPage();
		await urlInput().setValue('javascript:alert(1)');
		expect(wrapper.get('[data-test="cdn-error"]').exists()).toBe(true);

		await clickSave();

		expect(requestMock.put).not.toHaveBeenCalled();
		expect(toastMock.error).toHaveBeenCalledWith('只允许 http/https 地址');
	});

	it('地址为空阻止保存并提示用启用开关', async () => {
		await mountPage();
		await urlInput().setValue('   ');

		await clickSave();

		expect(requestMock.put).not.toHaveBeenCalled();
		expect(toastMock.error).toHaveBeenCalledWith('表情来源不能为空，如需关闭请用上方的启用开关');
	});

	it('校验结果是 invalid 时保存被阻止；重新校验通过后可保存', async () => {
		stubFetch(async () => jsonResponse([{ icon: '😂' }]));
		await mountPage();
		await clickCheck();

		await clickSave();
		expect(requestMock.put).not.toHaveBeenCalled();
		expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('顶层'));

		// 地址没变，重新校验（这次是合法的 owo.json）
		stubFetch(async () => jsonResponse(OWO_OK));
		await clickCheck();
		expect(checkResultBox().text()).toContain('校验通过');

		await clickSave();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
	});

	it('校验结果 unreachable（跨域被拦）时允许保存', async () => {
		stubFetch(async () => {
			throw new TypeError('Failed to fetch');
		});
		await mountPage();
		await clickCheck();
		await clickSave();

		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			emoji_enabled: 'true',
			emoji_cdn_url: DEFAULT_EMOJI_CDN_URL,
		});
	});

	it('未校验（没有校验结果）时照常允许保存', async () => {
		await mountPage();
		await clickSave();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
	});

	it('后端报错时提示失败但不伪造成功', async () => {
		requestMock.put.mockRejectedValue(new Error('emoji_cdn_url 只允许 http/https 地址'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await mountPage();

		await clickSave();

		expect(errorSpy).toHaveBeenCalled();
		expect(toastMock.success).not.toHaveBeenCalled();
	});
});

describe('恢复默认与校验结果失效', () => {
	it('「恢复默认」把地址填回 DEFAULT_EMOJI_CDN_URL', async () => {
		await mountPage();
		await urlInput().setValue('https://cdn.example.com/owo.json');
		await wrapper.get('[data-test="emoji-reset-url"]').trigger('click');
		expect(urlInput().element.value).toBe(DEFAULT_EMOJI_CDN_URL);
	});

	it('改地址会清掉上一次的校验结果', async () => {
		await mountPage();
		await clickCheck();
		expect(checkResultBox().exists()).toBe(true);

		await urlInput().setValue('https://cdn.example.com/other.json');
		await flushPromises();
		expect(checkResultBox().exists()).toBe(false);
	});

	it('切换启用开关也会清掉上一次的校验结果', async () => {
		await mountPage();
		await clickCheck();
		expect(checkResultBox().exists()).toBe(true);

		await enabledInput().setValue(false);
		await flushPromises();
		expect(checkResultBox().exists()).toBe(false);
	});

	it('重新加载设置后校验结果也被清掉', async () => {
		await mountPage();
		await clickCheck();
		expect(checkResultBox().exists()).toBe(true);

		await wrapper.getComponent(AdminLayoutStub).vm.$emit('refresh');
		await flushPromises();
		expect(checkResultBox().exists()).toBe(false);
	});
});

describe('路由与入口', () => {
	it('设置页里有表情设置入口卡片', async () => {
		const Settings = (await import('../src/views/Settings.vue')).default;
		const settingsRouter = await createTestRouter('/settings');
		const settingsWrapper = mount(Settings, {
			global: { plugins: [settingsRouter], stubs: { AdminLayout: AdminLayoutStub } },
		});
		const link = settingsWrapper.findAll('a').find((a) => a.attributes('href') === '/settings/emoji');
		expect(link).toBeTruthy();
		expect(link.text()).toContain('表情设置');
		expect(link.text()).toContain('OwO');
		expect(link.text()).not.toContain('上传');
	});

	it('后端路由表里注册了 /settings/emoji', async () => {
		const { default: appRouter } = await import('../src/router/index.js');
		const route = appRouter.getRoutes().find((item) => item.path === '/settings/emoji');
		expect(route).toBeTruthy();
		expect(route.name).toBe('EmojiSettings');
		expect(route.meta.requiresAuth).toBe(true);
	});
});
