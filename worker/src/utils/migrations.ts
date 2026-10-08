import { Bindings } from '../bindings';

/**
 * 幂等启动自迁移（C7）。
 *
 * 约定：
 *  - 迁移只在首次出现时执行一次，执行记录写入 `SchemaMigration` 表；
 *  - `id` 一旦发布不可修改（改动等于新增一条迁移）；
 *  - 这里只放**非破坏性**迁移（数据归一化、补索引等）。
 *    需要重建表的结构变更（例如修改列默认值）请在 `doc/migrations/` 下提供一次性 SQL 脚本，
 *    由部署者按文档手工执行。
 */
type Migration = {
  id: string;
  description: string;
  statements: string[];
};

const MIGRATIONS: Migration[] = [
  {
    id: '0001_pub_date_to_millis',
    description: '将 pub_date 从 ISO 字符串统一为毫秒整数（与 Node/Go 对齐）',
    statements: [
      `UPDATE Comment
         SET pub_date = CASE
             WHEN pub_date NOT GLOB '*[^0-9]*' AND CAST(pub_date AS INTEGER) > 0
               THEN CAST(pub_date AS INTEGER)
             WHEN CAST(strftime('%s', pub_date) AS INTEGER) > 0
               THEN CAST(strftime('%s', pub_date) AS INTEGER) * 1000
             ELSE pub_date
           END
         WHERE typeof(pub_date) = 'text'`,
    ],
  },
];

const SCHEMA_MIGRATION_DDL = `
  CREATE TABLE IF NOT EXISTS SchemaMigration (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

// 同一 isolate 内只跑一次；失败后置空，下个请求重试
let migrationPromise: Promise<void> | null = null;

async function runMigrations(env: Bindings): Promise<void> {
  // Worker 的表结构需要部署者先执行 schemas/comment.sql。
  // 表还不存在时直接跳过，避免每个请求都跑一遍注定失败的批量语句。
  const commentTable = await env.MOMO_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Comment'"
  ).first<{ name: string }>();
  if (!commentTable) {
    console.warn('[migration] Comment 表不存在，请先执行 schemas/comment.sql；本次跳过迁移');
    return;
  }

  await env.MOMO_DB.prepare(SCHEMA_MIGRATION_DDL).run();

  const { results } = await env.MOMO_DB.prepare(
    'SELECT id FROM SchemaMigration'
  ).all<{ id: string }>();
  const applied = new Set((results || []).map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    // D1 batch 是事务性的：迁移语句与记录要么全部生效，要么全部回滚
    await env.MOMO_DB.batch([
      ...migration.statements.map((sql) => env.MOMO_DB.prepare(sql)),
      env.MOMO_DB.prepare(
        'INSERT INTO SchemaMigration (id, description) VALUES (?, ?)'
      ).bind(migration.id, migration.description),
    ]);
    console.log(`[migration] applied ${migration.id}: ${migration.description}`);
  }
}

/**
 * 确保迁移已执行。失败不阻断请求（记录日志并在下个请求重试），
 * 避免一条坏迁移让整站不可用。
 */
export function ensureMigrated(env: Bindings): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runMigrations(env).catch((e) => {
      console.error('[migration] failed, will retry on next request:', e);
      migrationPromise = null;
    });
  }
  return migrationPromise;
}
