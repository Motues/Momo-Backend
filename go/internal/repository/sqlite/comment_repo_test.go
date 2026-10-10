package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/repository"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

// newTestDB 创建一个临时文件数据库并初始化表结构。
// 使用文件库（而非 :memory:）是因为仓库层通过连接池可能使用多个连接。
func newTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	db, err := sqlx.Connect("sqlite", filepath.Join(t.TempDir(), "repo.db"))
	if err != nil {
		t.Fatalf("连接测试数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := InitSchema(db); err != nil {
		t.Fatalf("初始化表结构失败: %v", err)
	}
	return db
}

// newTestRepo 返回临时数据库与其上的评论仓库
func newTestRepo(t *testing.T) (*sqlx.DB, repository.CommentRepository) {
	t.Helper()
	db := newTestDB(t)
	return db, NewCommentRepository(db)
}

func strPtr(s string) *string { return &s }
func int64Ptr(v int64) *int64 { return &v }

// mustCreate 插入一条评论并在失败时终止用例
func mustCreate(t *testing.T, repo repository.CommentRepository, c *model.Comment) *model.Comment {
	t.Helper()
	if err := repo.Create(context.Background(), c); err != nil {
		t.Fatalf("插入评论失败: %v", err)
	}
	return c
}

// sampleComment 构造一条字段齐全的评论
func sampleComment(slug, author, email string, pubDate int64, status string) *model.Comment {
	return &model.Comment{
		PostSlug:    slug,
		Author:      author,
		Email:       email,
		URL:         strPtr("https://" + author + ".example.com"),
		IPAddress:   strPtr("203.0.113.10"),
		Device:      strPtr("Desktop"),
		OS:          strPtr("Windows 10"),
		Browser:     strPtr("Chrome 120"),
		UserAgent:   strPtr("Mozilla/5.0 (test)"),
		ContentText: "内容 " + author,
		ContentHTML: "<p>内容 " + author + "</p>",
		Status:      status,
		PubDate:     pubDate,
	}
}

// seedPublicComments 插入若干评论并返回它们的 ID
func seedComments(t *testing.T, repo repository.CommentRepository, comments ...*model.Comment) {
	t.Helper()
	for _, c := range comments {
		mustCreate(t, repo, c)
	}
}

func requireCount(t *testing.T, db *sqlx.DB, query string, want int, args ...interface{}) {
	t.Helper()
	var got int
	if err := db.Get(&got, query, args...); err != nil {
		t.Fatalf("统计查询失败 (%s): %v", query, err)
	}
	if got != want {
		t.Errorf("%s 期望 %d，实际 %d", query, want, got)
	}
}

// ---------------------------------------------------------------------------
// 表结构
// ---------------------------------------------------------------------------

