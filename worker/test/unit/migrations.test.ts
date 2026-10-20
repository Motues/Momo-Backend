/**
 * src/utils/migrations.ts —— 幂等启动自迁移。
 *
 * 关键约束：`ensureMigrated` 用模块级 `migrationPromise` 做「每个 isolate 只跑一次」的缓存，
 * 而 isolatedStorage 只回滚存储、不回滚模块状态。为了能对「首次执行」逐条断言，
 * 每个用例都通过 Vite 的查询串导入一个全新的模块实例（?case=xxx），
 * 使该用例里的第一次 `ensureMigrated()` 都是真正的「首次调用」。
 */
import { describe, it, expect } from 'vitest';
import {
	createSchema,
	getComment,
	seedComment,
	tableExists,
	testEnv,
} from '../helpers/db';
import type { Bindings } from '../../src/bindings';

const ISO_PUB_DATE = '2024-03-05T06:07:08.000Z';
const ISO_MILLIS = 1709618828000;
const MIGRATION_ID = '0001_pub_date_to_millis';
const MIGRATION_ID_VERIFY_RECORD = '0002_verify_record_table';
const MIGRATION_ID_VERIFY_RECORD_ORIGIN = '0003_verify_record_origin';
const MIGRATION_ID_LINK_SYNC = '0004_link_sync_request';
const MIGRATION_ID_TRUSTED_LINK = '0005_trusted_link';
const MIGRATION_ID_TRUSTED_LINK_SOURCE = '0006_trusted_link_source';
const MIGRATION_ID_MAIL_LOG = '0007_mail_log';
const MIGRATION_ID_DORMANT_NOTICE = '0008_dormant_notice';
/** 已发布的迁移 id 列表（顺序即执行顺序）：新增迁移时必须同步这里 */
const MIGRATION_IDS = [
	MIGRATION_ID,
	MIGRATION_ID_VERIFY_RECORD,
	MIGRATION_ID_VERIFY_RECORD_ORIGIN,
	MIGRATION_ID_LINK_SYNC,
	MIGRATION_ID_TRUSTED_LINK,
	MIGRATION_ID_TRUSTED_LINK_SOURCE,
	MIGRATION_ID_MAIL_LOG,
	MIGRATION_ID_DORMANT_NOTICE,
];

/** 读取某条评论 pub_date 的 SQLite 存储类型（integer / text / real / null） */
async function typeofPubDate(id: number): Promise<string | null> {
	const row = await testEnv.MOMO_DB.prepare('SELECT typeof(pub_date) as t FROM Comment WHERE id = ?')
		.bind(id)
		.first<{ t: string }>();
	return row?.t ?? null;
}

async function migrationRows(): Promise<{ id: string; description: string; applied_at: string }[]> {
	const { results } = await testEnv.MOMO_DB.prepare(
		'SELECT id, description, applied_at FROM SchemaMigration ORDER BY id'
	).all<{ id: string; description: string; applied_at: string }>();
	return results ?? [];
}

const env = testEnv as unknown as Bindings;

