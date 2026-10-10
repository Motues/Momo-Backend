package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"momo-backend-go/internal/model"

	"github.com/jmoiron/sqlx"
)

/*
认证记录（VerifyRecord）的仓库层测试。

覆盖 HTTP 层不容易精确控制的两块：
  - RecordVerifyEvent 的落库内容（空值必须是 NULL）与 comment_verify_log_challenge 开关；
  - PruneVerifyRecords 的保留天数口径（0 = 永久保留、非法值回退默认、上限）。
另外把时间窗口与毫秒 ISO 格式化直接钉在纯函数上（分桶键是三端共享的契约）。
*/

// storedVerifyRecord 读取 VerifyRecord 的一行（注意不要与 verifyRecord.go 里的
// verifyRecordRow 重名，那是生产代码的行结构）
type storedVerifyRecord struct {
	ID          int64          `db:"id"`
	CreatedAt   int64          `db:"created_at"`
	Event       string         `db:"event"`
	Reason      sql.NullString `db:"reason"`
	ElapsedMs   sql.NullInt64  `db:"elapsed_ms"`
	Difficulty  sql.NullInt64  `db:"difficulty"`
	ChallengeID sql.NullString `db:"challenge_id"`
	PostSlug    sql.NullString `db:"post_slug"`
	IPAddress   sql.NullString `db:"ip_address"`
	Country     sql.NullString `db:"country"`
	Network     sql.NullString `db:"network"`
	ASN         sql.NullInt64  `db:"asn"`
}

// readVerifyRows 按写入顺序读取全部认证记录
func readVerifyRows(t *testing.T, db *sqlx.DB) []storedVerifyRecord {
	t.Helper()
	rows := []storedVerifyRecord{}
	if err := db.Select(&rows, "SELECT * FROM VerifyRecord ORDER BY id ASC"); err != nil {
		t.Fatalf("读取 VerifyRecord 失败: %v", err)
	}
	return rows
}

// countVerifyRows 统计认证记录条数
func countVerifyRows(t *testing.T, db *sqlx.DB) int {
	t.Helper()
	var n int
	if err := db.Get(&n, "SELECT COUNT(*) FROM VerifyRecord"); err != nil {
		t.Fatalf("统计 VerifyRecord 失败: %v", err)
	}
	return n
}

// setVerifySetting 直接写入 Settings（仓库层自己查表，不再依赖 utils 包）
func setVerifySetting(t *testing.T, db *sqlx.DB, key, value string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO Settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
		t.Fatalf("写入设置 %s=%q 失败: %v", key, value, err)
	}
}

