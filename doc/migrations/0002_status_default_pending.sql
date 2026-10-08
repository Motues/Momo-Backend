-- 0002_status_default_pending.sql
--
-- 背景（C11）：Worker / Go 的 Comment.status 列默认值是 'approved'，Node 是 'pending'。
-- 三端代码与 DDL 现已统一为 'pending'（最安全的默认值），但 SQLite 无法直接修改列默认值，
-- 已有库必须重建表才能生效。
--
-- ⚠️ 本脚本会重建 Comment 表（DROP + RENAME），**执行前必须备份数据库**。
--    应用层的插入语句都会显式写入 status，因此不执行本脚本也不会影响正常使用，
--    只有「绕过应用层直接 INSERT 且不带 status」的场景才会看到差异。
--
-- 执行方式见 doc/migrations/README.md。
-- 幂等性：重建后 status 默认值已是 'pending'，重复执行只会再复制一次数据（结果相同）。

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE Comment_new (
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
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (parent_id) REFERENCES Comment (id) ON DELETE SET NULL
);

-- 显式列出列名：三端历史版本的列顺序不同（Node 把 os/user_agent 放在末尾）
INSERT INTO Comment_new (
    id, pub_date, post_slug, author, email, url, ip_address,
    device, os, browser, user_agent, content_text, content_html, parent_id, status
)
SELECT
    id, pub_date, post_slug, author, email, url, ip_address,
    device, os, browser, user_agent, content_text, content_html, parent_id, status
FROM Comment;

DROP TABLE Comment;
ALTER TABLE Comment_new RENAME TO Comment;

CREATE INDEX IF NOT EXISTS idx_post_slug ON Comment(post_slug);
CREATE INDEX IF NOT EXISTS idx_status ON Comment(status);

COMMIT;
PRAGMA foreign_keys = ON;