describe('ensureMigrated —— 0001_pub_date_to_millis', () => {
	it('ISO 字符串 pub_date 被归一化为毫秒整数，并记录到 SchemaMigration', async () => {
		await createSchema();
		const isoId = await seedComment({ pub_date: ISO_PUB_DATE, author: 'Iso' });

		const { ensureMigrated } = await import('../../src/utils/migrations?case=iso');
		await ensureMigrated(env);

		expect((await getComment(isoId))?.pub_date).toBe(ISO_MILLIS);
		expect(await typeofPubDate(isoId)).toBe('integer');

		const rows = await migrationRows();
		expect(rows.map((r) => r.id)).toEqual(MIGRATION_IDS);
		expect(rows[0].description).toContain('毫秒整数');
		expect(rows[0].applied_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it('纯数字字符串由 pub_date 列的 INTEGER 亲和性在写入时即转为整数', async () => {
		await createSchema();
		const plain = await seedComment({ pub_date: '1730000000000', author: 'Plain' });
		const padded = await seedComment({ pub_date: '0001730000000000', author: 'Padded' });
		// 注意：迁移的 WHERE typeof(pub_date) = 'text' 只作用于真正的文本行；
		// INTEGER 亲和性让纯数字字符串在 INSERT 时就已经是整数，迁移里的纯数字分支
		// 因此不会在真实表结构下被触发（这里断言的是亲和性 + 迁移后的最终取值）。
		expect(await typeofPubDate(plain)).toBe('integer');
		expect(await typeofPubDate(padded)).toBe('integer');

		const { ensureMigrated } = await import('../../src/utils/migrations?case=numeric');
		await ensureMigrated(env);

		expect((await getComment(plain))?.pub_date).toBe(1730000000000);
		expect((await getComment(padded))?.pub_date).toBe(1730000000000);
		expect(await typeofPubDate(plain)).toBe('integer');
		expect(await typeofPubDate(padded)).toBe('integer');
	});

	it('已经是整数的 pub_date 不受影响', async () => {
		await createSchema();
		const id = await seedComment({ pub_date: 1700000000000, author: 'Int' });

		const { ensureMigrated } = await import('../../src/utils/migrations?case=integer');
		await ensureMigrated(env);

		expect((await getComment(id))?.pub_date).toBe(1700000000000);
		expect(await typeofPubDate(id)).toBe('integer');
	});

	it('无法解析的文本保持原样（不会被改写成 0 或 NULL）', async () => {
		await createSchema();
		const bad = await seedComment({ pub_date: 'not-a-date', author: 'Bad' });
		// '0' 会被 INTEGER 亲和性直接落库为整数 0，不属于迁移的处理范围
		const zero = await seedComment({ pub_date: '0', author: 'Zero' });
		expect(await typeofPubDate(zero)).toBe('integer');

		const { ensureMigrated } = await import('../../src/utils/migrations?case=unparsable');
		await ensureMigrated(env);

		expect((await getComment(bad))?.pub_date).toBe('not-a-date');
		expect(await typeofPubDate(bad)).toBe('text');
		// 非正数不会被迁移改写成别的值
		expect((await getComment(zero))?.pub_date).toBe(0);
		expect(await typeofPubDate(zero)).toBe('integer');
	});

	it('空表也能正常执行迁移并留下记录', async () => {
		await createSchema();

		const { ensureMigrated } = await import('../../src/utils/migrations?case=empty');
		await ensureMigrated(env);

		expect(await migrationRows()).toHaveLength(MIGRATION_IDS.length);
		const count = await testEnv.MOMO_DB.prepare('SELECT COUNT(*) as c FROM Comment').first<{
			c: number;
		}>();
		expect(count?.c).toBe(0);
	});
});

describe('ensureMigrated —— 0002_verify_record_table', () => {
	it('为升级前的旧库补齐 VerifyRecord 表与三个索引（无需手工执行 SQL）', async () => {
		await createSchema();
		// 模拟升级前已有的 D1：有 Comment / SchemaMigration，但没有 VerifyRecord
		await testEnv.MOMO_DB.prepare('DROP TABLE IF EXISTS VerifyRecord').run();
		expect(await tableExists('VerifyRecord')).toBe(false);

		const { ensureMigrated } = await import('../../src/utils/migrations?case=verify-record');
		await ensureMigrated(env);

		expect(await tableExists('VerifyRecord')).toBe(true);

		const { results } = await testEnv.MOMO_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'VerifyRecord' ORDER BY name"
		).all<{ name: string }>();
		expect((results ?? []).map((row) => row.name)).toEqual([
			'idx_vr_cid',
			'idx_vr_created',
			'idx_vr_event',
		]);

		expect((await migrationRows()).map((row) => row.id)).toEqual(MIGRATION_IDS);
	});
});

describe('ensureMigrated —— 0003_verify_record_origin', () => {
	/** VerifyRecord 当前的全部列名 */
	async function verifyRecordColumns(): Promise<string[]> {
		const { results } = await testEnv.MOMO_DB.prepare('PRAGMA table_info(VerifyRecord)').all<{
			name: string;
		}>();
		return (results ?? []).map((row) => row.name);
	}

	it('为升级前的旧表补上 origin 列（无需手工执行 SQL）', async () => {
		await createSchema();
		// 模拟升级前的 VerifyRecord：为域名绑定新增该列之前的结构
		await testEnv.MOMO_DB.prepare('DROP TABLE IF EXISTS VerifyRecord').run();
		await testEnv.MOMO_DB.prepare(
			`CREATE TABLE VerifyRecord (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         created_at INTEGER NOT NULL,
         event TEXT NOT NULL,
         reason TEXT,
         elapsed_ms INTEGER,
         difficulty INTEGER,
         challenge_id TEXT,
         post_slug TEXT,
         ip_address TEXT,
         country TEXT,
         network TEXT,
         asn INTEGER
       )`
		).run();
		expect(await verifyRecordColumns()).not.toContain('origin');

		const { ensureMigrated } = await import('../../src/utils/migrations?case=verify-origin');
		await ensureMigrated(env);

		expect(await verifyRecordColumns()).toContain('origin');
		expect((await migrationRows()).map((row) => row.id)).toEqual(MIGRATION_IDS);
	});

	it('列已由建表 DDL 建出时容忍 duplicate column name（新库不会反复报错）', async () => {
		// createSchema() 用的是最新 schemas/comment.sql：VerifyRecord 一开始就有 origin
		await createSchema();
		expect(await verifyRecordColumns()).toContain('origin');

		const { ensureMigrated } = await import('../../src/utils/migrations?case=verify-origin-dup');
		await expect(ensureMigrated(env)).resolves.toBeUndefined();

		// 迁移仍然被记为已应用（否则每个 isolate 都要重跑一遍注定报错的 ALTER）
		expect((await migrationRows()).map((row) => row.id)).toEqual(MIGRATION_IDS);
		// 且不会重复加列
		expect((await verifyRecordColumns()).filter((name) => name === 'origin')).toHaveLength(1);
	});
});

describe('ensureMigrated —— 0004_link_sync_request', () => {
	it('为升级前的旧库补齐 LinkSyncRequest 表与两个索引（无需手工执行 SQL）', async () => {
		await createSchema();
		// 模拟升级前已有的 D1：有 Comment / SchemaMigration，但没有 LinkSyncRequest
		await testEnv.MOMO_DB.prepare('DROP TABLE IF EXISTS LinkSyncRequest').run();
		expect(await tableExists('LinkSyncRequest')).toBe(false);

		const { ensureMigrated } = await import('../../src/utils/migrations?case=link-sync');
		await ensureMigrated(env);

		expect(await tableExists('LinkSyncRequest')).toBe(true);

		const { results } = await testEnv.MOMO_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'LinkSyncRequest' ORDER BY name"
		).all<{ name: string }>();
		// token 的 UNIQUE 约束会带来一个 sqlite_autoindex_*，这里只断言显式建立的两个索引
		const explicit = (results ?? [])
			.map((row) => row.name)
			.filter((name) => !name.startsWith('sqlite_autoindex_'));
		expect(explicit).toEqual(['idx_lsr_email', 'idx_lsr_token']);

		expect((await migrationRows()).map((row) => row.id)).toEqual(MIGRATION_IDS);
	});

	it('也可以直接写入一条待确认记录（表结构可用）', async () => {
		await createSchema();
		const { seedLinkSyncRequest } = await import('../helpers/db');
		const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
		const id = await seedLinkSyncRequest({
			email: 'norm@example.com',
			new_url: 'https://new.example.com',
			token: 'tok-1',
			expires_at: expiresAt,
		});
		const row = await testEnv.MOMO_DB.prepare('SELECT * FROM LinkSyncRequest WHERE id = ?')
			.bind(id)
			.first<{ email: string; new_url: string; confirmed: number; expires_at: string }>();
		expect(row).toMatchObject({
			email: 'norm@example.com',
			new_url: 'https://new.example.com',
			confirmed: 0,
			expires_at: expiresAt,
		});
	});
});

describe('ensureMigrated —— 0005_trusted_link', () => {
	it('为升级前的旧库补齐 TrustedLink 表与两个索引（无需手工执行 SQL）', async () => {
		await createSchema();
		// 模拟升级前已有的 D1：有 Comment / SchemaMigration，但没有 TrustedLink
		await testEnv.MOMO_DB.prepare('DROP TABLE IF EXISTS TrustedLink').run();
		expect(await tableExists('TrustedLink')).toBe(false);

		const { ensureMigrated } = await import('../../src/utils/migrations?case=trusted-link');
		await ensureMigrated(env);

		expect(await tableExists('TrustedLink')).toBe(true);

		const { results } = await testEnv.MOMO_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'TrustedLink' ORDER BY name"
		).all<{ name: string }>();
		// (email, url) 的 UNIQUE 会带来一个 sqlite_autoindex_*，这里只断言显式建立的两个索引
		const explicit = (results ?? [])
			.map((row) => row.name)
			.filter((name) => !name.startsWith('sqlite_autoindex_'));
		expect(explicit).toEqual(['idx_tl_email', 'idx_tl_email_url']);

		expect((await migrationRows()).map((row) => row.id)).toEqual(MIGRATION_IDS);
	});

	it('也可以直接写入一条人工确认记录（表结构可用）', async () => {
		await createSchema();
		const { seedTrustedLink } = await import('../helpers/db');
		const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
		const id = await seedTrustedLink({
			email: 'norm@example.com',
			url: 'https://norm.example.com',
			expires_at: expiresAt,
		});
		const row = await testEnv.MOMO_DB.prepare('SELECT * FROM TrustedLink WHERE id = ?')
			.bind(id)
			.first<{ email: string; url: string; expires_at: string }>();
		expect(row).toMatchObject({
			email: 'norm@example.com',
			url: 'https://norm.example.com',
			expires_at: expiresAt,
		});
	});
});

