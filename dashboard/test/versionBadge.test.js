import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

/* AdminLayout 会用到 request（退出登录），这里替换掉以免拉进 axios 与路由跳转 */
vi.mock('../src/utils/request.js', () => ({
	default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

import {
	APP_VERSION,
	CACHE_KEY,
	CACHE_TTL_MS,
	FALLBACK_LATEST_VERSION_URL,
	GITHUB_LATEST_RELEASE_URL,
	RELEASE_PAGE_URL,
	compareVersions,
	fetchLatestVersion,
	isCacheFresh,
	isNewerVersion,
	normalizeVersion,
	parseVersion,
	readCache,
	writeCache,
} from '../src/utils/version.js';
import { useVersionCheck } from '../src/composables/useVersionCheck.js';
import VersionBadge from '../src/components/VersionBadge.vue';
import AdminLayout from '../src/components/AdminLayout.vue';

/** 由当前版本派生「更新 / 更旧」的版本号，避免版本号变更后这些用例失效 */
function bumpPatch(version, delta) {
	const [major, minor, patch] = String(version).split('-')[0].split('.').map(Number);
	const next = Math.max(0, patch + delta);
	const bumped = `${major}.${minor}.${next}`;
	return delta > 0 ? bumped : `${major}.${minor}.${Math.max(0, next)}`;
}
const NEWER_VERSION = bumpPatch(APP_VERSION, 1);
const SAME_VERSION = String(APP_VERSION).split('-')[0];
const OLDER_VERSION = bumpPatch(APP_VERSION, -1);

/** 构造 fetch 替身：按 URL 分派，未登记的 URL 直接失败（暴露意外的请求） */
function mockFetch(routes = {}) {
	const calls = [];
	const impl = vi.fn(async (url, init) => {
		calls.push({ url, init });
		const route = routes[url];
		if (route === undefined) throw new Error(`未预期的请求：${url}`);
		return typeof route === 'function' ? route(url, init) : route;
	});
	impl.calls = calls;
	return impl;
}

const jsonResponse = (body, init = {}) => ({
	ok: true,
	status: 200,
	json: async () => body,
	...init,
});

const githubOk = (tag, htmlUrl = 'https://github.com/Motues/Momo-Backend/releases/tag/' + tag) =>
	jsonResponse({ tag_name: tag, html_url: htmlUrl });

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('版本号解析与比较', () => {
	it('解析 1.6.1 / v1.6.1 / 1.6 / 预发布', () => {
		expect(parseVersion('1.6.1')).toEqual({ major: 1, minor: 6, patch: 1, pre: '' });
		expect(parseVersion(' v1.6.1 ')).toEqual({ major: 1, minor: 6, patch: 1, pre: '' });
		expect(parseVersion('1.6')).toEqual({ major: 1, minor: 6, patch: 0, pre: '' });
		expect(parseVersion('1.6.1-beta.2')).toEqual({
			major: 1,
			minor: 6,
			patch: 1,
			pre: 'beta.2',
		});
	});

	it('无法解析的输入返回 null / 空串', () => {
		expect(parseVersion('latest')).toBeNull();
		expect(parseVersion('')).toBeNull();
		expect(parseVersion(null)).toBeNull();
		expect(normalizeVersion('latest')).toBe('');
	});

	it('归一化会补全缺失的段', () => {
		expect(normalizeVersion('v1.6')).toBe('1.6.0');
		expect(normalizeVersion('1.6.1-beta.2')).toBe('1.6.1-beta.2');
	});

	it('按数值比较而不是字典序', () => {
		expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
		expect(compareVersions('1.9.9', '1.10.0')).toBe(-1);
		expect(compareVersions('v1.6.1', '1.6.1')).toBe(0);
		expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
	});

	it('预发布版本小于同号正式版', () => {
		expect(compareVersions('1.6.1-beta', '1.6.1')).toBe(-1);
		expect(compareVersions('1.6.1', '1.6.1-beta')).toBe(1);
	});

	it('isNewerVersion 在 latest 非法时不误报', () => {
		expect(isNewerVersion('1.6.2', '1.6.1')).toBe(true);
		expect(isNewerVersion('1.6.1', '1.6.1')).toBe(false);
		expect(isNewerVersion('1.6.0', '1.6.1')).toBe(false);
		expect(isNewerVersion('', '1.6.1')).toBe(false);
		expect(isNewerVersion(undefined, '1.6.1')).toBe(false);
	});
});

describe('检查结果缓存', () => {
	it('正常写入与读取', () => {
		const entry = { latest: '1.6.2', url: 'u', source: 'github', checkedAt: 1000 };
		expect(writeCache(entry, localStorage)).toBe(true);
		expect(readCache(localStorage)).toEqual(entry);
	});

	it('内容损坏或结构不对时返回 null', () => {
		localStorage.setItem(CACHE_KEY, 'not-json');
		expect(readCache(localStorage)).toBeNull();
		localStorage.setItem(CACHE_KEY, JSON.stringify({ latest: 1, checkedAt: 'x' }));
		expect(readCache(localStorage)).toBeNull();
	});

	it('存储不可用时静默失败（不能因此抛错）', () => {
		const broken = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			},
		};
		expect(readCache(broken)).toBeNull();
		expect(writeCache({ latest: '1.0.0', checkedAt: 1 }, broken)).toBe(false);
	});

	it('TTL 判定：有效期内为 true，过期与未来时间戳为 false', () => {
		const now = 10_000_000;
		expect(isCacheFresh({ checkedAt: now - CACHE_TTL_MS + 1 }, now)).toBe(true);
		expect(isCacheFresh({ checkedAt: now - CACHE_TTL_MS }, now)).toBe(false);
		expect(isCacheFresh({ checkedAt: now + 1 }, now)).toBe(false);
		expect(isCacheFresh(null, now)).toBe(false);
	});
});

describe('fetchLatestVersion', () => {
	it('优先 GitHub Releases', async () => {
		const fetchImpl = mockFetch({ [GITHUB_LATEST_RELEASE_URL]: githubOk('v1.6.2') });
		const result = await fetchLatestVersion({ fetchImpl });
		expect(result).toEqual({
			version: '1.6.2',
			url: 'https://github.com/Motues/Momo-Backend/releases/tag/v1.6.2',
			source: 'github',
		});
		expect(fetchImpl.calls).toHaveLength(1);
	});

	it('GitHub 失败时回退 jsDelivr/npm', async () => {
		const fetchImpl = mockFetch({
			[GITHUB_LATEST_RELEASE_URL]: () => Promise.reject(new Error('network')),
			[FALLBACK_LATEST_VERSION_URL]: jsonResponse({ version: '1.6.2' }),
		});
		const result = await fetchLatestVersion({ fetchImpl });
		expect(result.version).toBe('1.6.2');
		expect(result.source).toBe('jsdelivr');
		expect(result.url).toBe(RELEASE_PAGE_URL);
	});

	it('HTTP 非 200 或缺少版本号都视为该源失败', async () => {
		const fetchImpl = mockFetch({
			[GITHUB_LATEST_RELEASE_URL]: jsonResponse({}, { ok: false, status: 503 }),
			[FALLBACK_LATEST_VERSION_URL]: jsonResponse({ version: '1.6.2' }),
		});
		const result = await fetchLatestVersion({ fetchImpl });
		expect(result.source).toBe('jsdelivr');

		const missing = mockFetch({
			[GITHUB_LATEST_RELEASE_URL]: jsonResponse({ name: 'no version field' }),
			[FALLBACK_LATEST_VERSION_URL]: jsonResponse({ version: '1.6.2' }),
		});
		expect((await fetchLatestVersion({ fetchImpl: missing })).source).toBe('jsdelivr');
	});

	it('两个源都失败时抛出错误', async () => {
		const fetchImpl = mockFetch({
			[GITHUB_LATEST_RELEASE_URL]: () => Promise.reject(new Error('a')),
			[FALLBACK_LATEST_VERSION_URL]: () => Promise.reject(new Error('b')),
		});
		await expect(fetchLatestVersion({ fetchImpl })).rejects.toThrow('b');
	});

	it('超时会被 AbortController 打断，不会一直挂着', async () => {
		vi.useFakeTimers();
		const hanging = (url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener('abort', () => reject(new Error('aborted')));
			});
		// 立刻挂上 catch，避免断言建立前产生 unhandled rejection
		const settled = fetchLatestVersion({ fetchImpl: hanging, timeoutMs: 50 }).catch((e) => e);
		for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(50);
		const error = await settled;
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain('aborted');
	});
});

