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

-- VerifyRecord table：评论无感验证（人机验证）的认证记录
-- 每次认证最多三条记录（challenge / pass / fail），通过 challenge_id 串联；
-- 新库靠本文件建表，已有 D1 由启动自迁移 0002_verify_record_table / 0003_verify_record_origin 补齐
CREATE TABLE IF NOT EXISTS VerifyRecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 事件时间，Unix 毫秒整数（与 Comment.pub_date 口径一致）
    created_at INTEGER NOT NULL,
    -- challenge = 签发挑战；pass = 校验通过；fail = 校验失败
    event TEXT NOT NULL,
    reason TEXT,
    elapsed_ms INTEGER,
    difficulty INTEGER,
    challenge_id TEXT,
    post_slug TEXT,
    ip_address TEXT,
    -- 归一化后的来源域名（来源域名绑定）：未开启域名绑定时为 NULL
    origin TEXT,
    -- 以下三列仅 Cloudflare 部署有值（cf.country / cf.asOrganization / cf.asn）
    country TEXT,
    network TEXT,
    asn INTEGER
);
-- 写多读少：只建三个真正会被查询命中的索引（时间窗口 / 事件筛选 / 串起同一次认证）
CREATE INDEX IF NOT EXISTS idx_vr_created ON VerifyRecord(created_at);
CREATE INDEX IF NOT EXISTS idx_vr_event ON VerifyRecord(event);
CREATE INDEX IF NOT EXISTS idx_vr_cid ON VerifyRecord(challenge_id);

-- LinkSyncRequest table：历史链接批量更新的待确认记录（见 doc/link_security.md 第 3.3 节）
-- email 是归一化（trim + 小写）后的身份凭据；token 一次性、24 小时有效。
-- 新库靠本文件建表，已有 D1 由启动自迁移 0004_link_sync_request 补齐
CREATE TABLE IF NOT EXISTS LinkSyncRequest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    new_url TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    -- 过期时间（ISO 8601 UTC，24 小时）
    expires_at TEXT NOT NULL,
    -- 是否已确认（0/1，单次使用）
    confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lsr_email ON LinkSyncRequest(email);
CREATE INDEX IF NOT EXISTS idx_lsr_token ON LinkSyncRequest(token);

-- TrustedLink table：管理员对休眠链接的「人工确认」（见 doc/link_security.md）
-- email 是归一化（trim + 小写）后的身份凭据，url 已过 sanitizeUrl；
-- 同一 (email, url) 只保留一行（幂等 upsert），expires_at 到期后自动恢复休眠。
-- 新库靠本文件建表，已有 D1 由启动自迁移 0005_trusted_link 补齐
CREATE TABLE IF NOT EXISTS TrustedLink (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    url TEXT NOT NULL,
    -- 过期时间（ISO 8601 UTC，写入格式 YYYY-MM-DDTHH:mm:ss.sssZ）
    expires_at TEXT NOT NULL,
    -- 本次确认时刻（ISO 8601 UTC，同上格式）
    created_at TEXT NOT NULL,
    -- 确认来源：admin = 管理员在用户列表人工确认；self = 评论者本人从休眠提醒页确认。
    -- 默认 admin，旧库由启动自迁移 0006_trusted_link_source 补列。
    source TEXT NOT NULL DEFAULT 'admin'
);
-- (email, url) 唯一：upsert 依赖它；idx_tl_email 供按邮箱集合批量查询
CREATE UNIQUE INDEX IF NOT EXISTS idx_tl_email_url ON TrustedLink(email, url);
CREATE INDEX IF NOT EXISTS idx_tl_email ON TrustedLink(email);

-- MailLog table：邮件发送日志（见任务规范 §3）
-- 一次「真正尝试过的发送」= 一行；SMTP 未配置 / 邮件通知关闭导致的跳过不记录。
-- created_at 是 ISO 8601 UTC（YYYY-MM-DDTHH:mm:ss.sssZ），只保留最近 30 天。
-- 新库靠本文件建表，已有 D1 由启动自迁移 0007_mail_log 补齐
CREATE TABLE IF NOT EXISTS MailLog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- verify / link_sync / dormant_notice / comment_notify / reply_notify / test
    type TEXT NOT NULL,
    -- 收件人；多个用 ', ' 连接
    recipient TEXT NOT NULL,
    -- 实际发出的主题（模板插值后的最终字符串）
    subject TEXT NOT NULL,
    -- sent / failed
    status TEXT NOT NULL,
    -- 失败原因（成功时 NULL）
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ml_created ON MailLog(created_at);
CREATE INDEX IF NOT EXISTS idx_ml_status ON MailLog(status);

-- DormantNotice table：休眠链接提醒的状态机（见任务规范 §4）
-- email 是归一化（trim + 小写）后的身份凭据，url 是触发休眠的那个网址（逐字）。
-- 同一 (email, url) 只保留一行：重复提醒时刷新 token/expires_at/notified_at 并让 notify_count + 1。
-- 新库靠本文件建表，已有 D1 由启动自迁移 0008_dormant_notice 补齐
CREATE TABLE IF NOT EXISTS DormantNotice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    url TEXT NOT NULL,
    -- 发提醒时该邮箱「最后一条评论」的毫秒时间戳（用于区分休眠周期）
    last_comment_at INTEGER NOT NULL,
    -- 提醒页令牌（每次发信都换新的）
    token TEXT NOT NULL UNIQUE,
    -- 提醒页有效期 = 发信时刻 + link_dormant_days 天（ISO 8601 UTC）
    expires_at TEXT NOT NULL,
    -- 本次提醒时间（ISO 8601 UTC）
    notified_at TEXT NOT NULL,
    -- 该 (email, url) 累计提醒次数
    notify_count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dn_email_url ON DormantNotice(email, url);
CREATE INDEX IF NOT EXISTS idx_dn_token ON DormantNotice(token);
CREATE INDEX IF NOT EXISTS idx_dn_email ON DormantNotice(email);