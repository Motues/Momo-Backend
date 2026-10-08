/**
 * 测试基础设施自检（替代原先的 smoke.test.ts）。
 *
 * 覆盖：注入的建表语句可用、四张表建全、建表幂等、D1 写入读取、KV 可用，
 * 以及 vitest-pool-workers 的 isolatedStorage 契约（每个用例独立存储）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	createSchema,
	tableNames,
	tableExists,
	countComments,
	seedComment,
	testEnv,
	EXPECTED_TABLES,
	kvKeys,
} from './helpers/db';

describe('测试基础设施', () => {
	it('vitest.config.mts 应注入非空的建表语句', () => {
		const statements = testEnv.TEST_SCHEMA_STATEMENTS;
		expect(Array.isArray(statements)).toBe(true);
		expect(statements.length).toBeGreaterThan(0);
		expect(statements.every((s) => typeof s === 'string' && s.trim().length > 0)).toBe(true);
		// 语句是按 ';' 拆分的单条 DDL，不能残留多行 CREATE TABLE
		expect(statements.some((s) => /CREATE TABLE IF NOT EXISTS Comment/i.test(s))).toBe(true);
	});

	it('createSchema 应建出 schemas/comment.sql 里的四张表', async () => {
		await createSchema();
		const names = await tableNames();
		for (const table of EXPECTED_TABLES) {
			expect(names).toContain(table);
		}
	});

	it('createSchema 应可重复调用（幂等）', async () => {
		await createSchema();
		await createSchema();
		expect(await tableExists('Comment')).toBe(true);
	});

	it('D1 绑定可写入并按默认值读取评论', async () => {
		await createSchema();
		await testEnv.MOMO_DB.prepare(
			`INSERT INTO Comment (pub_date, post_slug, author, email, content_text, content_html, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(1730000000000, '/posts/demo', 'Alice', 'a@example.com', 'hi', '<p>hi</p>', 'approved')
			.run();

		const row = await testEnv.MOMO_DB.prepare('SELECT author, pub_date FROM Comment').first<{
			author: string;
			pub_date: number;
		}>();
		expect(row?.author).toBe('Alice');
		expect(row?.pub_date).toBe(1730000000000);
		// seedComment 返回自增主键，说明 D1Result.meta.last_row_id 可用
		const id = await seedComment({ author: 'Bob' });
		expect(id).toBe(2);
		expect(await countComments()).toBe(2);
	});

	it('KV 绑定可读写删', async () => {
		await testEnv.MOMO_AUTH_KV.put('probe:key', 'value', { expirationTtl: 60 });
		expect(await testEnv.MOMO_AUTH_KV.get('probe:key')).toBe('value');
		expect(await kvKeys('probe:')).toEqual(['probe:key']);
		await testEnv.MOMO_AUTH_KV.delete('probe:key');
		expect(await testEnv.MOMO_AUTH_KV.get('probe:key')).toBeNull();
	});
});

/**
 * 框架契约：isolatedStorage 默认开启，每个用例结束后写入被回滚。
 * 这正是所有测试文件都必须 beforeEach(createSchema) 的原因。
 */
describe('存储隔离契约（isolatedStorage）', () => {
	it('本用例建表并写入数据', async () => {
		await createSchema();
		await seedComment();
		expect(await countComments()).toBe(1);
	});

	it('下一个用例中上一个用例的写入已被回滚（表都不存在）', async () => {
		expect(await tableExists('Comment')).toBe(false);
	});
});
