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
	db, err := OpenDB(filepath.Join(t.TempDir(), "migrate.db"))
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
//
// 计数口径说明：0003_link_sync_request / 0004_trusted_link / 0006_mail_log /
// 0007_dormant_notice 都是**纯新增表**迁移（CREATE TABLE IF NOT EXISTS），在任何库上都会
// 成功并被记录；0005_trusted_link_source 是纯新增列（TrustedLink 已由 0004 建出）；
// 0001 需要 Comment 表、0002 需要 VerifyRecord 表，缺表时失败且不记录。
// 因此「只有 Comment 表」的旧库上会记录 6 条（除 0002 外全部）。

// baseMigrationCount 只建出 Comment 表时应当被记录的迁移条数
const baseMigrationCount = 6

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
		if n := schemaMigrationCount(t, db); n != baseMigrationCount {
			t.Fatalf("第 %d 次执行后迁移记录应仍为 %d 条，实际 %d 条", i+1, baseMigrationCount, n)
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
	if n := schemaMigrationCount(t, db); n != baseMigrationCount {
		t.Errorf("迁移记录应仍为 %d 条（0001 已预置，0002 缺表失败，其余成功），实际 %d 条", baseMigrationCount, n)
	}
}

// TestRunMigrationsWithoutCommentTable 单条迁移失败只记日志、不返回错误，
// 且失败的事务不得写入迁移记录（否则问题会被永久跳过）。
func TestRunMigrationsWithoutCommentTable(t *testing.T) {
	db := newMigrationDB(t)

	if err := RunMigrations(db); err != nil {
		t.Fatalf("迁移失败不应让 RunMigrations 返回错误（避免服务起不来），实际 %v", err)
	}
	// 0001 / 0002 因缺表失败不记录；0003 / 0004 / 0005 / 0006 / 0007 都能在任何库上成功
	if n := schemaMigrationCount(t, db); n != 5 {
		t.Errorf("缺表时只应记录 5 条（纯新增表 + 新增列），实际 %d 条", n)
	}

	// 补齐表结构后再次执行应成功并记录
	createLegacyCommentTable(t, db, "INTEGER")
	insertLegacyRow(t, db, 1, "2024-03-05T06:07:08.000Z")
	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if n := schemaMigrationCount(t, db); n != baseMigrationCount {
		t.Errorf("补齐表结构后应记录 %d 条迁移，实际 %d 条", baseMigrationCount, n)
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
	if n := schemaMigrationCount(t, db); n != baseMigrationCount {
		t.Errorf("空表也应记录 %d 条迁移，实际 %d 条", baseMigrationCount, n)
	}
}

// ---------------------------------------------------------------------------
// 0002_verify_record_origin
// ---------------------------------------------------------------------------

const originMigrationID = "0002_verify_record_origin"

// hasVerifyRecordColumn 判断 VerifyRecord 是否有某一列
func hasVerifyRecordColumn(t *testing.T, db *sqlx.DB, column string) bool {
	t.Helper()
	var count int
	if err := db.Get(&count,
		`SELECT COUNT(*) FROM pragma_table_info('VerifyRecord') WHERE name = ?`, column); err != nil {
		t.Fatalf("读取 VerifyRecord 表结构失败: %v", err)
	}
	return count > 0
}

// createLegacyVerifyRecordTable 建出**没有 origin 列**的旧表（本次迁移的目标形态）
func createLegacyVerifyRecordTable(t *testing.T, db *sqlx.DB) {
	t.Helper()
	ddl := `CREATE TABLE VerifyRecord (
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
	if _, err := db.Exec(ddl); err != nil {
		t.Fatalf("创建旧版 VerifyRecord 表失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO VerifyRecord (created_at, event) VALUES (1, 'challenge')`); err != nil {
		t.Fatalf("写入历史记录失败: %v", err)
	}
}