describe('useVersionCheck', () => {
	const createStorage = () => {
		const map = new Map();
		return {
			getItem: (k) => (map.has(k) ? map.get(k) : null),
			setItem: (k, v) => map.set(k, String(v)),
			removeItem: (k) => map.delete(k),
		};
	};

	it('命中有效缓存时不发请求', async () => {
		const storage = createStorage();
		const now = 1_000_000;
		storage.setItem(CACHE_KEY, JSON.stringify({ latest: '1.6.2', checkedAt: now, source: 'github' }));
		const fetcher = vi.fn();
		const state = useVersionCheck({ current: '1.6.1', storage, fetcher, now: () => now });

		await state.check();
		expect(fetcher).not.toHaveBeenCalled();
		expect(state.hasUpdate.value).toBe(true);
		expect(state.latestVersion.value).toBe('1.6.2');
	});

	it('缓存过期后重新请求并刷新缓存', async () => {
		const storage = createStorage();
		const now = 1_000_000;
		storage.setItem(
			CACHE_KEY,
			JSON.stringify({ latest: '1.6.2', checkedAt: now - CACHE_TTL_MS, source: 'github' })
		);
		const fetcher = vi.fn(async () => ({ version: '1.6.3', url: 'u', source: 'github' }));
		const state = useVersionCheck({ current: '1.6.1', storage, fetcher, now: () => now });

		await state.check();
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(state.latestVersion.value).toBe('1.6.3');
		expect(JSON.parse(storage.getItem(CACHE_KEY)).latest).toBe('1.6.3');
	});

	it('force 忽略缓存', async () => {
		const storage = createStorage();
		const now = 1_000_000;
		storage.setItem(CACHE_KEY, JSON.stringify({ latest: '1.6.2', checkedAt: now }));
		const fetcher = vi.fn(async () => ({ version: '1.6.1', url: 'u', source: 'github' }));
		const state = useVersionCheck({ current: '1.6.1', storage, fetcher, now: () => now });

		await state.check({ force: true });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(state.hasUpdate.value).toBe(false);
	});

	it('请求失败时沿用旧缓存结论并记录错误', async () => {
		const storage = createStorage();
		const now = 1_000_000;
		storage.setItem(
			CACHE_KEY,
			JSON.stringify({ latest: '1.6.9', checkedAt: now - CACHE_TTL_MS - 1 })
		);
		const state = useVersionCheck({
			current: '1.6.1',
			storage,
			fetcher: async () => {
				throw new Error('offline');
			},
			now: () => now,
		});

		await state.check();
		expect(state.error.value).toBe('offline');
		expect(state.hasUpdate.value).toBe(true);
		expect(state.latestVersion.value).toBe('1.6.9');
	});

	it('并发调用只发一次请求', async () => {
		let release;
		const fetcher = vi.fn(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ version: '1.6.2', url: 'u', source: 'github' });
				})
		);
		const state = useVersionCheck({ current: '1.6.1', storage: createStorage(), fetcher });
		const first = state.check();
		const second = state.check();
		release();
		await Promise.all([first, second]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

describe('VersionBadge 组件', () => {
	const mountBadge = (props = {}) => mount(VersionBadge, { props });

	it('渲染当前版本号（来自 package.json 注入）', async () => {
		vi.stubGlobal('fetch', mockFetch({}));
		const wrapper = mountBadge({ autoCheck: false });
		expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
		expect(wrapper.get('[data-test="version-badge"]').text()).toContain(`v${APP_VERSION}`);
		expect(wrapper.find('[data-test="version-update-emoji"]').exists()).toBe(false);
	});

	it('挂载后自动检查，发现新版本显示小表情与提示链接', async () => {
		vi.stubGlobal('fetch', mockFetch({ [GITHUB_LATEST_RELEASE_URL]: githubOk(`v${NEWER_VERSION}`) }));
		const wrapper = mountBadge();
		await flushPromises();

		expect(wrapper.find('[data-test="version-update-emoji"]').exists()).toBe(true);
		const link = wrapper.get('[data-test="version-update-link"]');
		expect(link.text()).toContain(`v${NEWER_VERSION}`);
		expect(link.attributes('href')).toContain(`/releases/tag/v${NEWER_VERSION}`);
		expect(link.attributes('target')).toBe('_blank');
	});

	it('已是最新时不显示表情与链接', async () => {
		vi.stubGlobal('fetch', mockFetch({ [GITHUB_LATEST_RELEASE_URL]: githubOk(`v${SAME_VERSION}`) }));
		const wrapper = mountBadge();
		await flushPromises();
		expect(wrapper.find('[data-test="version-update-emoji"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="version-update-link"]').exists()).toBe(false);
	});

	it('拿到更旧的版本号同样不算有更新', async () => {
		vi.stubGlobal('fetch', mockFetch({ [GITHUB_LATEST_RELEASE_URL]: githubOk(`v${OLDER_VERSION}`) }));
		const wrapper = mountBadge();
		await flushPromises();
		expect(wrapper.find('[data-test="version-update-emoji"]').exists()).toBe(false);
	});

	it('两个源都失败时给出可重试提示，且不影响版本号显示', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline');
			})
		);
		const wrapper = mountBadge();
		await flushPromises();
		expect(wrapper.find('[data-test="version-error"]').exists()).toBe(true);
		expect(wrapper.get('[data-test="version-badge"]').text()).toContain(`v${APP_VERSION}`);
	});

	it('命中缓存时不请求，直接显示新版表情', async () => {
		localStorage.setItem(
			CACHE_KEY,
			JSON.stringify({
				latest: NEWER_VERSION,
				url: RELEASE_PAGE_URL,
				source: 'github',
				checkedAt: Date.now(),
			})
		);
		const fetchImpl = mockFetch({});
		vi.stubGlobal('fetch', fetchImpl);
		const wrapper = mountBadge();
		await flushPromises();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(wrapper.find('[data-test="version-update-emoji"]').exists()).toBe(true);
	});

	it('有新版时点击版本号打开 Release 页', async () => {
		vi.stubGlobal('fetch', mockFetch({ [GITHUB_LATEST_RELEASE_URL]: githubOk(`v${NEWER_VERSION}`) }));
		const openSpy = vi.fn();
		vi.stubGlobal('open', openSpy);
		const wrapper = mountBadge();
		await flushPromises();

		await wrapper.get('[data-test="version-badge"]').trigger('click');
		expect(openSpy).toHaveBeenCalledWith(
			`https://github.com/Motues/Momo-Backend/releases/tag/v${NEWER_VERSION}`,
			'_blank',
			'noopener'
		);
	});

	it('无新版时点击版本号强制重新检查', async () => {
		const fetchImpl = mockFetch({ [GITHUB_LATEST_RELEASE_URL]: githubOk(`v${SAME_VERSION}`) });
		vi.stubGlobal('fetch', fetchImpl);
		const wrapper = mountBadge();
		await flushPromises();
		expect(fetchImpl.calls).toHaveLength(1);

		await wrapper.get('[data-test="version-badge"]').trigger('click');
		await flushPromises();
		expect(fetchImpl.calls).toHaveLength(2);
	});
});

