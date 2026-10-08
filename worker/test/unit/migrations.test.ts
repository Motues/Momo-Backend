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
		expect(rows.map((r) => r.id)).toEqual([MIGRATION_ID]);
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

		expect(await migrationRows()).toHaveLength(1);
		const count = await testEnv.MOMO_DB.prepare('SELECT COUNT(*) as c FROM Comment').first<{
			c: number;
		}>();
		expect(count?.c).toBe(0);
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
		expect(await migrationRows()).toHaveLength(1);
	});

	it('并发调用共享同一个 Promise，迁移只执行一次', async () => {
		await createSchema();
		await seedComment({ pub_date: ISO_PUB_DATE, author: 'Concurrent' });

		const { ensureMigrated } = await import('../../src/utils/migrations?case=concurrent');
		const first = ensureMigrated(env);
		const second = ensureMigrated(env);
		expect(first).toBe(second);

		await Promise.all([first, second]);
		expect(await migrationRows()).toHaveLength(1);
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