describe('ensureMigrated —— 0006_trusted_link_source', () => {
	/** TrustedLink 当前的全部列名 */
	async function trustedLinkColumns(): Promise<string[]> {
		const { results } = await testEnv.MOMO_DB.prepare('PRAGMA table_info(TrustedLink)').all<{
			name: string;
		}>();
		return (results ?? []).map((row) => row.name);
	}

	it('为升级前的旧表补上 source 列，且旧行默认 admin（无需手工执行 SQL）', async () => {
		await createSchema();
		// 模拟升级前的 TrustedLink：source 列之前的结构
		await testEnv.MOMO_DB.prepare('DROP TABLE IF EXISTS TrustedLink').run();
		await testEnv.MOMO_DB.prepare(
			`CREATE TABLE TrustedLink (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         email TEXT NOT NULL,
         url TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`
		).run();
		await testEnv.MOMO_DB.prepare(
			`INSERT INTO TrustedLink (email, url, expires_at, created_at) VALUES (?, ?, ?, ?)`
		)
			.bind('a@x.com', 'https://a.example.com', new Date(Date.now() + 86400000).toISOString(), new Date().toISOString())
			.run();
		expect(await trustedLinkColumns()).not.toContain('source');

		const { ensureMigrated } = await import('../../src/utils/migrations?case=trusted-source');
		await ensureMigrated(env);

		expect(await trustedLinkColumns()).toContain('source');
		const row = await testEnv.MOMO_DB.prepare('SELECT source FROM TrustedLink').first<{
			source: string;
		}>();
		expect(row?.source).toBe('admin');
		expect((await migrationRows()).map((r) => r.id)).toEqual(MIGRATION_IDS);
	});

	it('列已由建表 DDL 建出时容忍 duplicate column name（新库不会反复报错）', async () => {
		await createSchema();
		expect(await trustedLinkColumns()).toContain('source');

		const { ensureMigrated } = await import('../../src/utils/migrations?case=trusted-source-dup');
		await expect(ensureMigrated(env)).resolves.toBeUndefined();

		expect((await migrationRows()).map((r) => r.id)).toEqual(MIGRATION_IDS);
		expect((await trustedLinkColumns()).filter((name) => name === 'source')).toHaveLength(1);
	});
});

