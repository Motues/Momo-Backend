-- create comment table
-- 注意：pub_date 统一为「毫秒整数」（与 Node/Go 一致），不要再写成 DATETIME/CURRENT_TIMESTAMP
CREATE TABLE IF NOT EXISTS Comment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pub_date INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    post_slug TEXT NOT NULL,
    author TEXT NOT NULL,
    email TEXT NOT NULL,
    url TEXT,
    ip_address TEXT,
    device TEXT,
    os TEXT,
    browser TEXT,
    user_agent TEXT,
    content_text TEXT NOT NULL,
    content_html TEXT NOT NULL,
    parent_id INTEGER,
    -- 默认值与 Node/Go 一致：绕过应用层的写入落在最安全的 pending
    status TEXT DEFAULT 'pending',
    -- 建立自引用外键约束（父子评论关系）
    FOREIGN KEY (parent_id) REFERENCES Comment (id) ON DELETE SET NULL
);

-- 迁移记录表（幂等启动自迁移使用，见 src/utils/migrations.ts）
CREATE TABLE IF NOT EXISTS SchemaMigration (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Settings table for web-based configuration
CREATE TABLE IF NOT EXISTS Settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- EmailVerification table for email verification
CREATE TABLE IF NOT EXISTS EmailVerification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    post_slug TEXT,
    post_title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_email ON EmailVerification(email);
CREATE INDEX IF NOT EXISTS idx_ev_token ON EmailVerification(token);

-- 可选：为常用查询字段创建索引以提高性能
CREATE INDEX IF NOT EXISTS idx_post_slug ON Comment(post_slug);
CREATE INDEX IF NOT EXISTS idx_status ON Comment(status);