func TestInitSchemaCreatesAllTables(t *testing.T) {
	db := newTestDB(t)

	for _, table := range []string{"Comment", "Settings", "EmailVerification", "SchemaMigration", "VerifyRecord"} {
		var name string
		err := db.Get(&name, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)
		if err != nil {
			t.Errorf("表 %s 应存在: %v", table, err)
		}
	}

	// 索引也应创建
	for _, index := range []string{
		"idx_post_slug", "idx_status", "idx_ev_email", "idx_ev_token",
		"idx_vr_created", "idx_vr_event", "idx_vr_cid",
	} {
		var name string
		err := db.Get(&name, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", index)
		if err != nil {
			t.Errorf("索引 %s 应存在: %v", index, err)
		}
	}

	// 默认值：Comment.status 默认 pending（与 Node/Worker 一致）
	if _, err := db.Exec(`INSERT INTO Comment (post_slug, author, email, content_text, content_html, pub_date)
		VALUES ('/p', 'a', 'a@b.com', 't', 'h', 1712345678901)`); err != nil {
		t.Fatalf("插入默认值测试行失败: %v", err)
	}
	var status string
	if err := db.Get(&status, "SELECT status FROM Comment WHERE post_slug = '/p'"); err != nil {
		t.Fatalf("读取状态失败: %v", err)
	}
	if status != "pending" {
		t.Errorf("Comment.status 默认值应为 pending，实际 %q", status)
	}

	// ID 自增
	var id int64
	if err := db.Get(&id, "SELECT id FROM Comment WHERE post_slug = '/p'"); err != nil {
		t.Fatalf("读取 id 失败: %v", err)
	}
	if id <= 0 {
		t.Errorf("自增主键应为正整数，实际 %d", id)
	}
}

func TestInitSchemaIsIdempotent(t *testing.T) {
	db := newTestDB(t)

	// 第二次、第三次执行都应成功且不破坏已有数据
	for i := 0; i < 2; i++ {
		if err := InitSchema(db); err != nil {
			t.Fatalf("第 %d 次重复初始化失败: %v", i+2, err)
		}
	}

	repo := NewCommentRepository(db)
	mustCreate(t, repo, sampleComment("/p", "a", "a@b.com", 1712345678901, "approved"))
	requireCount(t, db, "SELECT COUNT(*) FROM Comment", 1)

	// 迁移记录不应重复写入
	requireCount(t, db, "SELECT COUNT(*) FROM SchemaMigration WHERE id = '0001_pub_date_to_millis'", 1)
}

func TestRepositoryImplementsInterface(t *testing.T) {
	db, repo := newTestRepo(t)
	var _ repository.CommentRepository = repo
	if db == nil {
		t.Fatalf("测试数据库不应为 nil")
	}
}

// ---------------------------------------------------------------------------
// Create / GetByID
// ---------------------------------------------------------------------------

func TestCreateStoresAllColumns(t *testing.T) {
	db, repo := newTestRepo(t)

	c := &model.Comment{
		PostSlug:    "/posts/hello",
		Author:      "张三",
		Email:       "zhangsan@example.com",
		URL:         strPtr("https://zhangsan.example.com"),
		IPAddress:   strPtr("203.0.113.7"),
		Device:      strPtr("Mobile"),
		OS:          strPtr("iOS 17.0"),
		Browser:     strPtr("Safari 17.0"),
		UserAgent:   strPtr("Mozilla/5.0 (iPhone)"),
		ContentText: "**加粗** 文本",
		ContentHTML: "<p><strong>加粗</strong> 文本</p>",
		Status:      "approved",
		PubDate:     1712345678901,
	}

	mustCreate(t, repo, c)

	if c.ID <= 0 {
		t.Fatalf("Create 之后应回填自增 ID，实际 %d", c.ID)
	}

	got, err := repo.GetByID(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}

	if got.ID != c.ID {
		t.Errorf("ID 期望 %d，实际 %d", c.ID, got.ID)
	}
	if got.PubDate != 1712345678901 {
		t.Errorf("pub_date 必须按毫秒整数原样存储，期望 1712345678901，实际 %d", got.PubDate)
	}
	if got.PostSlug != "/posts/hello" || got.Author != "张三" || got.Email != "zhangsan@example.com" {
		t.Errorf("基础字段不一致: %+v", got)
	}
	if got.ContentText != "**加粗** 文本" {
		t.Errorf("content_text 应保存原始（已清洗）文本，实际 %q", got.ContentText)
	}
	if got.ContentHTML != "<p><strong>加粗</strong> 文本</p>" {
		t.Errorf("content_html 不一致，实际 %q", got.ContentHTML)
	}
	if got.Status != "approved" {
		t.Errorf("status 期望 approved，实际 %q", got.Status)
	}
	for name, pair := range map[string][2]*string{
		"url":        {c.URL, got.URL},
		"ip_address": {c.IPAddress, got.IPAddress},
		"device":     {c.Device, got.Device},
		"os":         {c.OS, got.OS},
		"browser":    {c.Browser, got.Browser},
		"user_agent": {c.UserAgent, got.UserAgent},
	} {
		if pair[1] == nil {
			t.Errorf("%s 不应为 nil", name)
			continue
		}
		if *pair[0] != *pair[1] {
			t.Errorf("%s 期望 %q，实际 %q", name, *pair[0], *pair[1])
		}
	}

	// 数据库中的 pub_date 必须是整数类型（毫秒时间戳）
	var typeOf string
	if err := db.Get(&typeOf, "SELECT typeof(pub_date) FROM Comment WHERE id = ?", c.ID); err != nil {
		t.Fatalf("读取 pub_date 类型失败: %v", err)
	}
	if typeOf != "integer" {
		t.Errorf("pub_date 在数据库中应为 integer，实际 %q", typeOf)
	}
}

func TestCreateWithNilOptionalFields(t *testing.T) {
	db, repo := newTestRepo(t)

	c := &model.Comment{
		PostSlug:    "/posts/minimal",
		Author:      "最小评论",
		Email:       "min@example.com",
		ContentText: "纯文本",
		ContentHTML: "<p>纯文本</p>",
		Status:      "pending",
		PubDate:     1712345678000,
	}

	mustCreate(t, repo, c)

	got, err := repo.GetByID(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.URL != nil || got.IPAddress != nil || got.Device != nil || got.OS != nil || got.Browser != nil || got.UserAgent != nil || got.ParentID != nil {
		t.Errorf("未赋值的可选字段应保持 NULL: %+v", got)
	}

	for _, column := range []string{"url", "ip_address", "device", "os", "browser", "user_agent", "parent_id"} {
		var isNull int
		if err := db.Get(&isNull, "SELECT "+column+" IS NULL FROM Comment WHERE id = ?", c.ID); err != nil {
			t.Fatalf("检查 %s 是否为 NULL 失败: %v", column, err)
		}
		if isNull != 1 {
			t.Errorf("列 %s 应为 NULL", column)
		}
	}
}

func TestCreateAssignsIncreasingIDs(t *testing.T) {
	_, repo := newTestRepo(t)

	var ids []int64
	for i := 0; i < 5; i++ {
		c := sampleComment("/p", "a", "a@b.com", int64(1712345678901+i), "approved")
		mustCreate(t, repo, c)
		ids = append(ids, c.ID)
	}

	for i := 1; i < len(ids); i++ {
		if ids[i] <= ids[i-1] {
			t.Errorf("自增 ID 必须递增，实际 %v", ids)
			break
		}
	}
}

func TestCreateReplySetsParentID(t *testing.T) {
	_, repo := newTestRepo(t)

	parent := mustCreate(t, repo, sampleComment("/p", "parent", "p@x.com", 1712345678000, "approved"))

	child := sampleComment("/p", "child", "c@x.com", 1712345679000, "approved")
	child.ParentID = int64Ptr(parent.ID)
	mustCreate(t, repo, child)

	got, err := repo.GetByID(context.Background(), child.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.ParentID == nil {
		t.Fatalf("回复评论的 parent_id 不应为 nil")
	}
	if *got.ParentID != parent.ID {
		t.Errorf("parent_id 期望 %d，实际 %d", parent.ID, *got.ParentID)
	}
}

func TestGetByIDNotFound(t *testing.T) {
	db, repo := newTestRepo(t)
	// 先制造一个自增序号，确保 id=massive 一定不存在
	mustCreate(t, repo, sampleComment("/p", "a", "a@b.com", 1712345678901, "approved"))
	_ = db

	for _, id := range []int64{0, -1, 999999, 1 << 40} {
		_, err := repo.GetByID(context.Background(), id)
		if err == nil {
			t.Errorf("id=%d 不存在时应返回错误", id)
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			t.Errorf("id=%d 应返回 sql.ErrNoRows，实际 %v", id, err)
		}
	}
}

// ---------------------------------------------------------------------------
// GetByPostSlug
// ---------------------------------------------------------------------------

func TestGetByPostSlugReturnsOnlyApprovedInAscendingOrder(t *testing.T) {
	_, repo := newTestRepo(t)

	seedComments(t, repo,
		sampleComment("/p/1", "第三", "c@x.com", 3000, "approved"),
		sampleComment("/p/1", "第一", "a@x.com", 1000, "approved"),
		sampleComment("/p/1", "待审核", "p@x.com", 1500, "pending"),
		sampleComment("/p/1", "已拒绝", "r@x.com", 1600, "rejected"),
		sampleComment("/p/1", "已删除", "d@x.com", 1700, "deleted"),
		sampleComment("/p/2", "其他文章", "o@x.com", 900, "approved"),
	)

	got, err := repo.GetByPostSlug(context.Background(), "/p/1")
	if err != nil {
		t.Fatalf("GetByPostSlug 失败: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("只应返回 2 条已通过评论，实际 %d 条: %+v", len(got), got)
	}
	if got[0].Author != "第一" || got[1].Author != "第三" {
		t.Errorf("应按 pub_date 升序返回，实际顺序 %q, %q", got[0].Author, got[1].Author)
	}
	for _, c := range got {
		if c.Status != "approved" {
			t.Errorf("返回结果中不应包含状态 %q", c.Status)
		}
		if c.PostSlug != "/p/1" {
			t.Errorf("返回结果不应跨文章: %q", c.PostSlug)
		}
	}
}

func TestGetByPostSlugEmptyResult(t *testing.T) {
	db, repo := newTestRepo(t)

	for _, slug := range []string{"/not-exist", "", "  ", "'; DROP TABLE Comment; --", "/p/1 OR 1=1"} {
		got, err := repo.GetByPostSlug(context.Background(), slug)
		if err != nil {
			t.Errorf("slug=%q 查询不应报错: %v", slug, err)
		}
		if len(got) != 0 {
			t.Errorf("slug=%q 不应返回数据，实际 %d 条", slug, len(got))
		}
	}

	// 参数化查询：注入式 slug 不应破坏表结构
	requireCount(t, db, "SELECT COUNT(*) FROM Comment", 0)
}

func TestGetByPostSlugWithSamePubDate(t *testing.T) {
	_, repo := newTestRepo(t)

	// pub_date 相同的情况下也必须返回全部记录（不能互相覆盖）
	seedComments(t, repo,
		sampleComment("/p", "a", "a@x.com", 1712345678901, "approved"),
		sampleComment("/p", "b", "b@x.com", 1712345678901, "approved"),
		sampleComment("/p", "c", "c@x.com", 1712345678901, "approved"),
	)

	got, err := repo.GetByPostSlug(context.Background(), "/p")
	if err != nil {
		t.Fatalf("GetByPostSlug 失败: %v", err)
	}
	if len(got) != 3 {
		t.Errorf("相同 pub_date 的三条评论都应返回，实际 %d 条", len(got))
	}
}

// ---------------------------------------------------------------------------
// List / ListAll
// ---------------------------------------------------------------------------

func TestListWithStatusFilter(t *testing.T) {
	_, repo := newTestRepo(t)

	seedComments(t, repo,
		sampleComment("/p", "a1", "a@x.com", 1000, "approved"),
		sampleComment("/p", "a2", "a2@x.com", 2000, "approved"),
		sampleComment("/p", "p1", "p@x.com", 3000, "pending"),
		sampleComment("/p", "r1", "r@x.com", 4000, "rejected"),
		sampleComment("/p", "d1", "d@x.com", 5000, "deleted"),
	)

	for _, tc := range []struct {
		name    string
		status  string
		want    int
		wantTot int64
	}{
		{"按 approved 过滤", "approved", 2, 2},
		{"按 pending 过滤", "pending", 1, 1},
		{"按 rejected 过滤", "rejected", 1, 1},
		{"按 deleted 过滤", "deleted", 1, 1},
		{"空状态表示不过滤", "", 5, 5},
		{"未知状态返回空", "not-a-status", 0, 0},
		{"SQL 注入式状态返回空", "' OR 1=1 --", 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			comments, total, err := repo.List(context.Background(), 0, 10, tc.status)
			if err != nil {
				t.Fatalf("List 失败: %v", err)
			}
			if len(comments) != tc.want {
				t.Errorf("期望 %d 条，实际 %d 条", tc.want, len(comments))
			}
			if total != tc.wantTot {
				t.Errorf("总数期望 %d，实际 %d", tc.wantTot, total)
			}
		})
	}
}

func TestListOrdersByPubDateDesc(t *testing.T) {
	_, repo := newTestRepo(t)

	for i := 0; i < 5; i++ {
		seedComments(t, repo, sampleComment("/p", string(rune('a'+i)), "x@x.com", int64(1000+i), "approved"))
	}

	comments, _, err := repo.List(context.Background(), 0, 10, "")
	if err != nil {
		t.Fatalf("List 失败: %v", err)
	}
	if len(comments) != 5 {
		t.Fatalf("期望 5 条，实际 %d 条", len(comments))
	}
	for i := 1; i < len(comments); i++ {
		if comments[i].PubDate > comments[i-1].PubDate {
			t.Errorf("应按 pub_date 降序返回，实际 %v", []int64{
				comments[0].PubDate, comments[1].PubDate, comments[2].PubDate, comments[3].PubDate, comments[4].PubDate,
			})
			break
		}
	}
}

func TestListPagination(t *testing.T) {
	_, repo := newTestRepo(t)

	for i := 0; i < 25; i++ {
		seedComments(t, repo, sampleComment("/p", "a", "a@x.com", int64(1000+i), "approved"))
	}

	for _, tc := range []struct {
		name      string
		offset    int
		limit     int
		wantLen   int
		wantFirst int64
	}{
		{"第一页", 0, 10, 10, 1024},
		{"第二页", 10, 10, 10, 1014},
		{"最后一页不满", 20, 10, 5, 1004},
		{"越界偏移返回空", 100, 10, 0, 0},
		{"limit 为 0 返回空但总数不变", 0, 0, 0, 0},
		{"limit 大于总数", 0, 100, 25, 1024},
		{"limit 为负数", 0, -1, 25, 1024},
	} {
		t.Run(tc.name, func(t *testing.T) {
			comments, total, err := repo.List(context.Background(), tc.offset, tc.limit, "")
			if err != nil {
				t.Fatalf("List 失败: %v", err)
			}
			if total != 25 {
				t.Errorf("总数应始终为 25（与分页无关），实际 %d", total)
			}
			if len(comments) != tc.wantLen {
				t.Fatalf("期望 %d 条，实际 %d 条", tc.wantLen, len(comments))
			}
			if tc.wantLen > 0 && comments[0].PubDate != tc.wantFirst {
				t.Errorf("首页首条 pub_date 期望 %d，实际 %d", tc.wantFirst, comments[0].PubDate)
			}
		})
	}
}

func TestListEmptyTable(t *testing.T) {
	_, repo := newTestRepo(t)

	for _, status := range []string{"", "approved", "pending"} {
		comments, total, err := repo.List(context.Background(), 0, 10, status)
		if err != nil {
			t.Fatalf("List(%q) 失败: %v", status, err)
		}
		if total != 0 || len(comments) != 0 {
			t.Errorf("空表时 status=%q 应返回 0 条，实际 %d 条 / total=%d", status, len(comments), total)
		}
	}
}

func TestListAll(t *testing.T) {
	_, repo := newTestRepo(t)

	seedComments(t, repo,
		sampleComment("/p", "b", "b@x.com", 2000, "pending"),
		sampleComment("/p", "a", "a@x.com", 1000, "approved"),
		sampleComment("/p", "d", "d@x.com", 3000, "deleted"),
	)

	all, err := repo.ListAll(context.Background())
	if err != nil {
		t.Fatalf("ListAll 失败: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("ListAll 应返回全部状态的评论，实际 %d 条", len(all))
	}
	if all[0].PubDate != 1000 || all[1].PubDate != 2000 || all[2].PubDate != 3000 {
		t.Errorf("ListAll 应按 pub_date 升序返回，实际 %d,%d,%d", all[0].PubDate, all[1].PubDate, all[2].PubDate)
	}
}

func TestListAllEmpty(t *testing.T) {
	_, repo := newTestRepo(t)

	all, err := repo.ListAll(context.Background())
	if err != nil {
		t.Fatalf("ListAll 失败: %v", err)
	}
	if len(all) != 0 {
		t.Errorf("空表应返回 0 条，实际 %d 条", len(all))
	}
}

// ---------------------------------------------------------------------------
// UpdateStatus
// ---------------------------------------------------------------------------

func TestUpdateStatusSimple(t *testing.T) {
	db, repo := newTestRepo(t)

	for _, status := range []string{"approved", "pending", "rejected", "deleted"} {
		c := mustCreate(t, repo, sampleComment("/p", "a", "a@x.com", 1712345678901, "pending"))

		if err := repo.UpdateStatus(context.Background(), c.ID, status); err != nil {
			t.Fatalf("UpdateStatus(%q) 失败: %v", status, err)
		}

		got, err := repo.GetByID(context.Background(), c.ID)
		if err != nil {
			t.Fatalf("GetByID 失败: %v", err)
		}
		if got.Status != status {
			t.Errorf("状态期望 %q，实际 %q", status, got.Status)
		}
	}

	requireCount(t, db, "SELECT COUNT(*) FROM Comment", 4)
}

func TestUpdateStatusCascadesForDeletedAndPending(t *testing.T) {
	_, repo := newTestRepo(t)

	for _, target := range []string{"deleted", "pending"} {
		t.Run("级联为 "+target, func(t *testing.T) {
			root := mustCreate(t, repo, sampleComment("/p", "root", "r@x.com", 1, "approved"))
			child := sampleComment("/p", "child", "c@x.com", 2, "approved")
			child.ParentID = int64Ptr(root.ID)
			mustCreate(t, repo, child)
			grandchild := sampleComment("/p", "grandchild", "g@x.com", 3, "approved")
			grandchild.ParentID = int64Ptr(child.ID)
			mustCreate(t, repo, grandchild)
			unrelated := mustCreate(t, repo, sampleComment("/p", "unrelated", "u@x.com", 4, "approved"))

			if err := repo.UpdateStatus(context.Background(), root.ID, target); err != nil {
				t.Fatalf("UpdateStatus 失败: %v", err)
			}

			for _, id := range []int64{root.ID, child.ID, grandchild.ID} {
				got, err := repo.GetByID(context.Background(), id)
				if err != nil {
					t.Fatalf("GetByID(%d) 失败: %v", id, err)
				}
				if got.Status != target {
					t.Errorf("id=%d 的子孙评论应级联为 %q，实际 %q", id, target, got.Status)
				}
			}

			got, err := repo.GetByID(context.Background(), unrelated.ID)
			if err != nil {
				t.Fatalf("GetByID 失败: %v", err)
			}
			if got.Status != "approved" {
				t.Errorf("无关评论不应被级联修改，实际 %q", got.Status)
			}
		})
	}
}

func TestUpdateStatusApprovedDoesNotCascade(t *testing.T) {
	_, repo := newTestRepo(t)

	root := mustCreate(t, repo, sampleComment("/p", "root", "r@x.com", 1, "pending"))
	child := sampleComment("/p", "child", "c@x.com", 2, "pending")
	child.ParentID = int64Ptr(root.ID)
	mustCreate(t, repo, child)

	if err := repo.UpdateStatus(context.Background(), root.ID, "approved"); err != nil {
		t.Fatalf("UpdateStatus 失败: %v", err)
	}

	got, err := repo.GetByID(context.Background(), child.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.Status != "pending" {
		t.Errorf("approved 不应级联子评论，实际 %q", got.Status)
	}
}

func TestUpdateStatusNonexistentID(t *testing.T) {
	_, repo := newTestRepo(t)

	// 不存在的 id 不报错，只影响 0 行
	for _, id := range []int64{0, -1, 999999} {
		if err := repo.UpdateStatus(context.Background(), id, "deleted"); err != nil {
			t.Errorf("id=%d 更新状态不应报错: %v", id, err)
		}
	}
}

// ---------------------------------------------------------------------------
// UpdateComment
// ---------------------------------------------------------------------------

func TestUpdateComment(t *testing.T) {
	db, repo := newTestRepo(t)

	c := mustCreate(t, repo, sampleComment("/p", "old", "old@x.com", 1712345678901, "approved"))

	err := repo.UpdateComment(context.Background(), c.ID, map[string]interface{}{
		"author":       "新的作者",
		"email":        "new@x.com",
		"content_text": "新的正文",
		"content_html": "<p>新的正文</p>",
		"url":          "https://new.example.com",
	})
	if err != nil {
		t.Fatalf("UpdateComment 失败: %v", err)
	}

	got, err := repo.GetByID(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.Author != "新的作者" || got.Email != "new@x.com" {
		t.Errorf("作者/邮箱未更新: %+v", got)
	}
	if got.ContentText != "新的正文" || got.ContentHTML != "<p>新的正文</p>" {
		t.Errorf("正文未更新: text=%q html=%q", got.ContentText, got.ContentHTML)
	}
	if got.URL == nil || *got.URL != "https://new.example.com" {
		t.Errorf("url 未更新: %v", got.URL)
	}
	// 未传入的字段必须保持原值
	if got.Status != "approved" || got.PubDate != 1712345678901 || got.PostSlug != "/p" {
		t.Errorf("未传入的字段不应被修改: %+v", got)
	}
	if got.IPAddress == nil || *got.IPAddress != "203.0.113.10" {
		t.Errorf("ip_address 不应被修改: %v", got.IPAddress)
	}
	_ = db
}

func TestUpdateCommentIgnoresUnknownAndUnsafeFields(t *testing.T) {
	_, repo := newTestRepo(t)

	c := mustCreate(t, repo, sampleComment("/p", "原作者", "orig@x.com", 1712345678901, "approved"))

	// 白名单之外的键必须被忽略（含 SQL 注入式列名与状态字段）
	err := repo.UpdateComment(context.Background(), c.ID, map[string]interface{}{
		"status":               "deleted",
		"id":                   int64(999999),
		"pub_date":             int64(1),
		"post_slug":            "/hacked",
		"ip_address":           "1.1.1.1",
		"author = 'x', status": "deleted",
	})
	if err != nil {
		t.Fatalf("UpdateComment 失败: %v", err)
	}

	got, err := repo.GetByID(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.Status != "approved" {
		t.Errorf("status 不在白名单内，不应被修改，实际 %q", got.Status)
	}
	if got.PubDate != 1712345678901 {
		t.Errorf("pub_date 不应被修改，实际 %d", got.PubDate)
	}
	if got.PostSlug != "/p" {
		t.Errorf("post_slug 不应被修改，实际 %q", got.PostSlug)
	}
	if got.Author != "原作者" {
		t.Errorf("author 不应被修改，实际 %q", got.Author)
	}
	if got.IPAddress == nil || *got.IPAddress != "203.0.113.10" {
		t.Errorf("ip_address 不应被修改，实际 %v", got.IPAddress)
	}
}

func TestUpdateCommentWithNoUsableFields(t *testing.T) {
	_, repo := newTestRepo(t)

	c := mustCreate(t, repo, sampleComment("/p", "作者", "a@x.com", 1712345678901, "approved"))

	for _, fields := range []map[string]interface{}{
		{},
		nil,
		{"unknown": "x"},
	} {
		if err := repo.UpdateComment(context.Background(), c.ID, fields); err != nil {
			t.Errorf("空字段集不应报错: %v", err)
		}
	}

	got, err := repo.GetByID(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.Author != "作者" {
		t.Errorf("无可用字段时不应修改数据，实际 %q", got.Author)
	}
}

func TestUpdateCommentOnlyAffectsTargetRow(t *testing.T) {
	_, repo := newTestRepo(t)

	a := mustCreate(t, repo, sampleComment("/p", "a", "a@x.com", 1000, "approved"))
	b := mustCreate(t, repo, sampleComment("/p", "b", "b@x.com", 2000, "approved"))

	if err := repo.UpdateComment(context.Background(), a.ID, map[string]interface{}{"author": "A2"}); err != nil {
		t.Fatalf("UpdateComment 失败: %v", err)
	}

	gotB, err := repo.GetByID(context.Background(), b.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if gotB.Author != "b" {
		t.Errorf("其他行不应被修改，实际 %q", gotB.Author)
	}
}

func TestUpdateCommentNonexistentID(t *testing.T) {
	_, repo := newTestRepo(t)

	if err := repo.UpdateComment(context.Background(), 999999, map[string]interface{}{"author": "x"}); err != nil {
		t.Errorf("不存在的 id 不应报错: %v", err)
	}
}

func TestUpdateCommentCanClearURL(t *testing.T) {
	db, repo := newTestRepo(t)

	c := mustCreate(t, repo, sampleComment("/p", "a", "a@x.com", 1712345678901, "approved"))

	// 记录当前行为：以空串更新 url 会把列写成空串，而不是 NULL
	if err := repo.UpdateComment(context.Background(), c.ID, map[string]interface{}{"url": ""}); err != nil {
		t.Fatalf("UpdateComment 失败: %v", err)
	}
	got, err := repo.GetByID(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("GetByID 失败: %v", err)
	}
	if got.URL == nil {
		t.Fatalf("当前实现写入了空串，读取时不应为 nil（记录该行为）")
	}
	if *got.URL != "" {
		t.Errorf("url 应被清空为空串，实际 %q", *got.URL)
	}

	// 显式写 NULL 才是真正的置空
	if err := repo.UpdateComment(context.Background(), c.ID, map[string]interface{}{"url": nil}); err != nil {
		t.Fatalf("UpdateComment 失败: %v", err)
	}
	var isNull int
	if err := db.Get(&isNull, "SELECT url IS NULL FROM Comment WHERE id = ?", c.ID); err != nil {
		t.Fatalf("检查 url 是否为 NULL 失败: %v", err)
	}
	if isNull != 1 {
		t.Errorf("传入 nil 应写入 NULL")
	}
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

func TestDelete(t *testing.T) {
	db, repo := newTestRepo(t)

	a := mustCreate(t, repo, sampleComment("/p", "a", "a@x.com", 1000, "approved"))
	b := mustCreate(t, repo, sampleComment("/p", "b", "b@x.com", 2000, "approved"))

	if err := repo.Delete(context.Background(), a.ID); err != nil {
		t.Fatalf("Delete 失败: %v", err)
	}

	if _, err := repo.GetByID(context.Background(), a.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("删除后 GetByID 应返回 ErrNoRows，实际 %v", err)
	}
	requireCount(t, db, "SELECT COUNT(*) FROM Comment", 1)

	if _, err := repo.GetByID(context.Background(), b.ID); err != nil {
		t.Errorf("其他行不应被删除: %v", err)
	}
}

func TestDeleteNonexistentID(t *testing.T) {
	_, repo := newTestRepo(t)

	for _, id := range []int64{0, -1, 999999} {
		if err := repo.Delete(context.Background(), id); err != nil {
			t.Errorf("删除不存在的 id=%d 不应报错: %v", id, err)
		}
	}
}

func TestDeleteParentKeepsChildRow(t *testing.T) {
	db, repo := newTestRepo(t)

	parent := mustCreate(t, repo, sampleComment("/p", "parent", "p@x.com", 1000, "approved"))
	child := sampleComment("/p", "child", "c@x.com", 2000, "approved")
	child.ParentID = int64Ptr(parent.ID)
	mustCreate(t, repo, child)

	if err := repo.Delete(context.Background(), parent.ID); err != nil {
		t.Fatalf("Delete 失败: %v", err)
	}

	// 记录当前行为：外键的 ON DELETE SET NULL 依赖每个连接开启 PRAGMA foreign_keys，
	// 因此子行可能仍保留悬空的 parent_id。这里断言子行本身不会被删除。
	requireCount(t, db, "SELECT COUNT(*) FROM Comment", 1)
	got, err := repo.GetByID(context.Background(), child.ID)
	if err != nil {
		t.Fatalf("子评论行应仍然存在: %v", err)
	}
	if got.ParentID != nil && *got.ParentID == parent.ID {
		t.Logf("注意：子评论的 parent_id 仍指向已删除的父评论（%d），外键未生效", *got.ParentID)
	}
}

// ---------------------------------------------------------------------------
// GetLastCommentByIP
// ---------------------------------------------------------------------------

func TestGetLastCommentByIP(t *testing.T) {
	_, repo := newTestRepo(t)

	older := sampleComment("/p", "old", "old@x.com", 1000, "approved")
	older.IPAddress = strPtr("1.1.1.1")
	mustCreate(t, repo, older)

	newer := sampleComment("/p", "new", "new@x.com", 5000, "pending")
	newer.IPAddress = strPtr("1.1.1.1")
	mustCreate(t, repo, newer)

	other := sampleComment("/p", "other", "other@x.com", 9000, "approved")
	other.IPAddress = strPtr("2.2.2.2")
	mustCreate(t, repo, other)

	got, err := repo.GetLastCommentByIP(context.Background(), "1.1.1.1")
	if err != nil {
		t.Fatalf("GetLastCommentByIP 失败: %v", err)
	}
	if got.Author != "new" {
		t.Errorf("应返回该 IP 最新的一条（按 pub_date），实际 %q", got.Author)
	}
	if got.PubDate != 5000 {
		t.Errorf("pub_date 期望 5000，实际 %d", got.PubDate)
	}
}

func TestGetLastCommentByIPNotFound(t *testing.T) {
	db, repo := newTestRepo(t)

	c := sampleComment("/p", "a", "a@x.com", 1000, "approved")
	c.IPAddress = strPtr("1.1.1.1")
	mustCreate(t, repo, c)

	for _, ip := range []string{"9.9.9.9", "", "1.1.1.2", "::1"} {
		if _, err := repo.GetLastCommentByIP(context.Background(), ip); !errors.Is(err, sql.ErrNoRows) {
			t.Errorf("ip=%q 不存在时应返回 ErrNoRows，实际 %v", ip, err)
		}
	}
	_ = db
}

func TestGetLastCommentByIPIgnoresNullIP(t *testing.T) {
	_, repo := newTestRepo(t)

	// ip_address 为 NULL 的行不应被空串查询命中
	noIP := sampleComment("/p", "no-ip", "n@x.com", 1000, "approved")
	noIP.IPAddress = nil
	mustCreate(t, repo, noIP)

	if _, err := repo.GetLastCommentByIP(context.Background(), ""); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("NULL 的 ip_address 不应被空串命中，实际 %v", err)
	}
}
