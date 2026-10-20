package sqlite

import (
	"context"
	"testing"
	"time"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"

	"github.com/jmoiron/sqlx"
)

/*
仓库层：人工确认（TrustedLink，见 doc/link_security.md 第 4 节）。

覆盖幂等 upsert（同一 (email, url) 只留一行并刷新时间）、删除的行数语义，
以及读取路径的「一次分组查询取回未过期确认」（键 = 归一化邮箱 + 逐字网址）。
*/

// seededTrustTime / seededTrustMs 固定的「现在」：2026-11-01T00:00:00.000Z
const (
	seededTrustTime = "2026-11-01T00:00:00.000Z"
	seededTrustMs   = int64(1793491200000)
)

// trustMillis 把人工确认的 ISO 串解析回毫秒（测试里构造「恰好等于 now」这类边界）
func trustMillis(t *testing.T, expiresAt string) int64 {
	t.Helper()
	parsed, err := time.Parse(utils.TrustTimeLayout, expiresAt)
	if err != nil {
		t.Fatalf("解析 %q 失败: %v", expiresAt, err)
	}
	return parsed.UnixMilli()
}

// trustedLinkRowCount 统计某个邮箱下的 TrustedLink 行数
func trustedLinkRowCount(t *testing.T, db *sqlx.DB, email string) int {
	t.Helper()
	var n int
	if err := db.Get(&n, "SELECT COUNT(*) FROM TrustedLink WHERE email = ?", email); err != nil {
		t.Fatalf("统计 TrustedLink 失败: %v", err)
	}
	return n
}

// TestUpsertTrustedLinkInsertsAndRefreshes 幂等 upsert：首次插入，第二次只刷新时间不新增行
func TestUpsertTrustedLinkInsertsAndRefreshes(t *testing.T) {
	db, repo := newTestRepo(t)
	ctx := context.Background()

	first := &model.TrustedLink{
		Email:     "a@b.com",
		URL:       "https://a.example.com",
		ExpiresAt: "2026-12-01T00:00:00.000Z",
		CreatedAt: seededTrustTime,
		Source:    model.TrustedLinkSourceAdmin,
	}
	if err := repo.UpsertTrustedLink(ctx, first); err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}

	var row model.TrustedLink
	if err := db.Get(&row, "SELECT * FROM TrustedLink WHERE email = ?", "a@b.com"); err != nil {
		t.Fatalf("读取记录失败: %v", err)
	}
	if row.ID <= 0 || row.URL != first.URL || row.ExpiresAt != first.ExpiresAt || row.CreatedAt != first.CreatedAt {
		t.Errorf("首次写入的字段不正确: %+v", row)
	}
	if row.Source != model.TrustedLinkSourceAdmin {
		t.Errorf("首次写入的 source 期望 admin，实际 %q", row.Source)
	}
	firstID := row.ID

	// 同一 (email, url) 再次确认：刷新 expires_at / created_at / source，不新增行
	second := &model.TrustedLink{
		Email:     "a@b.com",
		URL:       "https://a.example.com",
		ExpiresAt: "2027-01-01T00:00:00.000Z",
		CreatedAt: "2026-11-20T00:00:00.000Z",
		Source:    model.TrustedLinkSourceSelf,
	}
	if err := repo.UpsertTrustedLink(ctx, second); err != nil {
		t.Fatalf("再次写入失败: %v", err)
	}

	if n := trustedLinkRowCount(t, db, "a@b.com"); n != 1 {
		t.Fatalf("幂等 upsert 应只保留 1 行，实际 %d 行", n)
	}
	if err := db.Get(&row, "SELECT * FROM TrustedLink WHERE email = ?", "a@b.com"); err != nil {
		t.Fatalf("读取记录失败: %v", err)
	}
	if row.ExpiresAt != second.ExpiresAt || row.CreatedAt != second.CreatedAt {
		t.Errorf("再次确认应刷新时间：%+v", row)
	}
	if row.Source != model.TrustedLinkSourceSelf {
		t.Errorf("再次确认应刷新 source 为 self，实际 %q", row.Source)
	}
	if row.ID != firstID {
		// ID 变了说明实现退化成「删了再插」，虽然行数一样但不该发生
		t.Errorf("幂等 upsert 不应换行（ID %d -> %d）", firstID, row.ID)
	}

	// 换一个网址：新的一行，互不影响
	if err := repo.UpsertTrustedLink(ctx, &model.TrustedLink{
		Email:     "a@b.com",
		URL:       "https://new.example.com",
		ExpiresAt: "2027-02-01T00:00:00.000Z",
		CreatedAt: "2026-11-21T00:00:00.000Z",
	}); err != nil {
		t.Fatalf("写入新网址失败: %v", err)
	}
	if n := trustedLinkRowCount(t, db, "a@b.com"); n != 2 {
		t.Errorf("换网址应新增一行，实际 %d 行", n)
	}

	// 同一网址 + 不同邮箱：也是新的一行
	if err := repo.UpsertTrustedLink(ctx, &model.TrustedLink{
		Email:     "c@d.com",
		URL:       "https://a.example.com",
		ExpiresAt: "2027-03-01T00:00:00.000Z",
		CreatedAt: "2026-11-22T00:00:00.000Z",
	}); err != nil {
		t.Fatalf("写入另一个邮箱失败: %v", err)
	}
	if n := trustedLinkRowCount(t, db, "c@d.com"); n != 1 {
		t.Errorf("另一个邮箱应独立成行，实际 %d 行", n)
	}
}