// insertVerifyRow 直接插入一条认证记录（绕过 RecordVerifyEvent，精确控制 created_at）
func insertVerifyRow(t *testing.T, db *sqlx.DB, createdAt int64, event string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO VerifyRecord (created_at, event) VALUES (?, ?)`, createdAt, event); err != nil {
		t.Fatalf("插入认证记录失败: %v", err)
	}
}

// testDayMS 一天的毫秒数（verifyDayMS 是生产代码里的常量，这里另起名字避免冲突）
func testDayMS() int64 { return 24 * 60 * 60 * 1000 }

// ---------------------------------------------------------------------------
// RecordVerifyEvent
// ---------------------------------------------------------------------------

func TestRecordVerifyEventStoresAllColumns(t *testing.T) {
	db, repo := newTestRepo(t)
	ctx := context.Background()

	before := time.Now().UnixMilli()
	elapsed := int64(1234)
	difficulty := int64(1000000)
	asn := int64(64512)

	repo.RecordVerifyEvent(ctx, model.VerifyRecordInput{
		Event:       model.VerifyEventPass,
		ElapsedMs:   &elapsed,
		Difficulty:  &difficulty,
		ChallengeID: "cid-1",
		PostSlug:    "/posts/x",
		IP:          "203.0.113.5",
		ASN:         &asn,
	})
	after := time.Now().UnixMilli()

	rows := readVerifyRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("应写入 1 条记录，实际 %d 条", len(rows))
	}
	row := rows[0]
	if row.Event != model.VerifyEventPass {
		t.Errorf("event 期望 %q，实际 %q", model.VerifyEventPass, row.Event)
	}
	// created_at 必须是写入时刻的毫秒整数
	if row.CreatedAt < before || row.CreatedAt > after {
		t.Errorf("created_at 期望在 [%d, %d] 之间，实际 %d", before, after, row.CreatedAt)
	}
	if !row.ElapsedMs.Valid || row.ElapsedMs.Int64 != 1234 {
		t.Errorf("elapsed_ms 期望 1234，实际 %v", row.ElapsedMs)
	}
	if !row.Difficulty.Valid || row.Difficulty.Int64 != 1000000 {
		t.Errorf("difficulty 期望 1000000，实际 %v", row.Difficulty)
	}
	if !row.ChallengeID.Valid || row.ChallengeID.String != "cid-1" {
		t.Errorf("challenge_id 期望 cid-1，实际 %v", row.ChallengeID)
	}
	if !row.PostSlug.Valid || row.PostSlug.String != "/posts/x" {
		t.Errorf("post_slug 期望 /posts/x，实际 %v", row.PostSlug)
	}
	if !row.IPAddress.Valid || row.IPAddress.String != "203.0.113.5" {
		t.Errorf("ip_address 期望 203.0.113.5，实际 %v", row.IPAddress)
	}
	if !row.ASN.Valid || row.ASN.Int64 != 64512 {
		t.Errorf("asn 期望 64512，实际 %v", row.ASN)
	}
	// 空字符串必须落成 NULL（与 Node/Worker 的 ?? null 一致），而不是空串
	if row.Reason.Valid || row.Country.Valid || row.Network.Valid {
		t.Errorf("空的 reason/country/network 应为 NULL，实际 %v / %v / %v",
			row.Reason, row.Country, row.Network)
	}

	// 全部可选字段都缺省时，一律写 NULL
	repo.RecordVerifyEvent(ctx, model.VerifyRecordInput{Event: model.VerifyEventFail})

	rows = readVerifyRows(t, db)
	empty := rows[len(rows)-1]
	if empty.Reason.Valid || empty.ElapsedMs.Valid || empty.Difficulty.Valid ||
		empty.ChallengeID.Valid || empty.PostSlug.Valid || empty.IPAddress.Valid ||
		empty.Country.Valid || empty.Network.Valid || empty.ASN.Valid {
		t.Errorf("缺省的可选字段必须全部为 NULL，实际 %+v", empty)
	}

	// 文本字段在数据库里必须是 NULL 而不是空串
	var nulls int
	if err := db.Get(&nulls, `SELECT COUNT(*) FROM VerifyRecord
		WHERE id = ? AND reason IS NULL AND challenge_id IS NULL AND post_slug IS NULL AND ip_address IS NULL`,
		empty.ID); err != nil {
		t.Fatalf("检查 NULL 失败: %v", err)
	}
	if nulls != 1 {
		t.Errorf("空字符串应写为 NULL（IS NULL 判定），实际不满足")
	}
}

func TestRecordVerifyEventSkipsChallengeWhenLogDisabled(t *testing.T) {
	db, repo := newTestRepo(t)
	ctx := context.Background()

	setVerifySetting(t, db, "comment_verify_log_challenge", "false")

	repo.RecordVerifyEvent(ctx, model.VerifyRecordInput{Event: model.VerifyEventChallenge, ChallengeID: "cid-1"})
	if n := countVerifyRows(t, db); n != 0 {
		t.Errorf("关闭签发记录后不应写入 challenge 事件，实际 %d 条", n)
	}

	// 通过/失败事件不受该开关影响
	repo.RecordVerifyEvent(ctx, model.VerifyRecordInput{Event: model.VerifyEventPass})
	repo.RecordVerifyEvent(ctx, model.VerifyRecordInput{Event: model.VerifyEventFail, Reason: "bad nonce"})
	rows := readVerifyRows(t, db)
	if len(rows) != 2 {
		t.Fatalf("pass / fail 事件仍应落库，实际 %d 条", len(rows))
	}
	if rows[0].Event != model.VerifyEventPass || rows[1].Event != model.VerifyEventFail {
		t.Errorf("事件类型不正确: %+v", rows)
	}

	// 非 "false" 的取值（含空值）都算开启
	for _, value := range []string{"true", "", "1"} {
		setVerifySetting(t, db, "comment_verify_log_challenge", value)
		before := countVerifyRows(t, db)
		repo.RecordVerifyEvent(ctx, model.VerifyRecordInput{Event: model.VerifyEventChallenge})
		if got := countVerifyRows(t, db); got != before+1 {
			t.Errorf("comment_verify_log_challenge=%q 时应记录签发事件，实际 %d -> %d", value, before, got)
		}
	}
}

// ---------------------------------------------------------------------------
// PruneVerifyRecords
// ---------------------------------------------------------------------------

func TestPruneVerifyRecordsRetentionDays(t *testing.T) {
	day := testDayMS()

	for _, tc := range []struct {
		name        string
		setting     string
		wantRemoved int64
		wantLeft    int
	}{
		{"缺省保留 30 天", "", 1, 2},
		{"显式保留 7 天", "7", 2, 1},
		{"0 表示永久保留", "0", 0, 3},
		{"负数按永久保留处理", "-5", 0, 3},
		{"非法值回退默认 30 天", "abc", 1, 2},
		{"超上限夹到 3650 天", "99999", 0, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, repo := newTestRepo(t)
			setVerifySetting(t, db, "comment_verify_retention_days", tc.setting)

			now := time.Now().UnixMilli()
			insertVerifyRow(t, db, now, model.VerifyEventChallenge)
			insertVerifyRow(t, db, now-10*day, model.VerifyEventPass)
			insertVerifyRow(t, db, now-40*day, model.VerifyEventFail)

			removed, err := repo.PruneVerifyRecords(context.Background())
			if err != nil {
				t.Fatalf("PruneVerifyRecords 失败: %v", err)
			}
			if removed != tc.wantRemoved {
				t.Errorf("removed 期望 %d，实际 %d", tc.wantRemoved, removed)
			}
			if left := countVerifyRows(t, db); left != tc.wantLeft {
				t.Errorf("剩余条数期望 %d，实际 %d", tc.wantLeft, left)
			}
		})
	}
}

func TestPruneVerifyRecordsKeepsBoundaryRow(t *testing.T) {
	db, repo := newTestRepo(t)
	setVerifySetting(t, db, "comment_verify_retention_days", "7")

	// 严格早于 cutoff 才会被删：正好 7 天前的记录（毫秒级的当前时刻）必须保留
	now := time.Now().UnixMilli()
	insertVerifyRow(t, db, now-7*testDayMS()+1000, model.VerifyEventChallenge)
	insertVerifyRow(t, db, now-7*testDayMS()-1000, model.VerifyEventChallenge)

	removed, err := repo.PruneVerifyRecords(context.Background())
	if err != nil {
		t.Fatalf("PruneVerifyRecords 失败: %v", err)
	}
	if removed != 1 {
		t.Errorf("只应删除超出保留期的那一条，实际 %d", removed)
	}
}

// ---------------------------------------------------------------------------
// 时间窗口与格式化（三端共享的口径）
// ---------------------------------------------------------------------------

func requireWindow(t *testing.T, win verifyWindow, bucket string, wantKeys []string, wantStart, wantEnd int64) {
	t.Helper()
	if win.Bucket != bucket {
		t.Errorf("bucket 期望 %q，实际 %q", bucket, win.Bucket)
	}
	if win.Start != wantStart {
		t.Errorf("start 期望 %d，实际 %d", wantStart, win.Start)
	}
	if win.End != wantEnd {
		t.Errorf("end 期望 %d，实际 %d", wantEnd, win.End)
	}
	if len(win.Keys) != len(wantKeys) {
		t.Fatalf("分桶数期望 %d，实际 %d（%v）", len(wantKeys), len(win.Keys), win.Keys)
	}
	for i := range wantKeys {
		if win.Keys[i] != wantKeys[i] {
			t.Errorf("分桶键[%d] 期望 %q，实际 %q", i, wantKeys[i], win.Keys[i])
		}
	}
}

func TestResolveVerifyWindowBuckets(t *testing.T) {
	// 固定时刻，避免用例受运行时间影响
	now := time.Date(2026, 4, 27, 14, 35, 7, 0, time.UTC).UnixMilli()
	utc := func(y int, m time.Month, d, h int) int64 {
		return time.Date(y, m, d, h, 0, 0, 0, time.UTC).UnixMilli()
	}

	t.Run("7 天按天分桶", func(t *testing.T) {
		win := resolveVerifyWindow(7, 0, now)
		requireWindow(t, win, "day", []string{
			"2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24",
			"2026-04-25", "2026-04-26", "2026-04-27",
		}, utc(2026, 4, 21, 0), utc(2026, 4, 28, 0))
	})

	t.Run("1 天按小时分桶", func(t *testing.T) {
		win := resolveVerifyWindow(1, 0, now)
		if len(win.Keys) != 24 {
			t.Fatalf("小时分桶应为 24 个，实际 %d", len(win.Keys))
		}
		if win.Keys[0] != "2026-04-26T15" {
			t.Errorf("首个分桶键期望 2026-04-26T15，实际 %q", win.Keys[0])
		}
		if win.Keys[len(win.Keys)-1] != "2026-04-27T14" {
			t.Errorf("最后一个分桶键期望 2026-04-27T14，实际 %q", win.Keys[len(win.Keys)-1])
		}
		requireWindow(t, win, "hour", win.Keys, utc(2026, 4, 26, 15), utc(2026, 4, 27, 15))
	})

	t.Run("0 / all 按月分桶", func(t *testing.T) {
		win := resolveVerifyWindow(0, 0, now)
		requireWindow(t, win, "month", []string{
			"2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10",
			"2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
		}, utc(2025, 5, 1, 0), utc(2026, 5, 1, 0))
	})

	t.Run("offset 把窗口整体前移", func(t *testing.T) {
		win := resolveVerifyWindow(7, 1, now)
		requireWindow(t, win, "day", []string{
			"2026-04-14", "2026-04-15", "2026-04-16", "2026-04-17",
			"2026-04-18", "2026-04-19", "2026-04-20",
		}, utc(2026, 4, 14, 0), utc(2026, 4, 21, 0))

		monthWin := resolveVerifyWindow(0, 1, now)
		if len(monthWin.Keys) != 12 || monthWin.Keys[0] != "2025-04" || monthWin.Keys[11] != "2026-03" {
			t.Errorf("按月分桶 offset=1 期望 2025-04..2026-03，实际 %v", monthWin.Keys)
		}
	})

	t.Run("负 offset 按 0 处理", func(t *testing.T) {
		base := resolveVerifyWindow(7, 0, now)
		negative := resolveVerifyWindow(7, -3, now)
		requireWindow(t, negative, base.Bucket, base.Keys, base.Start, base.End)
	})
}

func TestISOMillisFormatting(t *testing.T) {
	for _, tc := range []struct {
		name string
		ms   int64
		want string
	}{
		{"Unix 纪元", 0, "1970-01-01T00:00:00.000Z"},
		{"毫秒补齐 3 位", time.Date(2026, 4, 27, 1, 2, 3, 7*int(time.Millisecond), time.UTC).UnixMilli(),
			"2026-04-27T01:02:03.007Z"},
		{"毫秒为 0", time.Date(2026, 4, 27, 14, 35, 7, 0, time.UTC).UnixMilli(),
			"2026-04-27T14:35:07.000Z"},
		{"毫秒为整百", time.Date(2026, 4, 27, 14, 35, 7, 100*int(time.Millisecond), time.UTC).UnixMilli(),
			"2026-04-27T14:35:07.100Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := isoMillis(tc.ms)
			if got != tc.want {
				t.Errorf("isoMillis(%d) 期望 %q，实际 %q", tc.ms, tc.want, got)
			}
			if len(got) != 24 {
				t.Errorf("毫秒 ISO 必须固定 24 个字符，实际 %d（%q）", len(got), got)
			}
		})
	}
}
