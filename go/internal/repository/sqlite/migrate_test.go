package sqlite

import (
	"path/filepath"
	"testing"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

// ---------------------------------------------------------------------------
// 迁移测试辅助
// ---------------------------------------------------------------------------

const migrationID = "0001_pub_date_to_millis"

// newMigrationDB 创建一个只有 Comment 表的临时库（用于单独验证 RunMigrations）
func newMigrationDB(t *testing.T) *sqlx.DB {
	t.Helper()
	db, err := sqlx.Connect("sqlite", filepath.Join(t.TempDir(), "migrate.db"))
	if err != nil {
		t.Fatalf("连接测试数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// createLegacyCommentTable 建表，pubDateType 可指定为 "TEXT"（旧版 schema，ISO 字符串）
// 或 "INTEGER"（当前 schema，毫秒整数），用于验证两种亲和性下的迁移行为。
func createLegacyCommentTable(t *testing.T, db *sqlx.DB, pubDateType string) {
	t.Helper()
	ddl := `CREATE TABLE Comment (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		pub_date ` + pubDateType + `,
		post_slug TEXT NOT NULL,
		author TEXT NOT NULL,
		email TEXT NOT NULL,
		content_text TEXT NOT NULL,
		content_html TEXT NOT NULL,
		status TEXT DEFAULT 'pending',
		parent_id INTEGER
	)`
	if _, err := db.Exec(ddl); err != nil {
		t.Fatalf("创建 Comment 表失败: %v", err)
	}
}

// insertLegacyRow 插入一行历史数据
func insertLegacyRow(t *testing.T, db *sqlx.DB, id int, pubDate interface{}) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO Comment (id, pub_date, post_slug, author, email, content_text, content_html, status)
		VALUES (?, ?, '/legacy', 'n', 'e@x.com', 't', 'h', 'approved')`, id, pubDate); err != nil {
		t.Fatalf("插入历史数据失败 (id=%d, pub_date=%#v): %v", id, pubDate, err)
	}
}

// pubDateOf 读取某行的 pub_date 文本值与 SQLite 类型
func pubDateOf(t *testing.T, db *sqlx.DB, id int) (value string, typeOf string) {
	t.Helper()
	type row struct {
		Value string `db:"value"`
		Type  string `db:"tp"`
	}
	var got row
	if err := db.Get(&got, "SELECT CAST(pub_date AS TEXT) AS value, typeof(pub_date) AS tp FROM Comment WHERE id = ?", id); err != nil {
		t.Fatalf("读取 id=%d 的 pub_date 失败: %v", id, err)
	}
	return got.Value, got.Type
}

func schemaMigrationCount(t *testing.T, db *sqlx.DB) int {
	t.Helper()
	var n int
	if err := db.Get(&n, "SELECT COUNT(*) FROM SchemaMigration"); err != nil {
		t.Fatalf("统计迁移记录失败: %v", err)
	}
	return n
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

// TestRunMigrationsConvertsISODateStringsToMillis 覆盖当前 schema（INTEGER 亲和性）：
// ISO 字符串必须被改写为毫秒整数，且数值列不受影响。
func TestRunMigrationsConvertsISODateStringsToMillis(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	insertLegacyRow(t, db, 1, "2024-03-05T06:07:08.000Z") // 1709618828 秒
	insertLegacyRow(t, db, 2, "2024-03-05 06:07:08")      // 同上
	insertLegacyRow(t, db, 3, "2024-03-05")               // 1709596800 秒
	insertLegacyRow(t, db, 4, "2026-01-02T03:04:05.000Z")
	insertLegacyRow(t, db, 5, int64(1712345678901)) // 已是毫秒整数
	insertLegacyRow(t, db, 6, "not-a-date")         // 无法解析

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}

	for _, tc := range []struct {
		id       int
		wantVal  string
		wantType string
		desc     string
	}{
		{1, "1709618828000", "integer", "ISO（带 Z）转换为毫秒整数"},
		{2, "1709618828000", "integer", "ISO（空格分隔）转换为毫秒整数"},
		{3, "1709596800000", "integer", "纯日期按当日 00:00:00 UTC 转换"},
		{4, "1767323045000", "integer", "另一条 ISO 转换"},
		{5, "1712345678901", "integer", "已是整数则保持不变"},
		{6, "not-a-date", "text", "无法解析的值原样保留"},
	} {
		gotVal, gotType := pubDateOf(t, db, tc.id)
		if gotVal != tc.wantVal {
			t.Errorf("id=%d %s：值期望 %q，实际 %q", tc.id, tc.desc, tc.wantVal, gotVal)
		}
		if gotType != tc.wantType {
			t.Errorf("id=%d %s：类型期望 %s，实际 %s", tc.id, tc.desc, tc.wantType, gotType)
		}
	}
}

// TestRunMigrationsLegacyTextColumn 覆盖旧 schema（TEXT 亲和性）：
// 值必须被归一化为毫秒，不可解析的值保持原样。
func TestRunMigrationsLegacyTextColumn(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "TEXT")

	insertLegacyRow(t, db, 1, "1712345678901") // 数字字符串（毫秒）不应被放大
	insertLegacyRow(t, db, 2, "2024-03-05T06:07:08.000Z")
	insertLegacyRow(t, db, 3, int64(1712345678901)) // TEXT 亲和性下会被存成文本
	insertLegacyRow(t, db, 4, "not-a-date")
	insertLegacyRow(t, db, 5, "0")
	insertLegacyRow(t, db, 6, "")

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}

	for _, tc := range []struct {
		id      int
		wantVal string
		desc    string
	}{
		{1, "1712345678901", "数字字符串保持原值（不得再 ×1000）"},
		{2, "1709618828000", "ISO 字符串转换为毫秒"},
		{3, "1712345678901", "整数值在文本列中仍是同一数值"},
		{4, "not-a-date", "无法解析的值保持原样"},
		{5, "0", "0 保持原样（不视为有效时间）"},
		{6, "", "空串保持原样"},
	} {
		gotVal, _ := pubDateOf(t, db, tc.id)
		if gotVal != tc.wantVal {
			t.Errorf("id=%d %s：值期望 %q，实际 %q", tc.id, tc.desc, tc.wantVal, gotVal)
		}
	}
}

// TestRunMigrationsIsIdempotent 迁移只应生效一次：重复执行不得再放大时间戳
func TestRunMigrationsIsIdempotent(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")
	insertLegacyRow(t, db, 1, "2024-03-05T06:07:08.000Z")
	insertLegacyRow(t, db, 2, "1712345678901")

	for i := 0; i < 3; i++ {
		if err := RunMigrations(db); err != nil {
			t.Fatalf("第 %d 次 RunMigrations 失败: %v", i+1, err)
		}
		if n := schemaMigrationCount(t, db); n != 1 {
			t.Fatalf("第 %d 次执行后迁移记录应仍为 1 条，实际 %d 条", i+1, n)
		}
	}

	if got, _ := pubDateOf(t, db, 1); got != "1709618828000" {
		t.Errorf("重复执行后值不应再次放大，实际 %q", got)
	}
	if got, _ := pubDateOf(t, db, 2); got != "1712345678901" {
		t.Errorf("重复执行后毫秒值不应变化，实际 %q", got)
	}
}

// TestRunMigrationsSkipsAppliedMigration 已记录的迁移必须被跳过
func TestRunMigrationsSkipsAppliedMigration(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")
	insertLegacyRow(t, db, 1, "2024-03-05T06:07:08.000Z")

	// 手动建表并写入迁移记录，模拟“迁移已应用过”
	if _, err := db.Exec(schemaMigrationDDL); err != nil {
		t.Fatalf("创建 SchemaMigration 表失败: %v", err)
	}
	if _, err := db.Exec("INSERT INTO SchemaMigration (id, description) VALUES (?, ?)", migrationID, "已应用"); err != nil {
		t.Fatalf("写入迁移记录失败: %v", err)
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}

	if got, _ := pubDateOf(t, db, 1); got != "2024-03-05T06:07:08.000Z" {
		t.Errorf("已记录的迁移不应再次执行，实际值 %q", got)
	}
	if n := schemaMigrationCount(t, db); n != 1 {
		t.Errorf("迁移记录应仍为 1 条，实际 %d 条", n)
	}
}

// TestRunMigrationsWithoutCommentTable 单条迁移失败只记日志、不返回错误，
// 且失败的事务不得写入迁移记录（否则问题会被永久跳过）。
func TestRunMigrationsWithoutCommentTable(t *testing.T) {
	db := newMigrationDB(t)

	if err := RunMigrations(db); err != nil {
		t.Fatalf("迁移失败不应让 RunMigrations 返回错误（避免服务起不来），实际 %v", err)
	}
	if n := schemaMigrationCount(t, db); n != 0 {
		t.Errorf("迁移语句失败时不应记录为已应用，实际 %d 条", n)
	}

	// 补齐表结构后再次执行应成功并记录
	createLegacyCommentTable(t, db, "INTEGER")
	insertLegacyRow(t, db, 1, "2024-03-05T06:07:08.000Z")
	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if n := schemaMigrationCount(t, db); n != 1 {
		t.Errorf("补齐表结构后应记录 1 条迁移，实际 %d 条", n)
	}
	if got, _ := pubDateOf(t, db, 1); got != "1709618828000" {
		t.Errorf("补齐表结构后迁移应生效，实际 %q", got)
	}
}

// TestRunMigrationsRecordsMetadata 迁移记录应包含 ID、描述与应用时间
func TestRunMigrationsRecordsMetadata(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}

	type row struct {
		ID          string `db:"id"`
		Description string `db:"description"`
		AppliedAt   string `db:"applied_at"`
	}
	var got row
	if err := db.Get(&got, "SELECT id, description, applied_at FROM SchemaMigration WHERE id = ?", migrationID); err != nil {
		t.Fatalf("读取迁移记录失败: %v", err)
	}
	if got.ID != migrationID {
		t.Errorf("迁移 ID 期望 %q，实际 %q", migrationID, got.ID)
	}
	if got.Description == "" {
		t.Errorf("迁移描述不应为空")
	}
	if got.AppliedAt == "" {
		t.Errorf("applied_at 不应为空")
	}

	// 与代码中声明的迁移一致
	var declared *Migration
	for i := range migrations {
		if migrations[i].ID == migrationID {
			declared = &migrations[i]
			break
		}
	}
	if declared == nil {
		t.Fatalf("代码中找不到迁移 %s", migrationID)
	}
	if got.Description != declared.Description {
		t.Errorf("记录中的描述应为 %q，实际 %q", declared.Description, got.Description)
	}
	if len(declared.Statements) == 0 {
		t.Errorf("迁移 %s 应有至少一条语句", migrationID)
	}
}

// TestRunMigrationsKeepsNumericValuesUnscaled 保证毫秒整数不会被再次 ×1000
func TestRunMigrationsKeepsNumericValuesUnscaled(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	const ms = int64(1712345678901)
	insertLegacyRow(t, db, 1, ms)

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if got, gotType := pubDateOf(t, db, 1); got != "1712345678901" || gotType != "integer" {
		t.Errorf("数值毫秒必须保持不变，实际值 %q 类型 %s", got, gotType)
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if got, _ := pubDateOf(t, db, 1); got != "1712345678901" {
		t.Errorf("二次执行后数值不应被放大 1000 倍，实际 %q", got)
	}
}

// TestRunMigrationsOnEmptyLegacyTable 空表也应完成迁移并记录
func TestRunMigrationsOnEmptyLegacyTable(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if n := schemaMigrationCount(t, db); n != 1 {
		t.Errorf("空表也应记录 1 条迁移，实际 %d 条", n)
	}
}
