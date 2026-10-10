/**
 * 测试基础设施：D1 建表与数据读写辅助。
 *
 * ⚠️ 关键前提：vitest-pool-workers 默认开启 `isolatedStorage`，
 * 每个 it() 结束后 D1 / KV 的写入都会被回滚（下一个用例里连表都不存在）。
 * 因此所有依赖数据库的用例都必须在 beforeEach 中重新调用 `createSchema()`。
 *
 * 建表语句来自 vitest.config.mts 注入的 `TEST_SCHEMA_STATEMENTS` 绑定，
 * 也就是生产用的 `schemas/comment.sql`（按 `;` 拆分后的单条语句）。
 * 这里刻意不用 `exec()`：pool 里的 D1 `exec()` 无法处理多行 DDL。
 */
import { env } from 'cloudflare:test';

/** miniflare 注入的测试绑定（`cloudflare:test` 的 ProvidedEnv 默认为空接口） */
export type TestBindings = {
	MOMO_DB: D1Database;
	MOMO_AUTH_KV: KVNamespace;
	TEST_SCHEMA_STATEMENTS: string[];
};

export const testEnv = env as unknown as TestBindings;

/** schemas/comment.sql 中定义的五张表 */
export const EXPECTED_TABLES = [
	'Comment',
	'EmailVerification',
	'SchemaMigration',
	'Settings',
	'VerifyRecord',
];

/**
 * 用注入的 schema 语句建表（幂等）。
 * 语句缺失时直接抛错——否则后续用例会以「no such table」这种难以定位的方式失败。
 */
export async function createSchema(): Promise<void> {
	const statements = testEnv.TEST_SCHEMA_STATEMENTS;
	if (!Array.isArray(statements) || statements.length === 0) {
		throw new Error('TEST_SCHEMA_STATEMENTS 未注入：请检查 vitest.config.mts 的 miniflare.bindings');
	}
	for (const statement of statements) {
		await testEnv.MOMO_DB.prepare(statement).run();
	}
}

/** 列出当前数据库中的所有表名 */
export async function tableNames(): Promise<string[]> {
	const { results } = await testEnv.MOMO_DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
	).all<{ name: string }>();
	return (results ?? []).map((row) => row.name);
}

/** 判断某张表是否存在 */
export async function tableExists(name: string): Promise<boolean> {
	const row = await testEnv.MOMO_DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
	)
		.bind(name)
		.first<{ name: string }>();
	return !!row;
}

/* ------------------------------- Comment 表 ------------------------------- */

export interface SeedCommentInput {
	pub_date?: number | string;
	post_slug?: string;
	author?: string;
	email?: string;
	url?: string | null;
	ip_address?: string | null;
	device?: string | null;
	os?: string | null;
	browser?: string | null;
	user_agent?: string | null;
	content_text?: string;
	content_html?: string;
	parent_id?: number | null;
	status?: string;
}

/** 直接写库播种一条评论，返回自增 id */
export async function seedComment(input: SeedCommentInput = {}): Promise<number> {
	const row: Required<SeedCommentInput> = {
		pub_date: 1730000000000,
		post_slug: '/posts/demo',
		author: 'Alice',
		email: 'alice@example.com',
		url: null,
		ip_address: '127.0.0.1',
		device: 'Desktop',
		os: 'Windows 10',
		browser: 'Chrome 120.0.0.0',
		user_agent: 'seed-agent',
		content_text: 'hello',
		content_html: '<p>hello</p>',
		parent_id: null,
		status: 'approved',
		...input,
	};

	const result = await testEnv.MOMO_DB.prepare(
		`INSERT INTO Comment (
       pub_date, post_slug, author, email, url, ip_address,
       device, os, browser, user_agent, content_text, content_html, parent_id, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			row.pub_date,
			row.post_slug,
			row.author,
			row.email,
			row.url,
			row.ip_address,
			row.device,
			row.os,
			row.browser,
			row.user_agent,
			row.content_text,
			row.content_html,
			row.parent_id,
			row.status
		)
		.run();

	return Number(result.meta.last_row_id);
}

export interface CommentRow {
	id: number;
	pub_date: unknown;
	post_slug: string;
	author: string;
	email: string;
	url: string | null;
	ip_address: string | null;
	device: string | null;
	os: string | null;
	browser: string | null;
	user_agent: string | null;
	content_text: string;
	content_html: string;
	parent_id: number | null;
	status: string;
}

/** 按 id 读取一条评论（含全部字段，便于断言落库结果） */
export async function getComment(id: number): Promise<CommentRow | null> {
	return await testEnv.MOMO_DB.prepare('SELECT * FROM Comment WHERE id = ?')
		.bind(id)
		.first<CommentRow>();
}

/** 读取全部评论（按 id 升序） */
export async function allComments(): Promise<CommentRow[]> {
	const { results } = await testEnv.MOMO_DB.prepare(
		'SELECT * FROM Comment ORDER BY id ASC'
	).all<CommentRow>();
	return results ?? [];
}

/** 评论总数 */
export async function countComments(): Promise<number> {
	const row = await testEnv.MOMO_DB.prepare('SELECT COUNT(*) as count FROM Comment').first<{
		count: number;
	}>();
	return row?.count ?? 0;
}

/** 最近一条评论的 id（用于断言 POST 写入的那一行） */
export async function lastCommentId(): Promise<number | null> {
	const row = await testEnv.MOMO_DB.prepare(
		'SELECT id FROM Comment ORDER BY id DESC LIMIT 1'
	).first<{ id: number }>();
	return row?.id ?? null;
}

/* ------------------------------- Settings 表 ------------------------------ */

/** 直接写库播种设置项（先建表） */
export async function seedSettings(values: Record<string, string>): Promise<void> {
	for (const [key, value] of Object.entries(values)) {
		await testEnv.MOMO_DB.prepare(
			`INSERT INTO Settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
			.bind(key, value)
			.run();
	}
}

