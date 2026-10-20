package sqlite

import (
	"log"
	"strings"

	"github.com/jmoiron/sqlx"
)

// Migration 幂等启动自迁移的一条记录（C7）。
//
// 约定：
//   - 迁移只在首次出现时执行一次，执行记录写入 SchemaMigration 表；
//   - ID 一旦发布不可修改（改动等于新增一条迁移）；
//   - 这里只放**非破坏性**迁移（数据归一化、补索引等）。需要重建表的结构变更
//     （例如修改列默认值）请见 doc/migrations/ 下的一次性 SQL 脚本。
type Migration struct {
	ID          string
	Description string
	Statements  []string
}

var migrations = []Migration{
	{
		ID:          "0001_pub_date_to_millis",
		Description: "将 pub_date 从 ISO 字符串统一为毫秒整数（与 Node/Worker 对齐）",
		Statements: []string{
			`UPDATE Comment
			    SET pub_date = CASE
			        WHEN pub_date NOT GLOB '*[^0-9]*' AND CAST(pub_date AS INTEGER) > 0
			          THEN CAST(pub_date AS INTEGER)
			        WHEN CAST(strftime('%s', pub_date) AS INTEGER) > 0
			          THEN CAST(strftime('%s', pub_date) AS INTEGER) * 1000
			        ELSE pub_date
			      END
			    WHERE typeof(pub_date) = 'text'`,
		},
	},
	{
		ID:          "0002_verify_record_origin",
		Description: "VerifyRecord 增加 origin 列（来源域名绑定：记录解题/被拒的来源域名）",
		// 纯新增列，旧行为 NULL；新库由 InitSchema 的建表 DDL 直接建出该列
		Statements: []string{
			`ALTER TABLE VerifyRecord ADD COLUMN origin TEXT`,
		},
	},
	{
		ID:          "0003_link_sync_request",
		Description: "新增 LinkSyncRequest 表（历史链接批量更新的待确认记录，见 doc/link_security.md 第 3.3 节）",
		// 纯新增表：CREATE TABLE IF NOT EXISTS 在旧库上补表，在新库上（InitSchema 已建出）
		// 是空操作 —— 因此这条迁移在任何库上都会成功并被记录。
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS LinkSyncRequest (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				email TEXT NOT NULL,
				new_url TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE,
				expires_at TEXT NOT NULL,
				confirmed INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS idx_lsr_email ON LinkSyncRequest(email)`,
			`CREATE INDEX IF NOT EXISTS idx_lsr_token ON LinkSyncRequest(token)`,
		},
	},
	{
		ID:          "0004_trusted_link",
		Description: "新增 TrustedLink 表（休眠链接的人工确认，见 doc/link_security.md 第 4 节）",
		// 纯新增表：CREATE TABLE IF NOT EXISTS 在旧库上补表，在新库上（InitSchema 已建出）
		// 是空操作 —— 因此这条迁移在任何库上都会成功并被记录。
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS TrustedLink (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				email TEXT NOT NULL,
				url TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_tl_email_url ON TrustedLink(email, url)`,
			`CREATE INDEX IF NOT EXISTS idx_tl_email ON TrustedLink(email)`,
		},
	},
	{
		ID:          "0005_trusted_link_source",
		Description: "TrustedLink 增加 source 列（admin 管理员确认 / self 本人从提醒邮件确认）",
		// 纯新增列：旧库上的历史记录都是管理员点出来的，默认 'admin'；新库由 InitSchema 直接建出。
		// 与 0002 一样，新库上会撞上 duplicate column name，按已应用处理。
		Statements: []string{
			`ALTER TABLE TrustedLink ADD COLUMN source TEXT NOT NULL DEFAULT 'admin'`,
		},
	},
	{
		ID:          "0006_mail_log",
		Description: "新增 MailLog 表（邮件发送日志，见 doc/mail.md）",
		// 纯新增表：CREATE TABLE IF NOT EXISTS 在旧库上补表，在新库上是空操作。
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS MailLog (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT NOT NULL,
				recipient TEXT NOT NULL,
				subject TEXT NOT NULL,
				status TEXT NOT NULL,
				error TEXT,
				created_at TEXT NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS idx_ml_created ON MailLog(created_at)`,
			`CREATE INDEX IF NOT EXISTS idx_ml_status ON MailLog(status)`,
		},
	},
	{
		ID:          "0007_dormant_notice",
		Description: "新增 DormantNotice 表（休眠链接提醒的状态机）",
		// 纯新增表：CREATE TABLE IF NOT EXISTS 在旧库上补表，在新库上是空操作。
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS DormantNotice (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				email TEXT NOT NULL,
				url TEXT NOT NULL,
				last_comment_at INTEGER NOT NULL,
				token TEXT NOT NULL UNIQUE,
				expires_at TEXT NOT NULL,
				notified_at TEXT NOT NULL,
				notify_count INTEGER NOT NULL DEFAULT 1
			)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_dn_email_url ON DormantNotice(email, url)`,
			`CREATE INDEX IF NOT EXISTS idx_dn_token ON DormantNotice(token)`,
			`CREATE INDEX IF NOT EXISTS idx_dn_email ON DormantNotice(email)`,
		},
	},
}

const schemaMigrationDDL = `
	CREATE TABLE IF NOT EXISTS SchemaMigration (
		id TEXT PRIMARY KEY,
		description TEXT NOT NULL DEFAULT '',
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`

// RunMigrations 执行所有尚未应用的迁移。
// 单条迁移失败只记录日志、不返回错误，避免一条坏迁移让服务起不来。
func RunMigrations(db *sqlx.DB) error {
	if _, err := db.Exec(schemaMigrationDDL); err != nil {
		return err
	}

	var appliedIDs []string
	if err := db.Select(&appliedIDs, "SELECT id FROM SchemaMigration"); err != nil {
		return err
	}
	applied := make(map[string]bool, len(appliedIDs))
	for _, id := range appliedIDs {
		applied[id] = true
	}

	for _, m := range migrations {
		if applied[m.ID] {
			continue
		}

		if err := applyMigration(db, m); err != nil {
			log.Printf("[migration] failed %s: %v", m.ID, err)
			continue
		}
		log.Printf("[migration] applied %s: %s", m.ID, m.Description)
	}

	return nil
}

// applyMigration 在单个事务内执行迁移语句并写入记录：要么全部生效，要么全部回滚。
//
// 「补列」类迁移（ALTER TABLE ... ADD COLUMN）在新库上必然撞上 duplicate column name
// —— 建表 DDL 已经把列建出来了。那说明目标状态已经达成，按已应用处理，否则每次
// 启动都会重复报错（Node 端的 0002 迁移是同样的姿态）。
func applyMigration(db *sqlx.DB, m Migration) error {
	tx, err := db.Beginx()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for _, stmt := range m.Statements {
		if _, err := tx.Exec(stmt); err != nil {
			if isDuplicateColumnError(err) {
				continue
			}
			return err
		}
	}
	if _, err := tx.Exec(
		"INSERT INTO SchemaMigration (id, description) VALUES (?, ?)", m.ID, m.Description,
	); err != nil {
		return err
	}

	return tx.Commit()
}

// isDuplicateColumnError 判断错误是否为「列已存在」（SQLite: duplicate column name: X）
func isDuplicateColumnError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "duplicate column name")
}