describe('ensureMigrated —— 0007_mail_log', () => {
	it('为升级前的旧库补齐 MailLog 表与两个索引（无需手工执行 SQL）', async () => {
		await createSchema();
		// 模拟升级前已有的 D1：有 Comment / SchemaMigration，但没有 MailLog
		await testEnv.MOMO_DB.prepare('DROP TABLE IF EXISTS MailLog').run();
		expect(await tableExists('MailLog')).toBe(false);

		const { ensureMigrated } = await import('../../src/utils/migrations?case=mail-log');
		await ensureMigrated(env);

		expect(await tableExists('MailLog')).toBe(true);

		const { results } = await testEnv.MOMO_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'MailLog' ORDER BY name"
		).all<{ name: string }>();
		const explicit = (results ?? [])
			.map((row) => row.name)
			.filter((name) => !name.startsWith('sqlite_autoindex_'));
		expect(explicit).toEqual(['idx_ml_created', 'idx_ml_status']);

		expect((await migrationRows()).map((row) => row.id)).toEqual(MIGRATION_IDS);
	});

	it('也可以直接写入一行邮件日志（表结构可用）', async () => {
		await createSchema();
		const { seedMailLog } = await import('../helpers/db');
		const id = await seedMailLog({ type: 'dormant_notice', status: 'failed', error: 'boom' });
		const row = await testEnv.MOMO_DB.prepare('SELECT * FROM MailLog WHERE id = ?')
			.bind(id)
			.first<{ type: string; status: string; error: string }>();
		expect(row).toMatchObject({ type: 'dormant_notice', status: 'failed', error: 'boom' });
	});
});

