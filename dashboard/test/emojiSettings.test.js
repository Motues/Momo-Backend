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

const A_URL = 'https://a.example.com/owo.json';
const B_URL = 'https://b.example.com/owo.json';

const urlInput = () => wrapper.get('[data-test="emoji-cdn-url"]');
const urlError = () => wrapper.find('[data-test="emoji-url-error"]');
const sourceList = () => wrapper.get('[data-test="emoji-source-list"]');
const removeButtons = () => wrapper.findAll('[data-test="emoji-source-remove"]');
const enabledInput = () => wrapper.get('[data-test="emoji-enabled"]');
const enabledSwitch = () => enabledInput().element.parentElement.querySelector('div');
const checkResultBox = () => wrapper.find('[data-test="emoji-check-result"]');

/** 已添加的来源标签（按顺序） */
const chipTexts = () => removeButtons().map((button) => button.element.parentElement.textContent.trim());

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

/** 输入框里填一个地址并点「添加地址」 */
async function addUrl(url) {
	await urlInput().setValue(url);
	await wrapper.get('[data-test="emoji-url-add"]').trigger('click');
	await flushPromises();
}

/** 按回车添加 */
async function addUrlByEnter(url) {
	await urlInput().setValue(url);
	await urlInput().trigger('keydown.enter');
	await flushPromises();
}

/** 删掉第 index 个来源标签 */
async function removeUrl(index) {
	await removeButtons()[index].trigger('click');
	await flushPromises();
}

/** 把来源列表整成给定的地址列表（先删空，再逐个添加） */
async function setUrls(urls) {
	while (removeButtons().length > 0) {
		await removeUrl(0);
	}
	for (const url of urls) {
		await addUrl(url);
	}
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
	it('按 type=emoji 拉取，并按顺序把地址渲染成标签（输入框是 INPUT 而不是 textarea）', async () => {
		requestMock.get.mockResolvedValue(
			settingsResponse({
				emoji_enabled: 'false',
				emoji_cdn_urls: JSON.stringify([A_URL, B_URL]),
				emoji_cdn_url: 'https://legacy.example.com/owo.json',
			})
		);

		await mountPage();

		expect(requestMock.get).toHaveBeenCalledWith('/admin/settings', { params: { type: 'emoji' } });
		expect(urlInput().element.tagName).toBe('INPUT');
		expect(wrapper.find('textarea[data-test="emoji-cdn-url"]').exists()).toBe(false);
		expect(chipTexts()).toEqual([A_URL, B_URL]);
		expect(enabledInput().element.checked).toBe(false);
		// 页面不再有自定义表情包那一套 UI
		expect(wrapper.find('[data-test="add-pack"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="import-input"]').exists()).toBe(false);
	});

	it('未配置过三个键时：来源回落默认源、开关默认启用', async () => {
		await mountPage();
		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL]);
		expect(enabledInput().element.checked).toBe(true);
	});

	it('emoji_cdn_urls 缺失 / 为空时回落旧的 emoji_cdn_url', async () => {
		requestMock.get.mockResolvedValue(
			settingsResponse({ emoji_cdn_urls: '[]', emoji_cdn_url: '  https://legacy.example.com/owo.json  ' })
		);
		await mountPage();
		expect(chipTexts()).toEqual(['https://legacy.example.com/owo.json']);
	});

	it('emoji_cdn_urls 是脏值时同样回落旧键', async () => {
		requestMock.get.mockResolvedValue(
			settingsResponse({ emoji_cdn_urls: 'not json', emoji_cdn_url: 'https://legacy.example.com/owo.json' })
		);
		await mountPage();
		expect(chipTexts()).toEqual(['https://legacy.example.com/owo.json']);
	});

	it('旧键只有空白时回落默认源', async () => {
		requestMock.get.mockResolvedValue(settingsResponse({ emoji_cdn_url: '   ', emoji_enabled: '' }));
		await mountPage();
		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL]);
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
		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL]);
		expect(enabledInput().element.checked).toBe(true);
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe('启用开关（圆形滑动开关）', () => {
	it('与页面其它开关同款：sr-only peer 的 input + 圆形滑块（violet）', async () => {
		await mountPage();
		const input = enabledInput();
		expect(input.attributes('type')).toBe('checkbox');
		expect(input.classes()).toEqual(expect.arrayContaining(['sr-only', 'peer']));

		const track = enabledSwitch();
		expect(track.className).toContain('peer-checked:bg-violet-600');
		expect(track.className).toContain('peer-focus:ring-violet-300');
		expect(track.className).toContain('rounded-full');
		// 旧版的方形 checkbox 样式不应再残留
		expect(input.classes()).not.toContain('rounded');
		expect(wrapper.text()).toContain('已开启');
	});

	it('关闭后文案变为「已关闭」', async () => {
		await mountPage();
		await enabledInput().setValue(false);
		expect(wrapper.text()).toContain('已关闭');
	});
});

