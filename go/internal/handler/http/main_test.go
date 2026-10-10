package http

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
	"momo-backend-go/internal/repository"
	"momo-backend-go/internal/repository/sqlite"

	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

// 测试共享的数据库、仓库与路由。
//
// 关键约束：utils.InitSettingsDB 使用 sync.Once，一个测试二进制只能初始化一次，
// 因此所有 handler 用例共用同一个临时文件数据库；用例之间通过清空表数据隔离。
var (
	testDB      *sqlx.DB
	testRepo    repository.CommentRepository
	testRouter  *gin.Engine
	testHandler *CommentHandler
)

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	// 静音 gin 的日志与 panic 恢复输出，保持测试输出干净
	gin.DefaultWriter = io.Discard
	gin.DefaultErrorWriter = io.Discard

	dir, err := os.MkdirTemp("", "momo-http-test")
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

	utils.InitSettingsDB(db)
	// 强制不信任代理头：GetClientIP 只依赖 RemoteAddr，测试才能精确控制来源 IP
	disabled := false
	utils.SetTrustProxyOverride(&disabled, "test")

	testDB = db
	testRepo = sqlite.NewCommentRepository(db)
	testHandler = &CommentHandler{Repo: testRepo, Version: "test-version"}

	testRouter = gin.New()
	// 生产环境 main.go 使用 gin.Default()（含 Logger + Recovery），这里补上 Recovery 以保持一致：
	// 未捕获的 panic 会被兜底为 500，而不是让测试进程崩溃
	testRouter.Use(gin.Recovery())
	RegisterRoutes(testRouter, testHandler)

	code := m.Run()

	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// maxLoginAttempts 与 utils/auth.go 中 LoginLimiter 的默认上限保持一致（5 次）
const maxLoginAttempts = 5

// ---------------------------------------------------------------------------
// 隔离与清理
// ---------------------------------------------------------------------------

// truncateAll 清空所有业务表并吊销全部 token
func truncateAll() {
	if testDB != nil {
		// VerifyRecord 也必须清空：认证记录的用例会断言「恰好 N 条」，
		// 残留行会让后续用例出现假失败
		for _, table := range []string{"Comment", "Settings", "EmailVerification", "VerifyRecord"} {
			_, _ = testDB.Exec("DELETE FROM " + table)
		}
		_, _ = testDB.Exec("DELETE FROM sqlite_sequence")
	}
	utils.ClearAllTokens()
}

// resetState 在用例开始前清理数据，并在结束时再清理一次
func resetState(t *testing.T) {
	t.Helper()
	truncateAll()
	t.Cleanup(truncateAll)
}

// ---------------------------------------------------------------------------
// 请求辅助
// ---------------------------------------------------------------------------

var ipCounter int64

// nextIP 生成互不相同的测试来源 IP，避免 60 秒评论限流互相干扰
func nextIP() string {
	n := atomic.AddInt64(&ipCounter, 1)
	return fmt.Sprintf("10.%d.%d.%d", byte(n>>16), byte(n>>8), byte(n))
}

// nextRemoteAddr 生成 RemoteAddr（IP:端口）
func nextRemoteAddr() string {
	return nextIP() + ":34567"
}

// call 构造并执行一次请求
func call(t *testing.T, method, target, body string, headers map[string]string, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if remoteAddr == "" {
		remoteAddr = nextRemoteAddr()
	}
	req.RemoteAddr = remoteAddr

	w := httptest.NewRecorder()
	testRouter.ServeHTTP(w, req)
	return w
}

// callJSON 以默认无认证头执行请求
func callJSON(t *testing.T, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, method, target, body, nil, "")
}

// callFromIP 指定来源 IP 执行请求
func callFromIP(t *testing.T, method, target, body, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, method, target, body, nil, remoteAddr)
}

// callWithToken 带 Bearer token 执行请求
func callWithToken(t *testing.T, method, target, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, method, target, body, map[string]string{"Authorization": "Bearer " + token}, "")
}

// decodeJSON 把响应体解析为通用 map
func decodeJSON(t *testing.T, w *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("响应不是合法 JSON: %v；body=%s", err, w.Body.String())
	}
	return m
}