describe('ensureMigrated —— 0008_dormant_notice', () => {
	it('为升级前的旧库补齐 DormantNotice 表与三个索引（无需手工执行 SQL）', async () => {
		await createSchema();
		// 模拟升级前已有的 D1：有 Comment / SchemaMigration，但没有 DormantNotice
		await testEnv.MOMO_DB.prepare('DROP TABLE IF EXISTS DormantNotice').run();
		expect(await tableExists('DormantNotice')).toBe(false);

		const { ensureMigrated } = await import('../../src/utils/migrations?case=dormant-notice');
		await ensureMigrated(env);

		expect(await tableExists('DormantNotice')).toBe(true);

		const { results } = await testEnv.MOMO_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'DormantNotice' ORDER BY name"
		).all<{ name: string }>();
		// token 的 UNIQUE 与 (email, url) 的 UNIQUE 各带来一个 sqlite_autoindex_*，这里只断言显式索引
		const explicit = (results ?? [])
			.map((row) => row.name)
			.filter((name) => !name.startsWith('sqlite_autoindex_'));
		expect(explicit).toEqual(['idx_dn_email', 'idx_dn_email_url', 'idx_dn_token']);

		expect((await migrationRows()).map((row) => row.id)).toEqual(MIGRATION_IDS);
	});

	it('也可以直接写入一条提醒记录（表结构可用）', async () => {
		await createSchema();
		const { seedDormantNotice } = await import('../helpers/db');
		const id = await seedDormantNotice({
			email: 'norm@example.com',
			url: 'https://norm.example.com',
			token: 'tok-dn',
			notify_count: 2,
		});
		const row = await testEnv.MOMO_DB.prepare('SELECT * FROM DormantNotice WHERE id = ?')
			.bind(id)
			.first<{ email: string; url: string; token: string; notify_count: number }>();
		expect(row).toMatchObject({
			email: 'norm@example.com',
			url: 'https://norm.example.com',
			token: 'tok-dn',
			notify_count: 2,
		});
	});
});

