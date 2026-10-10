package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"momo-backend-go/internal/repository/sqlite"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

// testSettingsDB 是 utils 包测试共享的 Settings 数据库。
//
// 关键约束：InitSettingsDB 内部使用 sync.Once，同一个测试二进制（同一个包）
// 只能初始化一次，所以必须在 TestMain 里建库；各用例只清空表数据来保持隔离。
// 这也意味着本包内所有依赖 Settings 的用例共享同一个 *sqlx.DB。
var testSettingsDB *sqlx.DB

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "momo-utils-test")
	if err != nil {
		fmt.Fprintf(os.Stderr, "创建临时目录失败: %v\n", err)
		os.Exit(1)
	}

	db, err := sqlx.Connect("sqlite", filepath.Join(dir, "test.db"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "连接测试数据库失败: %v\n", err)
		_ = os.RemoveAll(dir)
		os.Exit(1)
	}
	if err := sqlite.InitSchema(db); err != nil {
		fmt.Fprintf(os.Stderr, "初始化表结构失败: %v\n", err)
		_ = db.Close()
		_ = os.RemoveAll(dir)
		os.Exit(1)
	}

	InitSettingsDB(db)
	testSettingsDB = db

	code := m.Run()

	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// clearSettingsTable 清空 Settings 表（忽略错误，仅用于测试隔离）
func clearSettingsTable() {
	if settingsDB == nil {
		return
	}
	_, _ = settingsDB.Exec("DELETE FROM Settings")
}

// clearUsedChallenges 清空进程级防重放表。
//
// usedChallenges 是内存状态，不会被 clearSettingsTable 重置；用例重复运行
// （-count=2）或同一进程内复用固定 challenge id 时，若不清理就会看到上一个
// 用例留下的「挑战已使用」，让断言变成假失败。
func clearUsedChallenges() {
	usedChallengesMu.Lock()
	usedChallenges = make(map[string]int64)
	usedChallengesMu.Unlock()
}

// resetSettings 在用例开始前清空 Settings 表与防重放表，并在用例结束后再次清空，
// 避免某个用例写入的配置（如 trust_proxy、comment_verify_enabled）或已兑换的挑战
// 影响其他用例。
func resetSettings(t *testing.T) {
	t.Helper()
	clearSettingsTable()
	clearUsedChallenges()
	t.Cleanup(func() {
		clearSettingsTable()
		clearUsedChallenges()
	})
}

// setSetting 写入一条设置，失败直接终止用例
func setSetting(t *testing.T, key, value string) {
	t.Helper()
	if err := SetSetting(key, value); err != nil {
		t.Fatalf("写入设置 %s=%q 失败: %v", key, value, err)
	}
}

// requireSetting 断言数据库中某项设置的值
func requireSetting(t *testing.T, key, want string) {
	t.Helper()
	if got := GetSetting(key); got != want {
		t.Errorf("设置 %s 期望 %q，实际 %q", key, want, got)
	}
}