// decodeInto 把响应体解析为指定结构
func decodeInto(t *testing.T, w *httptest.ResponseRecorder, v interface{}) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("响应解析失败: %v；body=%s", err, w.Body.String())
	}
}

// requireStatus 断言 HTTP 状态码
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("HTTP 状态码期望 %d，实际 %d；body=%s", want, w.Code, w.Body.String())
	}
}

// requireBodyCode 断言响应体中的 code 字段与 HTTP 状态码一致
func requireBodyCode(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	m := decodeJSON(t, w)
	got, ok := m["code"].(float64)
	if !ok {
		t.Fatalf("响应缺少 code 字段: %s", w.Body.String())
	}
	if int(got) != want {
		t.Errorf("响应体 code 期望 %d，实际 %d", want, int(got))
	}
	if w.Code != want {
		t.Errorf("HTTP 状态码应与响应体 code 一致，期望 %d，实际 %d", want, w.Code)
	}
}

// queryEscape 对查询参数值做 URL 编码（避免 httptest.NewRequest 因非法 URL 解析失败）
func queryEscape(s string) string {
	return url.QueryEscape(s)
}

// regexpMatch 判断字符串是否匹配正则（用于日期格式断言）
func regexpMatch(pattern, s string) bool {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return false
	}
	return re.MatchString(s)
}

// ---------------------------------------------------------------------------
// 数据辅助
// ---------------------------------------------------------------------------

// adminToken 直接签发一个有效 token（不经过登录流程）
func adminToken(t *testing.T) string {
	t.Helper()
	token := utils.GenerateTempKey("momo")
	if token == "" {
		t.Fatalf("签发 token 失败")
	}
	return token
}

// loginToken 通过 /admin/login 登录并返回 token
func loginToken(t *testing.T) string {
	t.Helper()
	w := callJSON(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`)
	requireStatus(t, w, 200)
	m := decodeJSON(t, w)
	token, _ := m["token"].(string)
	if token == "" {
		t.Fatalf("登录响应缺少 token: %s", w.Body.String())
	}
	return token
}

// setSetting 直接写入设置（等价于后台保存设置）
func setSetting(t *testing.T, key, value string) {
	t.Helper()
	if err := utils.SetSetting(key, value); err != nil {
		t.Fatalf("写入设置 %s=%q 失败: %v", key, value, err)
	}
}

// commentByID 读取数据库中的评论
func commentByID(t *testing.T, id int64) *model.Comment {
	t.Helper()
	c, err := testRepo.GetByID(t.Context(), id)
	if err != nil {
		t.Fatalf("读取评论 id=%d 失败: %v", id, err)
	}
	return c
}

// latestComment 返回 id 最大（最后插入）的评论
func latestComment(t *testing.T) *model.Comment {
	t.Helper()
	var c model.Comment
	if err := testDB.Get(&c, "SELECT * FROM Comment ORDER BY id DESC LIMIT 1"); err != nil {
		t.Fatalf("读取最新评论失败: %v", err)
	}
	return &c
}

// countComments 统计评论总数
func countComments(t *testing.T) int {
	t.Helper()
	var n int
	if err := testDB.Get(&n, "SELECT COUNT(*) FROM Comment"); err != nil {
		t.Fatalf("统计评论失败: %v", err)
	}
	return n
}

// seedComment 直接写入一条评论（绕过 HTTP 层）。
// 调用方需显式给出 PubDate；Status 为空时按 approved 处理。
func seedComment(t *testing.T, c *model.Comment) *model.Comment {
	t.Helper()
	if c.Status == "" {
		c.Status = "approved"
	}
	if err := testRepo.Create(t.Context(), c); err != nil {
		t.Fatalf("写入评论失败: %v", err)
	}
	return c
}

// postCommentBody 拼装一个合法的提交评论请求体
func postCommentBody(slug, author, email, content string) string {
	return fmt.Sprintf(`{"post_slug":%q,"author":%q,"email":%q,"content":%q}`, slug, author, email, content)
}
