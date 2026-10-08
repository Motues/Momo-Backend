/**
 * 测试公共工具（非测试文件，不会被 vitest 收集）。
 * 仅提供内存路由、AdminLayout 占位组件等挂载辅助，不涉及任何生产代码逻辑。
 */
import { createRouter, createMemoryHistory } from 'vue-router';
import { defineComponent, h } from 'vue';

/** 渲染默认插槽的 AdminLayout 占位组件，避免真实布局依赖 useRoute/DOM */
export const AdminLayoutStub = defineComponent({
	name: 'AdminLayout',
	props: { baseUrl: { type: String, default: '' } },
	emits: ['logout', 'refresh'],
	setup(_props, { slots }) {
		return () => h('div', { class: 'admin-layout-stub' }, slots.default ? slots.default() : []);
	},
});

/** 页面里 <router-link> 可能指向的路由，占位组件即可 */
export const DASHBOARD_ROUTES = [
	{ path: '/', name: 'home', component: { template: '<div />' } },
	{ path: '/login', name: 'login', component: { template: '<div />' } },
	{ path: '/comments', name: 'comments', component: { template: '<div />' } },
	{ path: '/users', name: 'users', component: { template: '<div />' } },
	{ path: '/user-comments', name: 'userComments', component: { template: '<div />' } },
	{ path: '/settings', name: 'settings', component: { template: '<div />' } },
	{ path: '/settings/basic', name: 'basic', component: { template: '<div />' } },
	{ path: '/settings/email', name: 'email', component: { template: '<div />' } },
	{ path: '/settings/security', name: 'security', component: { template: '<div />' } },
];

/** 创建内存路由并跳到指定路径 */
export const createTestRouter = async (initialPath = '/') => {
	const router = createRouter({ history: createMemoryHistory(), routes: DASHBOARD_ROUTES });
	await router.push(initialPath);
	await router.isReady();
	return router;
};

/** 点击文本匹配的按钮 */
export const findButtonByText = (wrapper, text) =>
	wrapper.findAll('button').find((button) => button.text().replace(/\s+/g, '') === text);

/** 生成一条评论数据 */
export const makeComment = (overrides = {}) => ({
	id: 1,
	author: '张三',
	email: 'zhangsan@example.com',
	ipAddress: '203.0.113.9',
	contentText: '这是一条测试评论',
	status: 'pending',
	pubDate: '2024-05-06T07:08:09.000Z',
	postSlug: 'hello-world',
	os: 'Windows',
	browser: 'Chrome',
	url: 'https://zhangsan.example.com',
	...overrides,
});
