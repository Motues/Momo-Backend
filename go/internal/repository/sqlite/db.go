package sqlite

import (
	"strconv"

	"github.com/jmoiron/sqlx"
)

/*
SQLite 连接参数（全模块唯一的连接出口）。

**为什么需要 busy_timeout**：本仓库的写路径不止发生在请求协程里 —— 评论 / 链接同步 /
休眠提醒的邮件都在 goroutine 里异步发送，而「邮件发送日志（MailLog）」按口径就在最底层
的发送函数里落库，因此**后台 goroutine 也会写数据库**。

SQLite 默认是「一个写者」的模型，且 modernc 驱动的 busy_timeout 默认是 0：一旦后台 goroutine
持有写锁，前台请求的 INSERT/UPDATE（甚至提交期的读）会立刻拿到 SQLITE_BUSY 而失败 ——
一条日志把用户的评论提交打成 500，显然不可接受。

busy_timeout 让等待的语句在锁释放后自动重试，是 SQLite 并发使用的标准做法；
这里统一写进 DSN，保证连接池里**每个新连接**都带上它（PRAGMA 是按连接生效的）。
*/

// BusyTimeoutMs 忙等待上限（毫秒）：足以覆盖一条 INSERT/UPDATE 的持锁时间
const BusyTimeoutMs = 10000

// DSN 给数据库路径补上连接参数（busy_timeout）。
//
// modernc 驱动会把非 `file:` 前缀的 DSN 在第一个 `?` 处切开，因此直接拼接即可
// （Windows 路径里的 `C:\...` 不受影响）。
func DSN(path string) string {
	return path + "?_pragma=busy_timeout(" + strconv.Itoa(BusyTimeoutMs) + ")"
}

// OpenDB 打开 SQLite 连接（统一带上 busy_timeout）。
func OpenDB(path string) (*sqlx.DB, error) {
	return sqlx.Connect("sqlite", DSN(path))
}
