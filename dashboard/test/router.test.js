import { describe, it, expect, beforeEach } from 'vitest';
import router from '../src/router/index.js';

/** 路由表中声明的全部路由（模块未导出 routes，这里固定期望值做交叉校验） */
const EXPECTED_ROUTES = [
	{ path: '/login', name: 'Login', file: 'Login.vue', auth: false },
	{ path: '/', name: 'Stats', file: 'Stats.vue', auth: true },
	{ path: '/comments', name: 'Comments', file: 'Dashboard.vue', auth: true },
	{ path: '/users', name: 'Users', file: 'Users.vue', auth: true },
	{ path: '/user-comments', name: 'UserComments', file: 'UserComments.vue', auth: true },
	{ path: '/verify-records', name: 'VerifyRecords', file: 'VerifyRecords.vue', auth: true },
	{ path: '/settings', name: 'Settings', file: 'Settings.vue', auth: true },
	{ path: '/settings/basic', name: 'BasicSettings', file: 'BasicSettings.vue', auth: true },
	{ path: '/settings/email', name: 'EmailSettings', file: 'EmailSettings.vue', auth: true },
	{ path: '/settings/security', name: 'SecuritySettings', file: 'SecuritySettings.vue', auth: true },
	{ path: '/settings/account', name: 'AccountSettings', file: 'AccountSettings.vue', auth: true },
	{ path: '/settings/data', name: 'DataManagement', file: 'DataManagement.vue', auth: true },
];

const findRecord = (path) => router.getRoutes().find((record) => record.path === path);

beforeEach(async () => {
	localStorage.clear();
	// 回到中立的登录页起点，避免「重复导航」被 vue-router 直接跳过而观察不到守卫行为
	if (router.currentRoute.value.path !== '/login') {
		await router.push('/login');
	}
});

describe('路由表结构', () => {
	it.each(EXPECTED_ROUTES)('$path → $name 已声明', ({ path, name }) => {
		const record = findRecord(path);
		expect(record).toBeTruthy();
		expect(record.name).toBe(name);
	});

	it('路由数量与预期一致（没有遗漏或多余的路由）', () => {
		const named = router.getRoutes().filter((record) => record.name);
		expect(named).toHaveLength(EXPECTED_ROUTES.length);
	});

	it('/settings/site 只有重定向、没有组件', () => {
		const record = findRecord('/settings/site');
		expect(record).toBeTruthy();
		expect(record.components?.default).toBeFalsy();
	});

	it('/settings/site 重定向到 /settings/basic', () => {
		expect(findRecord('/settings/site').redirect).toBe('/settings/basic');
	});

	it('router.resolve 不会展开记录级重定向（导航时才生效）', () => {
		expect(router.resolve('/settings/site').path).toBe('/settings/site');
	});

	it.each(EXPECTED_ROUTES.filter((route) => route.auth))('$path 标记了 requiresAuth', ({ path }) => {
		expect(findRecord(path).meta.requiresAuth).toBe(true);
	});

	it('/login 不需要鉴权', () => {
		expect(findRecord('/login').meta?.requiresAuth).toBeFalsy();
	});
});

describe('路由组件可加载（每个声明都指向真实存在的文件）', () => {
	/** Vite 的 glob 导入：既验证文件存在，也验证能被编译 */
	const viewModules = import.meta.glob('../src/views/*.vue');

	const loadView = async (file) => {
		const loader = viewModules[`../src/views/${file}`];
		expect(typeof loader).toBe('function');
		return loader();
	};

	it.each(EXPECTED_ROUTES)('$file 存在且可加载', async ({ file }) => {
		const mod = await loadView(file);
		expect(mod.default).toBeTruthy();
	});

	it('路由表里没有引用不存在的视图文件', () => {
		const known = Object.keys(viewModules).map((key) => key.replace('../src/views/', ''));
		EXPECTED_ROUTES.forEach((route) => expect(known).toContain(route.file));
	});

	it('每一项路由记录的组件都能解析（含已被导航解析过的）', async () => {
		const records = router.getRoutes().filter((record) => record.components?.default);
		expect(records).toHaveLength(EXPECTED_ROUTES.length);
		for (const record of records) {
			const component = record.components.default;
			// 已被访问过的路由，其懒加载函数会被替换成解析后的组件对象
			const resolved = typeof component === 'function' ? await component() : component;
			expect(resolved?.default ?? resolved).toBeTruthy();
		}
	});
});

describe('鉴权守卫', () => {
	it('未登录访问 "/" 会跳到登录页', async () => {
		await router.push('/');
		expect(router.currentRoute.value.path).toBe('/login');
	});

	it('未登录访问 /comments 会跳到登录页', async () => {
		await router.push('/comments');
		expect(router.currentRoute.value.path).toBe('/login');
	});

	it('未登录访问 /settings/security 会跳到登录页', async () => {
		await router.push('/settings/security');
		expect(router.currentRoute.value.path).toBe('/login');
	});

	it('未登录仍可停留在 /login', async () => {
		await router.push('/login');
		expect(router.currentRoute.value.path).toBe('/login');
	});

	it('已登录访问 /login 会被送回首页', async () => {
		localStorage.setItem('token', 'tk');
		await router.push('/settings');
		expect(router.currentRoute.value.path).toBe('/settings');

		await router.push('/login');
		expect(router.currentRoute.value.path).toBe('/');
	});

	it('已登录可以访问受保护路由', async () => {
		localStorage.setItem('token', 'tk');
		await router.push('/settings/basic');
		expect(router.currentRoute.value.path).toBe('/settings/basic');
		expect(router.currentRoute.value.name).toBe('BasicSettings');
	});

	it('已登录访问 /settings/site 会重定向到 /settings/basic', async () => {
		localStorage.setItem('token', 'tk');
		await router.push('/settings/site');
		expect(router.currentRoute.value.path).toBe('/settings/basic');
	});

	it('未登录访问 /settings/site 时重定向后再被守卫拦到登录页', async () => {
		await router.push('/settings/site');
		expect(router.currentRoute.value.path).toBe('/login');
	});

	it('守卫在每次导航时重新读取 token（先放行、后拦截）', async () => {
		localStorage.setItem('token', 'tk');
		await router.push('/users');
		expect(router.currentRoute.value.path).toBe('/users');

		localStorage.removeItem('token');
		await router.push('/comments');
		expect(router.currentRoute.value.path).toBe('/login');
	});

	it('空字符串 token 视为未登录', async () => {
		localStorage.setItem('token', '');
		await router.push('/users');
		expect(router.currentRoute.value.path).toBe('/login');
	});
});