describe('AdminLayout 侧边栏底部', () => {
	it('把版本号徽标渲染在侧边栏最下方', async () => {
		vi.stubGlobal('fetch', mockFetch({ [GITHUB_LATEST_RELEASE_URL]: githubOk(`v${NEWER_VERSION}`) }));
		const router = createRouter({
			history: createMemoryHistory(),
			// 侧边栏的 router-link 指向这些路径，登记为占位路由以免产生告警
			routes: ['/', '/comments', '/users', '/verify-records', '/settings'].map((path) => ({
				path,
				component: { template: '<div />' },
			})),
		});
		await router.push('/');
		await router.isReady();

		const wrapper = mount(AdminLayout, {
			props: { baseUrl: 'https://api.example.com' },
			global: { plugins: [router] },
		});
		await flushPromises();

		const badge = wrapper.findComponent(VersionBadge);
		expect(badge.exists()).toBe(true);
		// 徽标之后只剩 "Powered by Momo-Backend"，即它位于侧边栏底部区域
		const footer = badge.element.closest('aside > div:last-child');
		expect(footer).not.toBeNull();
		expect(footer.textContent).toContain('Powered by Momo-Backend');
		expect(footer.textContent).toContain(`v${APP_VERSION}`);
		expect(footer.textContent).toContain(`v${NEWER_VERSION}`);
	});
});