/** 读取单条设置原始值（不走应用的 getSetting，用于验证落库结果） */
export async function rawSetting(key: string): Promise<string | null> {
	const row = await testEnv.MOMO_DB.prepare('SELECT value FROM Settings WHERE key = ?')
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

/** 读取全部设置原始值 */
export async function rawSettings(): Promise<Record<string, string>> {
	const { results } = await testEnv.MOMO_DB.prepare('SELECT key, value FROM Settings').all<{
		key: string;
		value: string;
	}>();
	const map: Record<string, string> = {};
	for (const row of results ?? []) map[row.key] = row.value;
	return map;
}

/* --------------------------- EmailVerification 表 -------------------------- */

export interface SeedVerificationInput {
	email?: string;
	token?: string;
	/** ISO 字符串；默认 24 小时后过期 */
	expires_at?: string;
	verified?: number;
	post_slug?: string | null;
	post_title?: string | null;
	verified_at?: string | null;
}

/** 播种一条邮箱验证记录，返回自增 id */
export async function seedVerification(input: SeedVerificationInput = {}): Promise<number> {
	const row = {
		email: 'alice@example.com',
		token: 'token-1',
		expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
		verified: 0,
		post_slug: '/posts/demo',
		post_title: 'Demo',
		verified_at: null,
		...input,
	};
	const result = await testEnv.MOMO_DB.prepare(
		`INSERT INTO EmailVerification (email, token, created_at, expires_at, verified, post_slug, post_title, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			row.email,
			row.token,
			new Date().toISOString(),
			row.expires_at,
			row.verified,
			row.post_slug,
			row.post_title,
			row.verified_at
		)
		.run();
	return Number(result.meta.last_row_id);
}

/** 读取一条邮箱验证记录 */
export async function getVerification(token: string): Promise<{
	id: number;
	email: string;
	token: string;
	expires_at: string;
	verified: number;
	verified_at: string | null;
} | null> {
	return await testEnv.MOMO_DB.prepare('SELECT * FROM EmailVerification WHERE token = ?')
		.bind(token)
		.first();
}

/* ----------------------------- VerifyRecord 表 ---------------------------- */

export interface SeedVerifyRecordInput {
	/** 事件时间（Unix 毫秒）；默认「现在」 */
	created_at?: number;
	event?: 'challenge' | 'pass' | 'fail';
	reason?: string | null;
	elapsed_ms?: number | null;
	difficulty?: number | null;
	challenge_id?: string | null;
	post_slug?: string | null;
	ip_address?: string | null;
	country?: string | null;
	network?: string | null;
	asn?: number | null;
}

export interface VerifyRecordRow {
	id: number;
	created_at: number;
	event: string;
	reason: string | null;
	elapsed_ms: number | null;
	difficulty: number | null;
	challenge_id: string | null;
	post_slug: string | null;
	ip_address: string | null;
	country: string | null;
	network: string | null;
	asn: number | null;
}

/**
 * 直接写库播种一条认证记录，返回自增 id。
 *
 * created_at 是「Unix 毫秒整数」，因此可以精确构造「窗口内 / 窗口外」的记录，
 * 而不用依赖真实时钟（统计窗口按 UTC 对齐，见 src/utils/verifyRecord.ts）。
 */
export async function seedVerifyRecord(input: SeedVerifyRecordInput = {}): Promise<number> {
	const row: Required<SeedVerifyRecordInput> = {
		created_at: Date.now(),
		event: 'challenge',
		reason: null,
		elapsed_ms: null,
		difficulty: null,
		challenge_id: null,
		post_slug: null,
		ip_address: null,
		country: null,
		network: null,
		asn: null,
		...input,
	};

	const result = await testEnv.MOMO_DB.prepare(
		`INSERT INTO VerifyRecord
       (created_at, event, reason, elapsed_ms, difficulty, challenge_id, post_slug, ip_address, country, network, asn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			row.created_at,
			row.event,
			row.reason,
			row.elapsed_ms,
			row.difficulty,
			row.challenge_id,
			row.post_slug,
			row.ip_address,
			row.country,
			row.network,
			row.asn
		)
		.run();

	return Number(result.meta.last_row_id);
}

/** 读取全部认证记录（按 id 升序，便于断言写入顺序） */
export async function allVerifyRecords(): Promise<VerifyRecordRow[]> {
	const { results } = await testEnv.MOMO_DB.prepare(
		'SELECT * FROM VerifyRecord ORDER BY id ASC'
	).all<VerifyRecordRow>();
	return results ?? [];
}

/** 认证记录条数 */
export async function countVerifyRecords(): Promise<number> {
	const row = await testEnv.MOMO_DB.prepare('SELECT COUNT(*) as count FROM VerifyRecord').first<{
		count: number;
	}>();
	return row?.count ?? 0;
}

/* ------------------------------- KV 辅助 --------------------------------- */

/** 列出 KV 中的键名（可按前缀过滤） */
export async function kvKeys(prefix = ''): Promise<string[]> {
	const listed = await testEnv.MOMO_AUTH_KV.list({ prefix });
	return listed.keys.map((k) => k.name);
}

/** 读取 KV 原始值 */
export async function kvGet(key: string): Promise<string | null> {
	return await testEnv.MOMO_AUTH_KV.get(key);
}