describe('ensureMigrated —— 幂等性', () => {
	it('重复调用不再改写数据（迁移已记录则跳过）', async () => {
		await createSchema();
		const before = await seedComment({ pub_date: ISO_PUB_DATE, author: 'Before' });

		const { ensureMigrated } = await import('../../src/utils/migrations?case=rerun');
		await ensureMigrated(env);
		expect((await getComment(before))?.pub_date).toBe(ISO_MILLIS);

		// 首次迁移之后写入的新行同样是 ISO 文本，但迁移已被记录 → 不应再被处理
		const after = await seedComment({ pub_date: ISO_PUB_DATE, author: 'After' });
		await ensureMigrated(env);

		expect((await getComment(after))?.pub_date).toBe(ISO_PUB_DATE);
		expect(await typeofPubDate(after)).toBe('text');
		expect(await migrationRows()).toHaveLength(MIGRATION_IDS.length);
	});

	it('并发调用共享同一个 Promise，迁移只执行一次', async () => {
		await createSchema();
		await seedComment({ pub_date: ISO_PUB_DATE, author: 'Concurrent' });

		const { ensureMigrated } = await import('../../src/utils/migrations?case=concurrent');
		const first = ensureMigrated(env);
		const second = ensureMigrated(env);
		expect(first).toBe(second);

		await Promise.all([first, second]);
		expect(await migrationRows()).toHaveLength(MIGRATION_IDS.length);
	});

	it('Comment 表不存在时直接跳过，且不创建 SchemaMigration 表', async () => {
		// 刻意不调用 createSchema()：全新数据库里没有任何表
		expect(await tableExists('Comment')).toBe(false);

		const { ensureMigrated } = await import('../../src/utils/migrations?case=missing');
		await expect(ensureMigrated(env)).resolves.toBeUndefined();

		expect(await tableExists('SchemaMigration')).toBe(false);
	});
});

describe('ensureMigrated —— 失败容错', () => {
	it('迁移失败不抛错，且 batch 的事务性回滚保证数据未被半途改写', async () => {
		await createSchema();
		// 用一个带 CHECK 约束的 SchemaMigration 表让 INSERT 记录必然失败
		await testEnv.MOMO_DB.prepare('DROP TABLE SchemaMigration').run();
		await testEnv.MOMO_DB.prepare(
			`CREATE TABLE SchemaMigration (
         id TEXT PRIMARY KEY CHECK (id = 'never'),
         description TEXT NOT NULL DEFAULT '',
         applied_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
		).run();
		const isoId = await seedComment({ pub_date: ISO_PUB_DATE, author: 'Atomic' });

		const { ensureMigrated } = await import('../../src/utils/migrations?case=failure');
		// 失败被 catch：调用方永远看到 resolved，不会把请求打成 500
		await expect(ensureMigrated(env)).resolves.toBeUndefined();

		// D1 batch 是事务性的：迁移语句与记录同进同退，因此 pub_date 保持原样
		expect((await getComment(isoId))?.pub_date).toBe(ISO_PUB_DATE);
		expect(await migrationRows()).toHaveLength(0);

		// 失败后缓存被清空，下一次调用会重试（同样不抛错）
		await expect(ensureMigrated(env)).resolves.toBeUndefined();
		expect((await getComment(isoId))?.pub_date).toBe(ISO_PUB_DATE);
	});
});
