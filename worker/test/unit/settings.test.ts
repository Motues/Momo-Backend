/**
 * src/utils/settings.ts —— Settings 表读写、默认管理员凭据与邮件开关。
 *
 * D1 表不存在时 getSetting / getAllSettings 必须静默降级（返回 null / {}），
 * 否则任何一个查询都会把请求打成 500。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSchema, rawSetting, rawSettings, seedSettings, testEnv } from '../helpers/db';
import {
	DEFAULT_ADMIN_NAME,
	DEFAULT_ADMIN_PASSWORD,
	changeAdminPassword,
	checkAdminCredentials,
	getAllSettings,
	getSetting,
	getTemplate,
	isDefaultAdmin,
	isEmailEnabled,
	setSetting,
} from '../../src/utils/settings';

const env = testEnv;

describe('getSetting / setSetting', () => {
	beforeEach(createSchema);

	it('键不存在时返回 null', async () => {
		expect(await getSetting(env, 'not_configured')).toBeNull();
	});

	it('写入后可以读回', async () => {
		await setSetting(env, 'site_name', 'Momo Blog');
		expect(await getSetting(env, 'site_name')).toBe('Momo Blog');
		expect(await rawSetting('site_name')).toBe('Momo Blog');
	});

	it('同名键重复写入走 upsert（值被覆盖且不产生第二行）', async () => {
		await setSetting(env, 'site_name', 'A');
		await setSetting(env, 'site_name', 'B');
		expect(await getSetting(env, 'site_name')).toBe('B');
		expect(Object.keys(await rawSettings())).toEqual(['site_name']);
	});

	it('空字符串是合法值（不会被当成未配置）', async () => {
		await setSetting(env, 'email_user', '');
		expect(await getSetting(env, 'email_user')).toBe('');
	});

	it('写入会填充 updated_at', async () => {
		await setSetting(env, 'site_name', 'X');
		const row = await testEnv.MOMO_DB.prepare('SELECT updated_at FROM Settings WHERE key = ?')
			.bind('site_name')
			.first<{ updated_at: string }>();
		expect(row?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});
});

describe('Settings 表缺失时的静默降级', () => {
	beforeEach(createSchema);

	it('getSetting 返回 null 而不是抛错', async () => {
		await testEnv.MOMO_DB.prepare('DROP TABLE Settings').run();
		await expect(getSetting(env, 'site_name')).resolves.toBeNull();
	});

	it('getAllSettings 返回空对象而不是抛错', async () => {
		await testEnv.MOMO_DB.prepare('DROP TABLE Settings').run();
		await expect(getAllSettings(env)).resolves.toEqual({});
	});

	it('setSetting 在表缺失时仍然抛错（写入路径不吞异常）', async () => {
		await testEnv.MOMO_DB.prepare('DROP TABLE Settings').run();
		await expect(setSetting(env, 'site_name', 'X')).rejects.toThrow();
	});
});

describe('getAllSettings', () => {
	beforeEach(createSchema);

	it('返回全部键值对', async () => {
		await seedSettings({ site_name: 'Momo', admin_email: 'a@b.c' });
		expect(await getAllSettings(env)).toEqual({ site_name: 'Momo', admin_email: 'a@b.c' });
	});

	it('空表返回空对象', async () => {
		expect(await getAllSettings(env)).toEqual({});
	});
});

describe('isDefaultAdmin', () => {
	beforeEach(createSchema);

	it('未改过密码时返回 true', async () => {
		expect(await isDefaultAdmin(env)).toBe(true);
	});

	it('password_changed = "true" 时返回 false', async () => {
		await seedSettings({ password_changed: 'true' });
		expect(await isDefaultAdmin(env)).toBe(false);
	});

	it('其它取值仍视为未改密码', async () => {
		await seedSettings({ password_changed: '1' });
		expect(await isDefaultAdmin(env)).toBe(true);
	});
});

describe('checkAdminCredentials —— 默认凭据', () => {
	beforeEach(createSchema);

	it('未配置数据库凭据时接受内置默认值', async () => {
		expect(await checkAdminCredentials(env, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD)).toBe(true);
		expect(DEFAULT_ADMIN_NAME).toBe('momo');
		expect(DEFAULT_ADMIN_PASSWORD).toBe('momo');
	});

	it('用户名或密码错误时拒绝', async () => {
		expect(await checkAdminCredentials(env, 'momo', 'wrong')).toBe(false);
		expect(await checkAdminCredentials(env, 'root', 'momo')).toBe(false);
	});

	it('只配了一半（缺 admin_password）时整体回落默认凭据，配置的用户名被忽略', async () => {
		await seedSettings({ admin_name: 'root' });
		expect(await checkAdminCredentials(env, 'momo', 'momo')).toBe(true);
		// dbName 存在但 dbPass 为空 → 进入默认分支，'root' 不再是合法用户名
		expect(await checkAdminCredentials(env, 'root', 'momo')).toBe(false);
	});
});

describe('checkAdminCredentials —— 数据库明文配置与自动升级', () => {
	beforeEach(createSchema);

	it('明文匹配成功，并把密码自动升级为 bcrypt 哈希', async () => {
		await seedSettings({ admin_name: 'root', admin_password: 'plain-secret' });
		expect(await checkAdminCredentials(env, 'root', 'plain-secret')).toBe(true);

		const stored = await rawSetting('admin_password');
		expect(stored?.startsWith('$2')).toBe(true);
		expect(stored).not.toBe('plain-secret');
	});

	it('升级后仍可继续用原密码登录', async () => {
		await seedSettings({ admin_name: 'root', admin_password: 'plain-secret' });
		await checkAdminCredentials(env, 'root', 'plain-secret');
		expect(await checkAdminCredentials(env, 'root', 'plain-secret')).toBe(true);
	});

	it('升级后错误密码被拒绝', async () => {
		await seedSettings({ admin_name: 'root', admin_password: 'plain-secret' });
		expect(await checkAdminCredentials(env, 'root', 'nope')).toBe(false);
		// 失败不应写库
		expect(await rawSetting('admin_password')).toBe('plain-secret');
	});
});

describe('checkAdminCredentials —— bcrypt 哈希分支', () => {
	beforeEach(createSchema);

	it('哈希分支必须同时校验用户名（否则任意用户名可登录）', async () => {
		await changeAdminPassword(env, 'root', 'hashed-secret');
		expect(await checkAdminCredentials(env, 'root', 'hashed-secret')).toBe(true);
		expect(await checkAdminCredentials(env, 'momo', 'hashed-secret')).toBe(false);
		expect(await checkAdminCredentials(env, 'someone-else', 'hashed-secret')).toBe(false);
	});

	it('哈希分支密码错误时拒绝', async () => {
		await changeAdminPassword(env, 'root', 'hashed-secret');
		expect(await checkAdminCredentials(env, 'root', 'hashed-secret-2')).toBe(false);
	});

	it('以 $2 开头的明文密码会被当作哈希处理，因而永远无法登录（三端统一的已知边界）', async () => {
		// 用 $2 前缀（而不是含 $ 的任意值）判定 bcrypt，避免明文密码含 $ 时被误判；
		// 代价是明文恰好以 $2 开头时不可用。bcryptjs 对比非法哈希返回 false 而非抛错。
		await seedSettings({ admin_name: 'root', admin_password: '$2not-a-real-hash' });
		expect(await checkAdminCredentials(env, 'root', '$2not-a-real-hash')).toBe(false);
	});
});

describe('changeAdminPassword', () => {
	beforeEach(createSchema);

	it('写入用户名、哈希密码与 password_changed 标记', async () => {
		await changeAdminPassword(env, 'root', 'new-password');
		const all = await rawSettings();
		expect(all.admin_name).toBe('root');
		expect(all.admin_password.startsWith('$2')).toBe(true);
		expect(all.password_changed).toBe('true');
	});

	it('改密后旧凭据失效、新凭据生效，且不再是默认管理员', async () => {
		await changeAdminPassword(env, 'root', 'new-password');
		expect(await checkAdminCredentials(env, 'momo', 'momo')).toBe(false);
		expect(await checkAdminCredentials(env, 'root', 'new-password')).toBe(true);
		expect(await isDefaultAdmin(env)).toBe(false);
	});

	it('相同密码重复设置会得到不同盐（哈希不相等）', async () => {
		await changeAdminPassword(env, 'root', 'same-password');
		const first = await rawSetting('admin_password');
		await changeAdminPassword(env, 'root', 'same-password');
		const second = await rawSetting('admin_password');
		expect(first).not.toBe(second);
		expect(await checkAdminCredentials(env, 'root', 'same-password')).toBe(true);
	});
});

describe('isEmailEnabled', () => {
	beforeEach(createSchema);

	it('未配置时默认开启', async () => {
		expect(await isEmailEnabled(env)).toBe(true);
	});

	it('显式 "false" 时关闭', async () => {
		await seedSettings({ email_enabled: 'false' });
		expect(await isEmailEnabled(env)).toBe(false);
	});

	it('其它取值一律视为开启', async () => {
		await seedSettings({ email_enabled: 'true' });
		expect(await isEmailEnabled(env)).toBe(true);
		await seedSettings({ email_enabled: '0' });
		expect(await isEmailEnabled(env)).toBe(true);
	});
});

describe('getTemplate', () => {
	beforeEach(createSchema);

	it('未配置时返回 fallback', async () => {
		expect(await getTemplate(env, 'reply_template', 'FALLBACK')).toBe('FALLBACK');
	});

	it('空字符串也返回 fallback', async () => {
		await seedSettings({ reply_template: '' });
		expect(await getTemplate(env, 'reply_template', 'FALLBACK')).toBe('FALLBACK');
	});

	it('已配置时返回自定义模板', async () => {
		await seedSettings({ reply_template: '<p>{{toName}}</p>' });
		expect(await getTemplate(env, 'reply_template', 'FALLBACK')).toBe('<p>{{toName}}</p>');
	});
});
