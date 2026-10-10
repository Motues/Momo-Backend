/**
 * src/utils/verify.ts —— 签名密钥的自动生成与持久化。
 *
 * 单独成文件的原因：verify.ts 的 `cachedSecret` 是模块级缓存，
 * 只有「本文件里的第一次 getSecret()」才会真正走生成/落库分支。
 * 需要重新走一次生成分支的用例则使用 `?case=xxx` 导入全新的模块实例。
 */
import { describe, it, expect } from 'vitest';
import { createSchema, rawSetting, rawSettings, seedSettings, testEnv } from '../helpers/db';
import { fromBase64url, hmacSHA256, honeypotFieldName } from '../../src/utils/verifyCrypto';

const SLUG = '/posts/first-use';

describe('签名密钥的首次生成', () => {
	it('首次使用时自动生成 64 位十六进制密钥并写入 Settings', async () => {
		await createSchema();
		await seedSettings({ comment_verify_enabled: 'true' });
		expect(await rawSetting('comment_verify_secret')).toBeNull();

		const { getPublicVerifyConfig } = await import('../../src/utils/verify');
		const config = await getPublicVerifyConfig(testEnv, SLUG);

		const persisted = await rawSetting('comment_verify_secret');
		expect(persisted).toMatch(/^[0-9a-f]{64}$/);
		// 下发的蜜罐字段名必须由刚生成的密钥派生
		expect(config.verify_honeypot).toBe(await honeypotFieldName(SLUG, persisted as string));
	});

	it('第二次调用复用已持久化的密钥（不会重新生成）', async () => {
		await createSchema();
		await seedSettings({ comment_verify_secret: 'f'.repeat(64), comment_verify_enabled: 'true' });

		const { createChallenge } = await import('../../src/utils/verify?case=reuse');
		const challenge = await createChallenge(testEnv, '1.2.3.4', SLUG);
		expect(challenge.sig).toBe(await hmacSHA256(challenge.prefix, 'f'.repeat(64)));

		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(challenge.prefix)));
		expect(payload.v).toBe(2);
		expect(payload.slug).toBe(SLUG);
		expect(payload.iph).toMatch(/^[0-9a-f]{16}$/);
		// 密钥没有被覆盖
		expect(await rawSetting('comment_verify_secret')).toBe('f'.repeat(64));
	});

	it('密钥为空串时视为未配置并重新生成', async () => {
		await createSchema();
		await seedSettings({ comment_verify_secret: '' });

		const { createChallenge } = await import('../../src/utils/verify?case=empty-secret');
		await createChallenge(testEnv, '1.2.3.4', SLUG);

		const persisted = await rawSetting('comment_verify_secret');
		expect(persisted).toMatch(/^[0-9a-f]{64}$/);
	});

	it('无法持久化密钥时不阻断流程（本次使用临时密钥）', async () => {
		await createSchema();
		// 制造写库失败：允许读取、但 CHECK 约束让 comment_verify_secret 这一行必然写不进去
		await testEnv.MOMO_DB.prepare('DROP TABLE Settings').run();
		await testEnv.MOMO_DB.prepare(
			`CREATE TABLE Settings (
         key TEXT PRIMARY KEY CHECK (key <> 'comment_verify_secret'),
         value TEXT NOT NULL,
         updated_at TEXT DEFAULT (datetime('now'))
       )`
		).run();
		await seedSettings({ comment_verify_difficulty: '8' });

		const { createChallenge } = await import('../../src/utils/verify?case=no-persist');
		const challenge = await createChallenge(testEnv, '1.2.3.4', SLUG);

		// 密钥写不进去，但挑战照常签发
		expect(challenge.expires_in).toBe(600);
		// v1 旧值 8 按 2^8=256 迁移到 1000（下限），再按 count=4 均分 => d = 250
		expect(challenge.pow.d).toBe(250);
		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(challenge.prefix)));
		expect(payload.v).toBe(2);
		expect(payload.iph).toMatch(/^[0-9a-f]{16}$/);
		expect(await rawSettings()).toEqual({ comment_verify_difficulty: '8' });
	});
});
