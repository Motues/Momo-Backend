import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';

import Settings from '../src/views/Settings.vue';
import { createTestRouter, AdminLayoutStub } from './support/harness.js';

/**
 * 设置页卡片的最终顺序（已与用户确认，「数据管理」固定最后）。
 * keywords 用于锁定卡片说明里的关键信息。
 */
const EXPECTED_CARDS = [
	{ href: '/settings/basic', title: '基本设置', keywords: ['站点名称', 'API 地址', '管理员邮箱', '管理员评论密钥', '评论审核', '邮箱验证', '博主标识', '占位符'] },
	{ href: '/settings/account', title: '账户安全' },
	{ href: '/settings/email', title: '邮件通知', keywords: ['SMTP'] },
	{ href: '/settings/security', title: '访问控制', keywords: ['来源白名单', 'IP', '邮箱黑名单', '真实 IP 识别'] },
	{ href: '/settings/link', title: '链接安全', keywords: ['休眠链接', '历史'] },
	{ href: '/settings/verify', title: '人机验证', keywords: ['工作量证明', '环境质询', '来源域名绑定', '认证记录保留'] },
	{ href: '/settings/emoji', title: '表情设置', keywords: ['OwO'] },
	{ href: '/settings/avatar', title: '头像设置', keywords: ['头像来源', 'Gravatar', 'Cravatar', 'QQ', '自定义'] },
	{ href: '/settings/data', title: '数据管理', keywords: ['导入导出'] },
];

/** 每张卡片的图标与配色（与卡片页 / 目标页的「一个栏目一个色调」一致） */
const EXPECTED_ICONS = [
	{ icon: 'i.fa-globe', hue: 'blue' },
	{ icon: 'i.fa-user-lock', hue: 'amber' },
	{ icon: 'i.fa-envelope', hue: 'teal' },
	{ icon: 'i.fa-shield-halved', hue: 'red' },
	{ icon: 'i.fa-link', hue: 'sky' },
	{ icon: 'i.fa-robot', hue: 'indigo' },
	{ icon: 'i.fa-face-smile', hue: 'violet' },
	{ icon: 'i.fa-user-circle', hue: 'rose' },
	{ icon: 'i.fa-database', hue: 'emerald' },
];

let wrapper;

const mountSettings = async () => {
	const router = await createTestRouter('/settings');
	wrapper = mount(Settings, {
		global: { plugins: [router], stubs: { AdminLayout: AdminLayoutStub } },
	});
	return wrapper;
};

afterEach(() => {
	if (wrapper) wrapper.unmount();
	wrapper = undefined;
});

describe('Settings - 入口卡片', () => {
	it('恰好 9 张卡片，且顺序与确认的一致', async () => {
		await mountSettings();
		const cards = wrapper.findAll('[data-test="settings-card"]');
		expect(cards).toHaveLength(EXPECTED_CARDS.length);
		expect(cards.map((card) => card.attributes('href'))).toEqual(EXPECTED_CARDS.map((card) => card.href));
		expect(cards.map((card) => card.find('h2').text())).toEqual(EXPECTED_CARDS.map((card) => card.title));
	});

	it('「数据管理」是最后一张卡片', async () => {
		await mountSettings();
		const cards = wrapper.findAll('[data-test="settings-card"]');
		expect(cards.at(-1).attributes('href')).toBe('/settings/data');
		expect(cards.at(-1).text()).toContain('数据管理');
		expect(cards.at(-1).text()).toContain('导入导出');
	});

	it('每张卡片的说明文案包含约定要点', async () => {
		await mountSettings();
		const cards = wrapper.findAll('[data-test="settings-card"]');
		EXPECTED_CARDS.forEach((expected, index) => {
			const text = cards[index].text();
			expect(text).toContain(expected.title);
			(expected.keywords || []).forEach((keyword) => expect(text).toContain(keyword));
		});
	});

	it('每张卡片的图标与色调符合约定（图标类 + 各自的 -500 色）', async () => {
		await mountSettings();
		const cards = wrapper.findAll('[data-test="settings-card"]');
		EXPECTED_ICONS.forEach((expected, index) => {
			const icon = cards[index].find(expected.icon);
			expect(icon.exists()).toBe(true);
			expect(icon.classes()).toContain(`text-${expected.hue}-500`);
		});
	});

	it('不再有旧的「安全设置」卡片标题（已改名访问控制）', async () => {
		await mountSettings();
		expect(wrapper.text()).not.toContain('安全设置');
	});
});