describe('添加来源（列表编辑器）', () => {
	it('点「添加地址」把地址加到列表末尾并清空输入框', async () => {
		await mountPage();
		await addUrl(A_URL);

		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL, A_URL]);
		expect(urlInput().element.value).toBe('');
		expect(urlError().exists()).toBe(false);
	});

	it('在输入框里按回车也能添加', async () => {
		await mountPage();
		await addUrlByEnter(A_URL);
		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL, A_URL]);
	});

	it('地址两侧空格会被 trim 掉', async () => {
		await mountPage();
		await addUrl(`   ${A_URL}   `);
		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL, A_URL]);
	});

	it('非法地址：就地提示「请输入合法的 http/https 地址」，不加入列表也不清空输入框', async () => {
		await mountPage();
		await addUrl('javascript:alert(1)');

		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL]);
		expect(urlError().text()).toBe('请输入合法的 http/https 地址');
		expect(urlInput().element.value).toBe('javascript:alert(1)');
	});

	it('重复地址（trim 后精确匹配）：提示「该地址已在列表中」', async () => {
		await mountPage();
		await addUrl(A_URL);
		await addUrl(`  ${A_URL}  `);

		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL, A_URL]);
		expect(urlError().text()).toBe('该地址已在列表中');
	});

	it('已有 5 个来源时再添加：提示「最多只能配置 5 个表情来源」', async () => {
		await mountPage();
		for (const url of [A_URL, B_URL, 'https://c.example.com/owo.json', 'https://d.example.com/owo.json']) {
			await addUrl(url);
		}
		expect(removeButtons()).toHaveLength(5);

		await addUrl('https://e.example.com/owo.json');

		expect(removeButtons()).toHaveLength(5);
		expect(urlError().text()).toBe('最多只能配置 5 个表情来源');
	});

	it('输入框为空时「添加地址」按钮禁用', async () => {
		await mountPage();
		expect(wrapper.get('[data-test="emoji-url-add"]').attributes('disabled')).toBeDefined();
		await urlInput().setValue(A_URL);
		expect(wrapper.get('[data-test="emoji-url-add"]').attributes('disabled')).toBeUndefined();
	});

	it('重新输入会清掉上一次的错误提示', async () => {
		await mountPage();
		await addUrl('javascript:alert(1)');
		expect(urlError().exists()).toBe(true);

		await urlInput().setValue(A_URL);
		await flushPromises();
		expect(urlError().exists()).toBe(false);
	});
});

describe('删除来源', () => {
	it('点标签上的 × 删除该来源', async () => {
		requestMock.get.mockResolvedValue(settingsResponse({ emoji_cdn_urls: JSON.stringify([A_URL, B_URL]) }));
		await mountPage();

		await removeUrl(0);

		expect(chipTexts()).toEqual([B_URL]);
	});

	it('可以删空：列表变空后显示占位文案', async () => {
		await mountPage();
		await removeUrl(0);

		expect(removeButtons()).toHaveLength(0);
		expect(sourceList().text()).toContain('未添加表情来源（将使用默认源）');
	});
});

describe('校验格式（在线，多来源）', () => {
	it('单条合法 owo.json → 绿色「校验通过：1 个来源 / 2 个标签 / 3 个表情」', async () => {
		await mountPage();
		await clickCheck();

		const box = checkResultBox();
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain('校验通过：1 个来源 / 2 个标签 / 3 个表情');
		expect(box.classes()).toContain('text-emerald-700');
		expect(fetchMock).toHaveBeenCalledWith(DEFAULT_EMOJI_CDN_URL, expect.anything());
		expect(requestMock.put).not.toHaveBeenCalled();
	});

	it('多条全部通过 → 逐条拉取并把各来源的标签/表情数相加', async () => {
		await mountPage();
		await setUrls([A_URL, B_URL]);
		await clickCheck();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([A_URL, B_URL]);
		const box = checkResultBox();
		expect(box.text()).toContain('校验通过：2 个来源 / 4 个标签 / 6 个表情');
		expect(box.classes()).toContain('text-emerald-700');
	});

	it('某条拉取成功但不是 owo.json → 红色「第 k 条：原因」', async () => {
		stubFetch(async (url) => (url === B_URL ? jsonResponse({ hello: 'world' }) : jsonResponse(OWO_OK)));
		await mountPage();
		await setUrls([A_URL, B_URL]);
		await clickCheck();

		const box = checkResultBox();
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain('第 2 条：标签「hello」不是对象');
		expect(box.classes()).toContain('text-red-600');
	});

	it('不是合法 JSON → 红色', async () => {
		stubFetch(async () => jsonResponse('<html>nope</html>'));
		await mountPage();
		await clickCheck();
		expect(checkResultBox().text()).toContain('JSON');
		expect(checkResultBox().classes()).toContain('text-red-600');
	});

	it('网络 / 跨域失败 → 琥珀色「第 k 条无法在线校验……仍可保存」', async () => {
		stubFetch(async () => {
			throw new TypeError('Failed to fetch');
		});
		await mountPage();
		await clickCheck();

		const box = checkResultBox();
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain('第 1 条无法在线校验（可能被跨域限制拦截），仍可保存');
		expect(box.classes()).toContain('text-amber-700');
	});

	it('非 2xx 也算「无法在线校验」', async () => {
		stubFetch(async () => jsonResponse('oops', 500));
		await mountPage();
		await clickCheck();
		expect(checkResultBox().text()).toContain('仍可保存');
	});

	it('列表为空时不发请求，提示先填地址', async () => {
		await mountPage();
		await removeUrl(0);
		await clickCheck();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(checkResultBox().exists()).toBe(false);
		expect(toastMock.error).toHaveBeenCalledWith('请先填写表情来源地址');
	});
});