// TestRunMigrationsAddsVerifyRecordOrigin 旧库必须被幂等地补上 origin 列，
// 历史行保持 NULL（旧行为不记录来源域名），且重复执行不会报错或重复记录。
func TestRunMigrationsAddsVerifyRecordOrigin(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")
	createLegacyVerifyRecordTable(t, db)

	if hasVerifyRecordColumn(t, db, "origin") {
		t.Fatalf("前置条件：旧表不应有 origin 列")
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if !hasVerifyRecordColumn(t, db, "origin") {
		t.Fatalf("迁移后 VerifyRecord 应带上 origin 列")
	}
	if n := schemaMigrationCount(t, db); n != len(migrations) {
		t.Errorf("全部迁移都应被记录（%d 条），实际 %d 条", len(migrations), n)
	}

	// 历史行保持 NULL
	var nulls int
	if err := db.Get(&nulls, `SELECT COUNT(*) FROM VerifyRecord WHERE origin IS NULL`); err != nil {
		t.Fatalf("检查历史行失败: %v", err)
	}
	if nulls != 1 {
		t.Errorf("历史行的 origin 应为 NULL，实际满足的行数 %d", nulls)
	}
	// 新写入的行可以使用该列
	if _, err := db.Exec(`INSERT INTO VerifyRecord (created_at, event, origin) VALUES (2, 'fail', 'https://blog.example.com')`); err != nil {
		t.Fatalf("写入 origin 失败: %v", err)
	}

	// 幂等：重复执行不得报错，也不得重复记录
	for i := 0; i < 2; i++ {
		if err := RunMigrations(db); err != nil {
			t.Fatalf("第 %d 次重复执行失败: %v", i+1, err)
		}
		if n := schemaMigrationCount(t, db); n != len(migrations) {
			t.Fatalf("重复执行后迁移记录应仍为 %d 条，实际 %d 条", len(migrations), n)
		}
	}
}

// TestRunMigrationsToleratesExistingVerifyRecordOrigin 新库由建表 DDL 直接建出 origin 列，
// 随后的「补列」迁移会撞上 duplicate column name —— 必须按已应用处理，
// 否则每次启动都会重复报错（Node 端的 0002 是同样的姿态）。
func TestRunMigrationsToleratesExistingVerifyRecordOrigin(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")
	// 与 InitSchema 的新库形态一致：建表时就带 origin
	if _, err := db.Exec(`CREATE TABLE VerifyRecord (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		created_at INTEGER NOT NULL,
		event TEXT NOT NULL,
		origin TEXT
	)`); err != nil {
		t.Fatalf("创建新库形态的 VerifyRecord 表失败: %v", err)
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if n := schemaMigrationCount(t, db); n != len(migrations) {
		t.Errorf("列已存在时应按已应用处理并记录，实际 %d 条", n)
	}

	// 仍然只有一个 origin 列（没有重复补列）
	var count int
	if err := db.Get(&count, `SELECT COUNT(*) FROM pragma_table_info('VerifyRecord') WHERE name = 'origin'`); err != nil {
		t.Fatalf("统计 origin 列失败: %v", err)
	}
	if count != 1 {
		t.Errorf("origin 列应恰好一个，实际 %d 个", count)
	}
}

// ---------------------------------------------------------------------------
// 0003_link_sync_request
// ---------------------------------------------------------------------------

const linkSyncMigrationID = "0003_link_sync_request"

// tableExists 判断某个表是否存在
func tableExists(t *testing.T, db *sqlx.DB, name string) bool {
	t.Helper()
	var count int
	if err := db.Get(&count,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name); err != nil {
		t.Fatalf("查询表 %s 是否存在失败: %v", name, err)
	}
	return count > 0
}

// columnNamesOf 返回某个表的全部列名
func columnNamesOf(t *testing.T, db *sqlx.DB, table string) map[string]bool {
	t.Helper()
	var names []string
	if err := db.Select(&names, `SELECT name FROM pragma_table_info(?)`, table); err != nil {
		t.Fatalf("读取表 %s 的列失败: %v", table, err)
	}
	result := make(map[string]bool, len(names))
	for _, name := range names {
		result[name] = true
	}
	return result
}

// indexNamesOf 返回某个表的全部索引名
func indexNamesOf(t *testing.T, db *sqlx.DB, table string) map[string]bool {
	t.Helper()
	var names []string
	if err := db.Select(&names, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`, table); err != nil {
		t.Fatalf("读取表 %s 的索引失败: %v", table, err)
	}
	result := make(map[string]bool, len(names))
	for _, name := range names {
		result[name] = true
	}
	return result
}

// TestRunMigrationsCreatesLinkSyncRequest 旧库必须被补上 LinkSyncRequest 表与两个索引
func TestRunMigrationsCreatesLinkSyncRequest(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	// 前置条件：旧库里还没有这张表
	if tableExists(t, db, "LinkSyncRequest") {
		t.Fatalf("前置条件：旧库不应有 LinkSyncRequest 表")
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if !tableExists(t, db, "LinkSyncRequest") {
		t.Fatalf("迁移后应存在 LinkSyncRequest 表")
	}

	// 表结构（doc/link_security.md 第 3.3 节）
	columns := columnNamesOf(t, db, "LinkSyncRequest")
	for _, column := range []string{"id", "email", "new_url", "token", "expires_at", "confirmed", "created_at"} {
		if !columns[column] {
			t.Errorf("LinkSyncRequest 缺少列 %s（实际列：%v）", column, columns)
		}
	}

	indexes := indexNamesOf(t, db, "LinkSyncRequest")
	for _, index := range []string{"idx_lsr_email", "idx_lsr_token"} {
		if !indexes[index] {
			t.Errorf("LinkSyncRequest 缺少索引 %s（实际索引：%v）", index, indexes)
		}
	}

	// token 必须唯一
	if _, err := db.Exec(`INSERT INTO LinkSyncRequest (email, new_url, token, expires_at, created_at)
		VALUES ('a@b.com', 'https://x', 'tok', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO LinkSyncRequest (email, new_url, token, expires_at, created_at)
		VALUES ('a@b.com', 'https://y', 'tok', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`); err == nil {
		t.Errorf("token 应唯一，重复写入必须失败")
	}

	// confirmed 默认 0
	var confirmed int
	if err := db.Get(&confirmed, `SELECT confirmed FROM LinkSyncRequest WHERE token = 'tok'`); err != nil {
		t.Fatalf("读取 confirmed 失败: %v", err)
	}
	if confirmed != 0 {
		t.Errorf("confirmed 默认值应为 0，实际 %d", confirmed)
	}

	// 幂等：重复执行不得报错，也不得重复记录
	for i := 0; i < 2; i++ {
		if err := RunMigrations(db); err != nil {
			t.Fatalf("第 %d 次重复执行失败: %v", i+1, err)
		}
		if n := schemaMigrationCount(t, db); n != baseMigrationCount {
			t.Fatalf("重复执行后迁移记录应仍为 %d 条，实际 %d 条", baseMigrationCount, n)
		}
	}
}

// TestInitSchemaCreatesLinkSyncRequest 新库由 InitSchema 直接建出该表，
// 随后的迁移是空操作（CREATE TABLE IF NOT EXISTS）—— 必须成功并记录。
func TestInitSchemaCreatesLinkSyncRequest(t *testing.T) {
	db := newMigrationDB(t)

	if err := InitSchema(db); err != nil {
		t.Fatalf("InitSchema 失败: %v", err)
	}
	if !tableExists(t, db, "LinkSyncRequest") {
		t.Fatalf("InitSchema 应建出 LinkSyncRequest 表")
	}

	// 全部迁移都应记录（新库上 0002 命中的是 duplicate column name 分支，
	// 0003 命中的是 IF NOT EXISTS 空操作，两者都按已应用处理）
	if n := schemaMigrationCount(t, db); n != len(migrations) {
		t.Errorf("新库应记录全部 %d 条迁移，实际 %d 条", len(migrations), n)
	}

	// 再跑一次不会产生重复表或额外记录
	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if n := schemaMigrationCount(t, db); n != len(migrations) {
		t.Errorf("重复执行后迁移记录应仍为 %d 条，实际 %d 条", len(migrations), n)
	}
}

// ---------------------------------------------------------------------------
// 0004_trusted_link
// ---------------------------------------------------------------------------

const trustedLinkMigrationID = "0004_trusted_link"

// TestRunMigrationsCreatesTrustedLink 旧库必须被补上 TrustedLink 表与两个索引，
// 且 (email, url) 唯一（幂等 upsert 的 ON CONFLICT 目标）。
func TestRunMigrationsCreatesTrustedLink(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	// 前置条件：旧库里还没有这张表
	if tableExists(t, db, "TrustedLink") {
		t.Fatalf("前置条件：旧库不应有 TrustedLink 表")
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if !tableExists(t, db, "TrustedLink") {
		t.Fatalf("迁移后应存在 TrustedLink 表")
	}

	// 表结构（规范第 2 节）
	columns := columnNamesOf(t, db, "TrustedLink")
	for _, column := range []string{"id", "email", "url", "expires_at", "created_at"} {
		if !columns[column] {
			t.Errorf("TrustedLink 缺少列 %s（实际列：%v）", column, columns)
		}
	}

	indexes := indexNamesOf(t, db, "TrustedLink")
	for _, index := range []string{"idx_tl_email_url", "idx_tl_email"} {
		if !indexes[index] {
			t.Errorf("TrustedLink 缺少索引 %s（实际索引：%v）", index, indexes)
		}
	}

	// (email, url) 唯一：同一对重复写入必须失败
	const insert = `INSERT INTO TrustedLink (email, url, expires_at, created_at)
		VALUES (?, ?, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`
	if _, err := db.Exec(insert, "a@b.com", "https://a.example.com"); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if _, err := db.Exec(insert, "a@b.com", "https://a.example.com"); err == nil {
		t.Errorf("(email, url) 应唯一，重复写入必须失败")
	}
	// 同一邮箱的不同网址、同一网址的不同邮箱都各占一行
	if _, err := db.Exec(insert, "a@b.com", "https://other.example.com"); err != nil {
		t.Errorf("同一邮箱的不同网址应可各写一行: %v", err)
	}
	if _, err := db.Exec(insert, "c@d.com", "https://a.example.com"); err != nil {
		t.Errorf("同一网址的不同邮箱应可各写一行: %v", err)
	}

	// 幂等：重复执行不得报错，也不得重复记录
	for i := 0; i < 2; i++ {
		if err := RunMigrations(db); err != nil {
			t.Fatalf("第 %d 次重复执行失败: %v", i+1, err)
		}
		if n := schemaMigrationCount(t, db); n != baseMigrationCount {
			t.Fatalf("重复执行后迁移记录应仍为 %d 条，实际 %d 条", baseMigrationCount, n)
		}
	}
}

// TestInitSchemaCreatesTrustedLink 新库由 InitSchema 直接建出该表，
// 随后的迁移是空操作（CREATE TABLE IF NOT EXISTS）—— 必须成功并记录。
func TestInitSchemaCreatesTrustedLink(t *testing.T) {
	db := newMigrationDB(t)

	if err := InitSchema(db); err != nil {
		t.Fatalf("InitSchema 失败: %v", err)
	}
	if !tableExists(t, db, "TrustedLink") {
		t.Fatalf("InitSchema 应建出 TrustedLink 表")
	}
	if n := schemaMigrationCount(t, db); n != len(migrations) {
		t.Errorf("新库应记录全部 %d 条迁移，实际 %d 条", len(migrations), n)
	}

	// 唯一索引必须被建出来（否则 upsert 的 ON CONFLICT 会报错）
	if _, err := db.Exec(`INSERT INTO TrustedLink (email, url, expires_at, created_at)
		VALUES ('a@b.com', 'https://a.example.com', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')
		ON CONFLICT(email, url) DO UPDATE SET expires_at = excluded.expires_at`); err != nil {
		t.Fatalf("ON CONFLICT(email, url) 应命中唯一索引: %v", err)
	}
}

// TestTrustedLinkMigrationIsDeclared 0004 的声明必须与迁移表一致（ID 不可改，只能新增）
func TestTrustedLinkMigrationIsDeclared(t *testing.T) {
	var declared *Migration
	for i := range migrations {
		if migrations[i].ID == trustedLinkMigrationID {
			declared = &migrations[i]
			break
		}
	}
	if declared == nil {
		t.Fatalf("代码中找不到迁移 %s", trustedLinkMigrationID)
	}
	if declared.Description == "" {
		t.Errorf("迁移 %s 的描述不应为空", trustedLinkMigrationID)
	}
	if len(declared.Statements) == 0 {
		t.Errorf("迁移 %s 应有至少一条语句", trustedLinkMigrationID)
	}
}

// ---------------------------------------------------------------------------
// 0005_trusted_link_source / 0006_mail_log / 0007_dormant_notice
// ---------------------------------------------------------------------------

const trustedLinkSourceMigrationID = "0005_trusted_link_source"

// createLegacyTrustedLinkTable 建出**没有 source 列**的旧表（0005 的目标形态）
func createLegacyTrustedLinkTable(t *testing.T, db *sqlx.DB) {
	t.Helper()
	if _, err := db.Exec(`CREATE TABLE TrustedLink (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL,
		url TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`); err != nil {
		t.Fatalf("创建旧版 TrustedLink 表失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO TrustedLink (email, url, expires_at, created_at)
		VALUES ('a@b.com', 'https://a.example.com', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`); err != nil {
		t.Fatalf("写入历史记录失败: %v", err)
	}
}

// TestRunMigrationsAddsTrustedLinkSource 旧库必须被补上 source 列，历史行默认为 admin
// （历史记录都是管理员在后台点出来的）。
func TestRunMigrationsAddsTrustedLinkSource(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")
	createLegacyTrustedLinkTable(t, db)

	if columnNamesOf(t, db, "TrustedLink")["source"] {
		t.Fatalf("前置条件：旧表不应有 source 列")
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if !columnNamesOf(t, db, "TrustedLink")["source"] {
		t.Fatalf("迁移后 TrustedLink 应带上 source 列")
	}

	var source string
	if err := db.Get(&source, `SELECT source FROM TrustedLink WHERE email = 'a@b.com'`); err != nil {
		t.Fatalf("读取历史行的 source 失败: %v", err)
	}
	if source != "admin" {
		t.Errorf("历史行的 source 默认值应为 admin，实际 %q", source)
	}

	// 幂等：重复执行不得报错，也不得重复记录
	for i := 0; i < 2; i++ {
		if err := RunMigrations(db); err != nil {
			t.Fatalf("第 %d 次重复执行失败: %v", i+1, err)
		}
		if n := schemaMigrationCount(t, db); n != baseMigrationCount {
			t.Fatalf("重复执行后迁移记录应仍为 %d 条，实际 %d 条", baseMigrationCount, n)
		}
	}

	// 声明必须存在且描述非空
	var declared *Migration
	for i := range migrations {
		if migrations[i].ID == trustedLinkSourceMigrationID {
			declared = &migrations[i]
			break
		}
	}
	if declared == nil {
		t.Fatalf("代码中找不到迁移 %s", trustedLinkSourceMigrationID)
	}
	if declared.Description == "" || len(declared.Statements) == 0 {
		t.Errorf("迁移 %s 的声明不完整: %+v", trustedLinkSourceMigrationID, declared)
	}
}

const mailLogMigrationID = "0006_mail_log"

// TestRunMigrationsCreatesMailLog 旧库必须被补上 MailLog 表与两个索引
func TestRunMigrationsCreatesMailLog(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	if tableExists(t, db, "MailLog") {
		t.Fatalf("前置条件：旧库不应有 MailLog 表")
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if !tableExists(t, db, "MailLog") {
		t.Fatalf("迁移后应存在 MailLog 表")
	}

	columns := columnNamesOf(t, db, "MailLog")
	for _, column := range []string{"id", "type", "recipient", "subject", "status", "error", "created_at"} {
		if !columns[column] {
			t.Errorf("MailLog 缺少列 %s（实际列：%v）", column, columns)
		}
	}

	indexes := indexNamesOf(t, db, "MailLog")
	for _, index := range []string{"idx_ml_created", "idx_ml_status"} {
		if !indexes[index] {
			t.Errorf("MailLog 缺少索引 %s（实际索引：%v）", index, indexes)
		}
	}

	// error 允许为 NULL（成功行），created_at 必填
	if _, err := db.Exec(`INSERT INTO MailLog (type, recipient, subject, status, created_at)
		VALUES ('test', 'a@b.com', 's', 'sent', '2026-01-01T00:00:00.000Z')`); err != nil {
		t.Fatalf("写入成功行失败: %v", err)
	}
	var nullErrors int
	if err := db.Get(&nullErrors, `SELECT COUNT(*) FROM MailLog WHERE error IS NULL`); err != nil {
		t.Fatalf("统计空 error 失败: %v", err)
	}
	if nullErrors != 1 {
		t.Errorf("成功行的 error 应为 NULL，实际满足的行数 %d", nullErrors)
	}

	var declared *Migration
	for i := range migrations {
		if migrations[i].ID == mailLogMigrationID {
			declared = &migrations[i]
			break
		}
	}
	if declared == nil || declared.Description == "" {
		t.Fatalf("代码中缺少迁移 %s 的声明", mailLogMigrationID)
	}
}

const dormantNoticeMigrationID = "0007_dormant_notice"

// TestRunMigrationsCreatesDormantNotice 旧库必须被补上 DormantNotice 表与三个索引，
// 且 token 唯一、(email, url) 唯一（upsert 的 ON CONFLICT 目标）。
func TestRunMigrationsCreatesDormantNotice(t *testing.T) {
	db := newMigrationDB(t)
	createLegacyCommentTable(t, db, "INTEGER")

	if tableExists(t, db, "DormantNotice") {
		t.Fatalf("前置条件：旧库不应有 DormantNotice 表")
	}

	if err := RunMigrations(db); err != nil {
		t.Fatalf("RunMigrations 失败: %v", err)
	}
	if !tableExists(t, db, "DormantNotice") {
		t.Fatalf("迁移后应存在 DormantNotice 表")
	}

	columns := columnNamesOf(t, db, "DormantNotice")
	for _, column := range []string{
		"id", "email", "url", "last_comment_at", "token", "expires_at", "notified_at", "notify_count",
	} {
		if !columns[column] {
			t.Errorf("DormantNotice 缺少列 %s（实际列：%v）", column, columns)
		}
	}

	indexes := indexNamesOf(t, db, "DormantNotice")
	for _, index := range []string{"idx_dn_email_url", "idx_dn_token", "idx_dn_email"} {
		if !indexes[index] {
			t.Errorf("DormantNotice 缺少索引 %s（实际索引：%v）", index, indexes)
		}
	}

	const insert = `INSERT INTO DormantNotice (email, url, last_comment_at, token, expires_at, notified_at)
		VALUES ('a@b.com', 'https://a.example.com', 1, ?, '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
	if _, err := db.Exec(insert, "tok-1"); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if _, err := db.Exec(insert, "tok-2"); err == nil {
		t.Errorf("(email, url) 应唯一，重复写入必须失败")
	}
	if _, err := db.Exec(`INSERT INTO DormantNotice (email, url, last_comment_at, token, expires_at, notified_at)
		VALUES ('c@d.com', 'https://c.example.com', 1, 'tok-1', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`); err == nil {
		t.Errorf("token 应唯一，重复写入必须失败")
	}

	// notify_count 默认 1
	var count int
	if err := db.Get(&count, `SELECT notify_count FROM DormantNotice WHERE token = 'tok-1'`); err != nil {
		t.Fatalf("读取 notify_count 失败: %v", err)
	}
	if count != 1 {
		t.Errorf("notify_count 默认值应为 1，实际 %d", count)
	}

	// ON CONFLICT(email, url) 必须命中唯一索引，且 notify_count 自增
	if _, err := db.Exec(`INSERT INTO DormantNotice (email, url, last_comment_at, token, expires_at, notified_at)
		VALUES ('a@b.com', 'https://a.example.com', 2, 'tok-3', '2030-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
		ON CONFLICT(email, url) DO UPDATE SET notify_count = DormantNotice.notify_count + 1`); err != nil {
		t.Fatalf("ON CONFLICT(email, url) 应命中唯一索引: %v", err)
	}
	if err := db.Get(&count, `SELECT notify_count FROM DormantNotice WHERE token = 'tok-1'`); err != nil {
		t.Fatalf("读取 notify_count 失败: %v", err)
	}
	if count != 2 {
		t.Errorf("重复写入后 notify_count 应自增为 2，实际 %d", count)
	}

	var declared *Migration
	for i := range migrations {
		if migrations[i].ID == dormantNoticeMigrationID {
			declared = &migrations[i]
			break
		}
	}
	if declared == nil || declared.Description == "" {
		t.Fatalf("代码中缺少迁移 %s 的声明", dormantNoticeMigrationID)
	}
}