// TestDeleteTrustedLink 删除返回受影响行数：删掉是 1，本来就没有 / 再删一次是 0
func TestDeleteTrustedLink(t *testing.T) {
	db, repo := newTestRepo(t)
	ctx := context.Background()

	if err := repo.UpsertTrustedLink(ctx, &model.TrustedLink{
		Email:     "a@b.com",
		URL:       "https://a.example.com",
		ExpiresAt: "2026-12-01T00:00:00.000Z",
		CreatedAt: seededTrustTime,
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}

	removed, err := repo.DeleteTrustedLink(ctx, "a@b.com", "https://a.example.com")
	if err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if removed != 1 {
		t.Errorf("删除已有记录应返回 1 行，实际 %d", removed)
	}
	if n := trustedLinkRowCount(t, db, "a@b.com"); n != 0 {
		t.Errorf("删除后不应有残留行，实际 %d 行", n)
	}

	// 再删一次：0 行（端点据此返回 revoked=false）
	removed, err = repo.DeleteTrustedLink(ctx, "a@b.com", "https://a.example.com")
	if err != nil {
		t.Fatalf("重复删除失败: %v", err)
	}
	if removed != 0 {
		t.Errorf("删除不存在的记录应返回 0 行，实际 %d", removed)
	}

	// 网址不逐字相等就不该误删（换链接不继承）
	if err := repo.UpsertTrustedLink(ctx, &model.TrustedLink{
		Email:     "a@b.com",
		URL:       "https://a.example.com",
		ExpiresAt: "2026-12-01T00:00:00.000Z",
		CreatedAt: seededTrustTime,
	}); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	removed, err = repo.DeleteTrustedLink(ctx, "a@b.com", "https://other.example.com")
	if err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if removed != 0 {
		t.Errorf("网址不同不应删到任何行，实际 %d 行", removed)
	}
	removed, err = repo.DeleteTrustedLink(ctx, "other@b.com", "https://a.example.com")
	if err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if removed != 0 {
		t.Errorf("邮箱不同不应删到任何行，实际 %d 行", removed)
	}
	if n := trustedLinkRowCount(t, db, "a@b.com"); n != 1 {
		t.Errorf("误删后剩余行数期望 1，实际 %d", n)
	}
}

// TestTrustedLinksByEmails 一次分组查询：只回未过期的、按归一化邮箱 + 逐字网址作键
func TestTrustedLinksByEmails(t *testing.T) {
	db, repo := newTestRepo(t)
	ctx := context.Background()

	// 直接写表（模拟历史数据）：一条有效、一条已过期、一条邮箱大小写与空格不同
	if _, err := db.Exec(`INSERT INTO TrustedLink (email, url, expires_at, created_at) VALUES
		('a@b.com', 'https://a.example.com', '2026-12-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
		('a@b.com', 'https://expired.example.com', '2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
		(' A@B.com ', 'https://padded.example.com', '2026-12-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
		('c@d.com', 'https://c.example.com', '2026-12-03T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}

	links, err := repo.TrustedLinksByEmails(ctx, []string{"a@b.com"}, seededTrustMs)
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(links) != 2 {
		t.Fatalf("应取回 2 条未过期确认，实际 %d 条: %v", len(links), links)
	}
	if got := links[utils.TrustedLinkKey("a@b.com", "https://a.example.com")]; got.ExpiresAt != "2026-12-01T00:00:00.000Z" {
		t.Errorf("有效确认应原样返回 expires_at，实际 %q", got.ExpiresAt)
	}
	if got := links[utils.TrustedLinkKey("a@b.com", "https://padded.example.com")]; got.ExpiresAt != "2026-12-02T00:00:00.000Z" {
		t.Errorf("邮箱大小写/空白不同也应按归一化身份命中，实际 %q", got.ExpiresAt)
	}
	// 直接写表的历史行没有指定 source：建表默认值就是 'admin'
	if got := links[utils.TrustedLinkKey("a@b.com", "https://a.example.com")]; got.Source != model.TrustedLinkSourceAdmin {
		t.Errorf("历史行的 source 应回落 admin，实际 %q", got.Source)
	}
	if _, ok := links[utils.TrustedLinkKey("a@b.com", "https://expired.example.com")]; ok {
		t.Errorf("已过期的确认不应被取回")
	}
	// 未提供的邮箱（哪怕表里有）不得带回
	if _, ok := links[utils.TrustedLinkKey("c@d.com", "https://c.example.com")]; ok {
		t.Errorf("不在本次邮箱集合里的记录不应被取回")
	}

	// 空集合：不发查询、返回空 map（调用方直接遍历，不需要判 nil）
	empty, err := repo.TrustedLinksByEmails(ctx, nil, seededTrustMs)
	if err != nil {
		t.Fatalf("空集合查询失败: %v", err)
	}
	if empty == nil || len(empty) != 0 {
		t.Errorf("空集合应返回空 map，实际 %v", empty)
	}

	// 恰好等于 now：严格大于才算有效，必须被视为已过期
	exact, err := repo.TrustedLinksByEmails(ctx, []string{"c@d.com"}, trustMillis(t, "2026-12-03T00:00:00.000Z"))
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(exact) != 0 {
		t.Errorf("expires_at 恰好等于 now 应视为已过期，实际 %v", exact)
	}

	// 脏格式（长度不对 / 缺毫秒）：SQL 粗筛可能放行，纯函数必须兜底为「无效」
	if _, err := db.Exec(`INSERT INTO TrustedLink (email, url, expires_at, created_at)
		VALUES ('e@f.com', 'https://dirty.example.com', '2099-01-01T00:00:00Z', '2026-11-01T00:00:00.000Z')`); err != nil {
		t.Fatalf("写入脏记录失败: %v", err)
	}
	dirty, err := repo.TrustedLinksByEmails(ctx, []string{"e@f.com"}, seededTrustMs)
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(dirty) != 0 {
		t.Errorf("格式不符的 expires_at 必须 fail-closed 视为无效，实际 %v", dirty)
	}
}