describe('保存', () => {
	it('提交 emoji_enabled、emoji_cdn_urls 与旧键 emoji_cdn_url（= 第一个地址）', async () => {
		requestMock.get.mockResolvedValue(
			settingsResponse({ emoji_enabled: ' TRUE ', emoji_cdn_urls: `  ["  ${A_URL}  ", "", "${B_URL}"]  ` })
		);
		await mountPage();

		await clickSave();

		expect(requestMock.put).toHaveBeenCalledTimes(1);
		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			emoji_enabled: 'true',
			emoji_cdn_urls: JSON.stringify([A_URL, B_URL]),
			emoji_cdn_url: A_URL,
		});
		expect(toastMock.success).toHaveBeenCalledWith('设置已保存');
		expect(wrapper.text()).toContain('保存成功');
	});

	it('新增来源后保存的是完整列表，旧键取第一个地址', async () => {
		await mountPage();
		await addUrl(A_URL);
		await clickSave();

		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			emoji_enabled: 'true',
			emoji_cdn_urls: JSON.stringify([DEFAULT_EMOJI_CDN_URL, A_URL]),
			emoji_cdn_url: DEFAULT_EMOJI_CDN_URL,
		});
	});

	it('开关关闭时仍提交地址（关闭不等于清空配置）', async () => {
		requestMock.get.mockResolvedValue(settingsResponse({ emoji_enabled: 'true' }));
		await mountPage();

		await enabledInput().setValue(false);
		await clickSave();

		expect(requestMock.put).toHaveBeenCalledWith('/admin/settings', {
			emoji_enabled: 'false',
			emoji_cdn_urls: JSON.stringify([DEFAULT_EMOJI_CDN_URL]),
			emoji_cdn_url: DEFAULT_EMOJI_CDN_URL,
		});
	});

	it('列表被删空时阻止保存并提示用启用开关', async () => {
		await mountPage();
		await removeUrl(0);

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
			emoji_cdn_urls: JSON.stringify([DEFAULT_EMOJI_CDN_URL]),
			emoji_cdn_url: DEFAULT_EMOJI_CDN_URL,
		});
	});

	it('未校验（没有校验结果）时照常允许保存', async () => {
		await mountPage();
		await clickSave();
		expect(requestMock.put).toHaveBeenCalledTimes(1);
	});

	it('后端报错时提示失败但不伪造成功', async () => {
		requestMock.put.mockRejectedValue(new Error('emoji_cdn_urls 只允许 http/https 地址'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await mountPage();

		await clickSave();

		expect(errorSpy).toHaveBeenCalled();
		expect(toastMock.success).not.toHaveBeenCalled();
	});
});

describe('恢复默认与校验结果失效', () => {
	it('「恢复默认」把列表填回单个 DEFAULT_EMOJI_CDN_URL', async () => {
		await mountPage();
		await setUrls([A_URL, B_URL]);
		await wrapper.get('[data-test="emoji-reset-url"]').trigger('click');
		await flushPromises();

		expect(chipTexts()).toEqual([DEFAULT_EMOJI_CDN_URL]);
	});

	it('新增来源会清掉上一次的校验结果', async () => {
		await mountPage();
		await clickCheck();
		expect(checkResultBox().exists()).toBe(true);

		await addUrl(A_URL);
		expect(checkResultBox().exists()).toBe(false);
	});

	it('删除来源也会清掉上一次的校验结果', async () => {
		await mountPage();
		await clickCheck();
		expect(checkResultBox().exists()).toBe(true);

		await removeUrl(0);
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
