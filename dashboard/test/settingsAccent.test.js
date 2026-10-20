import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * 「一个栏目一个色调」：每个设置页在**页面内部**也只能用自己卡片的那个色相
 * （Settings.vue 的入口卡片颜色见 settingsCards.test.js）。
 *
 * 判定口径：
 * 1. 每个 <section> 的 <h2> 图标都带 `text-<hue>-500`；
 * 2. 页面里所有开关的 `peer-focus:ring-<hue>-300` / `peer-checked:bg-<hue>-600` 都是本页色相；
 * 3. 输入框等控件的 `focus:ring-<hue>-500` 也是本页色相；
 * 4. 不再出现该页「改色前」的旧色相。
 *
 * 语义色（保存成功的绿色、错误/警告的红与琥珀）刻意不在断言范围内：那些不是栏目强调色。
 */

const requestMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));

vi.mock('../src/utils/request.js', () => ({ default: requestMock }));
vi.mock('../src/utils/toast.js', () => ({ default: toastMock }));

import BasicSettings from '../src/views/BasicSettings.vue';
import AccountSettings from '../src/views/AccountSettings.vue';
import EmailSettings from '../src/views/EmailSettings.vue';
import SecuritySettings from '../src/views/SecuritySettings.vue';
import LinkSecuritySettings from '../src/views/LinkSecuritySettings.vue';
import VerifySettings from '../src/views/VerifySettings.vue';
import EmojiSettings from '../src/views/EmojiSettings.vue';
import DataManagement from '../src/views/DataManagement.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

const PAGES = [
	{
		name: '基本设置',
		component: BasicSettings,
		path: '/settings/basic',
		hue: 'blue',
		forbidden: ['text-purple-500', 'peer-checked:bg-purple-600', 'bg-sky-50', 'focus:ring-purple-500'],
	},
	{
		name: '账户安全',
		component: AccountSettings,
		path: '/settings/account',
		hue: 'amber',
		forbidden: ['text-blue-500', 'focus:ring-blue-500'],
	},
	{
		name: '邮件通知',
		component: EmailSettings,
		path: '/settings/email',
		hue: 'teal',
		forbidden: ['text-blue-500', 'focus:ring-blue-500', 'peer-checked:bg-blue-600', 'peer-focus:ring-blue-300'],
	},
	{
		name: '访问控制',
		component: SecuritySettings,
		path: '/settings/security',
		hue: 'red',
		forbidden: [
			'text-orange-500',
			'bg-orange-50',
			'focus:ring-orange-500',
			'text-sky-500',
			'peer-checked:bg-sky-600',
			'focus:ring-sky-500',
		],
	},
	{
		name: '链接安全',
		component: LinkSecuritySettings,
		path: '/settings/link',
		hue: 'sky',
		forbidden: ['peer-checked:bg-blue-600', 'peer-focus:ring-blue-300', 'focus:ring-blue-500'],
	},
	{
		name: '人机验证',
		component: VerifySettings,
		path: '/settings/verify',
		hue: 'indigo',
		forbidden: [
			'text-emerald-500',
			'peer-checked:bg-emerald-600',
			'peer-focus:ring-emerald-300',
			'focus:ring-emerald-500',
		],
	},
	{
		name: '表情设置',
		component: EmojiSettings,
		path: '/settings/emoji',
		hue: 'violet',
		forbidden: ['text-emerald-500', 'text-blue-500', 'focus:ring-blue-500', 'peer-checked:bg-blue-600'],
	},
	{
		name: '数据管理',
		component: DataManagement,
		path: '/settings/data',
		hue: 'emerald',
		forbidden: ['bg-sky-500', 'hover:bg-sky-600'],
	},
];

const matches = (html, pattern) => [...html.matchAll(pattern)].map((match) => match[1]);

let wrapper;

beforeEach(() => {
	localStorage.clear();
	requestMock.get.mockResolvedValue({ code: 200, data: {} });
	requestMock.put.mockResolvedValue({ code: 200, message: 'ok' });
});

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
});

describe.each(PAGES)('$name - 页面内部统一色调（$hue）', ({ component, path, hue, forbidden }) => {
	const mountPage = async () => {
		const router = await createTestRouter(path);
		wrapper = mount(component, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();
		return wrapper;
	};

	it('每个 section 的 <h2> 图标都用本页色调', async () => {
		await mountPage();
		const icons = wrapper.findAll('h2 i');
		expect(icons.length).toBeGreaterThan(0);
		icons.forEach((icon) => expect(icon.classes()).toContain(`text-${hue}-500`));
	});

	it('开关（滑块轨道）用本页色调', async () => {
		await mountPage();
		const html = wrapper.html();
		matches(html, /peer-focus:ring-([a-z]+)-\d+/g).forEach((color) => expect(color).toBe(hue));
		matches(html, /peer-checked:bg-([a-z]+)-\d+/g).forEach((color) => expect(color).toBe(hue));
	});

	it('输入控件的焦点环用本页色调', async () => {
		await mountPage();
		// 排除 peer-focus:ring-*（上面单独断言）；SelectMenu 的 accent 也走同一套 ring
		const rings = matches(wrapper.html(), /(?<!peer-)focus:ring-([a-z]+)-\d+/g).filter((color) => color !== 'gray');
		rings.forEach((color) => expect(color).toBe(hue));
	});

	it('不再残留改色前的旧色相', async () => {
		await mountPage();
		const html = wrapper.html();
		forbidden.forEach((className) => expect(html).not.toContain(className));
	});
});

describe('栏目专属的 chips / 按钮', () => {
	it('基本设置的「管理员邮箱」chips 与「添加邮箱」按钮是蓝色（原本是 sky）', async () => {
		requestMock.get.mockResolvedValue({
			code: 200,
			data: { admin_emails: '["admin@example.com"]', notify_email: 'admin@example.com' },
		});
		const router = await createTestRouter('/settings/basic');
		wrapper = mount(BasicSettings, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();

		const chip = wrapper.get('[data-test="admin-email-list"] span');
		expect(chip.classes()).toEqual(expect.arrayContaining(['bg-blue-50', 'text-blue-700', 'border-blue-200']));
		const addButton = wrapper.get('[data-test="admin-email-add"]');
		expect(addButton.classes()).toEqual(expect.arrayContaining(['bg-blue-50', 'text-blue-700', 'border-blue-200']));
	});

	it('表情设置的来源 chips 与「添加地址」按钮是紫色（原本是 blue）', async () => {
		const router = await createTestRouter('/settings/emoji');
		wrapper = mount(EmojiSettings, {
			global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
		});
		await flushPromises();

		const chip = wrapper.get('[data-test="emoji-source-list"] span');
		expect(chip.classes()).toEqual(expect.arrayContaining(['bg-violet-50', 'text-violet-700', 'border-violet-200']));
		const addButton = wrapper.get('[data-test="emoji-url-add"]');
		expect(addButton.classes()).toEqual(expect.arrayContaining(['bg-violet-50', 'text-violet-700']));
	});
});
