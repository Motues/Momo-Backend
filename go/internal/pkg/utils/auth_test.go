package utils

import (
	"encoding/hex"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// newTestLimiter 构造隔离的登录限流器，避免污染全局 Limiter
func newTestLimiter(maxAttempts int, blockDuration time.Duration) *LoginLimiter {
	return &LoginLimiter{
		attempts:      make(map[string]int),
		blockedUntil:  make(map[string]time.Time),
		maxAttempts:   maxAttempts,
		blockDuration: blockDuration,
	}
}

// newGinContextForIP 构造一个带指定 RemoteAddr / 请求头的 gin 上下文
func newGinContextForIP(remoteAddr string, headers map[string]string) *gin.Context {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET", "/api/comments", nil)
	c.Request.RemoteAddr = remoteAddr
	for k, v := range headers {
		c.Request.Header.Set(k, v)
	}
	return c
}

// ---------------------------------------------------------------------------
// 登录失败锁定策略
// ---------------------------------------------------------------------------

func TestLoginLimiterDefaults(t *testing.T) {
	if Limiter.maxAttempts != 5 {
		t.Errorf("全局限流器默认最大尝试次数应为 5，实际 %d", Limiter.maxAttempts)
	}
	if Limiter.blockDuration != 30*time.Minute {
		t.Errorf("全局限流器默认封禁时长应为 30 分钟，实际 %v", Limiter.blockDuration)
	}
	if Limiter.attempts == nil || Limiter.blockedUntil == nil {
		t.Errorf("全局限流器的内部 map 必须已初始化，否则写入会 panic")
	}
}

func TestLoginLimiterLockoutFlow(t *testing.T) {
	for _, tc := range []struct {
		name string
		max  int
	}{
		{"上限 1：首次失败即封禁", 1},
		{"上限 3：第 3 次失败封禁", 3},
		{"上限 5（生产默认）：第 5 次失败封禁", 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := newTestLimiter(tc.max, time.Minute)
			ip := "10.1.2.3"

			if l.IsIPBlocked(ip) {
				t.Fatalf("初始状态不应被封禁")
			}
			for i := 1; i <= tc.max; i++ {
				blocked := l.RecordAttempt(ip)
				if i < tc.max && blocked {
					t.Fatalf("第 %d 次失败不应触发封禁", i)
				}
				if i == tc.max && !blocked {
					t.Fatalf("第 %d 次失败应触发封禁", i)
				}
			}
			if !l.IsIPBlocked(ip) {
				t.Errorf("达到失败上限后 IsIPBlocked 应为 true")
			}

			l.ResetAttempt(ip)
			if l.IsIPBlocked(ip) {
				t.Errorf("ResetAttempt 之后不应再被封禁")
			}
			if blocked := l.RecordAttempt(ip); blocked && tc.max > 1 {
				t.Errorf("重置后计数应从头开始，第 1 次失败不应立即封禁")
			}
		})
	}
}

func TestLoginLimiterBlockExpiry(t *testing.T) {
	l := newTestLimiter(2, time.Minute)
	ip := "10.2.2.2"

	l.RecordAttempt(ip)
	l.RecordAttempt(ip)
	if !l.IsIPBlocked(ip) {
		t.Fatalf("两次失败（上限 2）后应处于封禁状态")
	}

	// 手工把封禁截止时间改到过去，模拟封禁到期
	l.mu.Lock()
	l.blockedUntil[ip] = time.Now().Add(-time.Second)
	l.mu.Unlock()

	if l.IsIPBlocked(ip) {
		t.Errorf("封禁到期后应立即放行")
	}

	l.mu.Lock()
	_, stillBlocked := l.blockedUntil[ip]
	attempts := l.attempts[ip]
	l.mu.Unlock()

	if stillBlocked {
		t.Errorf("封禁到期后应清理 blockedUntil 记录")
	}
	if attempts != 0 {
		t.Errorf("封禁到期后应同时清理失败计数，实际残留 %d", attempts)
	}
}

func TestLoginLimiterIndependentIPs(t *testing.T) {
	l := newTestLimiter(2, time.Minute)
	l.RecordAttempt("1.1.1.1")
	l.RecordAttempt("1.1.1.1")

	if !l.IsIPBlocked("1.1.1.1") {
		t.Fatalf("1.1.1.1 应被封禁")
	}
	if l.IsIPBlocked("2.2.2.2") {
		t.Errorf("其他 IP 不应受牵连")
	}
	if l.RecordAttempt("2.2.2.2") {
		t.Errorf("其他 IP 的第 1 次失败不应触发封禁")
	}
}

func TestLoginLimiterConcurrentRecordAttempt(t *testing.T) {
	const n = 32
	l := newTestLimiter(n, time.Minute)
	ip := "10.3.3.3"

	var wg sync.WaitGroup
	var mu sync.Mutex
	blockedCount := 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.RecordAttempt(ip) {
				mu.Lock()
				blockedCount++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if blockedCount != 1 {
		t.Errorf("并发 %d 次失败应恰好触发 1 次封禁，实际 %d 次", n, blockedCount)
	}
}

// ---------------------------------------------------------------------------
// Token 签发 / 校验 / 吊销
// ---------------------------------------------------------------------------

func TestGenerateTempKeyCreatesValidToken(t *testing.T) {
	ClearAllTokens()
	defer ClearAllTokens()

	token := GenerateTempKey("momo")

	if len(token) != 64 {
		t.Errorf("token 应为 32 字节的十六进制串（64 字符），实际长度 %d", len(token))
	}
	if _, err := hex.DecodeString(token); err != nil {
		t.Errorf("token 必须是合法十六进制串，实际 %q: %v", token, err)
	}
	if !IsTokenValid(token) {
		t.Errorf("刚签发的 token 必须有效")
	}

	other := GenerateTempKey("momo")
	if other == token {
		t.Errorf("两次签发的 token 不应相同（必须使用 CSPRNG）")
	}

	// 有效期应为 20 分钟
	TokenStore.RLock()
	exp, ok := TokenStore.Map[token]
	TokenStore.RUnlock()
	if !ok {
		t.Fatalf("签发的 token 未写入 TokenStore")
	}
	remaining := time.Until(exp)
	if remaining < 19*time.Minute || remaining > 21*time.Minute {
		t.Errorf("token 有效期应约为 20 分钟，实际剩余 %v", remaining)
	}
}

func TestIsTokenValidRejectsBadTokens(t *testing.T) {
	ClearAllTokens()
	defer ClearAllTokens()

	valid := GenerateTempKey("momo")

	for _, tc := range []struct {
		name  string
		token string
	}{
		{"空字符串", ""},
		{"空白字符串", "   "},
		{"随机串", "deadbeefdeadbeef"},
		{"被追加字符的合法 token", valid + "0"},
		{"被截断的合法 token", valid[:len(valid)-1]},
		{"被篡改的合法 token", "f" + valid[1:]},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if IsTokenValid(tc.token) {
				t.Errorf("非法 token %q 不应通过校验", tc.token)
			}
		})
	}

	if !IsTokenValid(valid) {
		t.Errorf("合法 token 应通过校验")
	}
}

func TestIsTokenValidExpiredTokenIsRemoved(t *testing.T) {
	ClearAllTokens()
	defer ClearAllTokens()

	token := GenerateTempKey("momo")

	TokenStore.Lock()
	TokenStore.Map[token] = time.Now().Add(-time.Second)
	TokenStore.Unlock()

	if IsTokenValid(token) {
		t.Errorf("过期 token 不应通过校验")
	}

	TokenStore.RLock()
	_, exists := TokenStore.Map[token]
	TokenStore.RUnlock()
	if exists {
		t.Errorf("校验发现过期后应顺手删除该 token，避免内存泄漏")
	}
}

func TestRevokeToken(t *testing.T) {
	ClearAllTokens()
	defer ClearAllTokens()

	a := GenerateTempKey("momo")
	b := GenerateTempKey("momo")

	RevokeToken(a)

	if IsTokenValid(a) {
		t.Errorf("被吊销的 token 不应有效")
	}
	if !IsTokenValid(b) {
		t.Errorf("吊销单个 token 不应影响其他会话")
	}

	// 吊销不存在的 token 不应 panic
	RevokeToken("not-exist")
	RevokeToken("")
}

func TestClearAllTokens(t *testing.T) {
	ClearAllTokens()

	tokens := []string{GenerateTempKey("a"), GenerateTempKey("b"), GenerateTempKey("c")}
	ClearAllTokens()

	for _, token := range tokens {
		if IsTokenValid(token) {
			t.Errorf("ClearAllTokens 后 token %q 不应有效", token)
		}
	}

	TokenStore.RLock()
	size := len(TokenStore.Map)
	TokenStore.RUnlock()
	if size != 0 {
		t.Errorf("ClearAllTokens 后 TokenStore 应为空，实际 %d 项", size)
	}
}

func TestCleanupExpiredTokens(t *testing.T) {
	ClearAllTokens()
	defer ClearAllTokens()

	live := GenerateTempKey("momo")
	expired1 := GenerateTempKey("momo")
	expired2 := GenerateTempKey("momo")

	TokenStore.Lock()
	TokenStore.Map[expired1] = time.Now().Add(-time.Minute)
	TokenStore.Map[expired2] = time.Now().Add(-24 * time.Hour)
	TokenStore.Unlock()

	if removed := CleanupExpiredTokens(); removed != 2 {
		t.Errorf("应清理 2 个过期 token，实际 %d", removed)
	}
	if !IsTokenValid(live) {
		t.Errorf("未过期的 token 不应被清理")
	}
	if removed := CleanupExpiredTokens(); removed != 0 {
		t.Errorf("再次清理应无可清理项，实际 %d", removed)
	}
}

func TestStartTokenJanitorCleansExpiredTokens(t *testing.T) {
	ClearAllTokens()
	defer ClearAllTokens()

	token := GenerateTempKey("momo")
	TokenStore.Lock()
	TokenStore.Map[token] = time.Now().Add(-time.Minute)
	TokenStore.Unlock()

	// 用很短的周期启动 janitor（StartTokenJanitor 只接受 interval 参数）
	StartTokenJanitor(10 * time.Millisecond)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		TokenStore.RLock()
		_, exists := TokenStore.Map[token]
		TokenStore.RUnlock()
		if !exists {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("janitor 未在 3 秒内清理过期 token")
}

func TestStartTokenJanitorNonPositiveIntervalDoesNotPanic(t *testing.T) {
	// interval <= 0 时回退为 10 分钟，仅验证不 panic、可正常返回
	StartTokenJanitor(0)
	StartTokenJanitor(-time.Second)
}

// ---------------------------------------------------------------------------
// 客户端 IP 解析
// ---------------------------------------------------------------------------

func TestGetClientIPTrustProxyDisabled(t *testing.T) {
	resetSettings(t)
	disabled := false
	SetTrustProxyOverride(&disabled, "test")
	t.Cleanup(func() { SetTrustProxyOverride(nil, "") })

	for _, tc := range []struct {
		name       string
		remoteAddr string
		want       string
	}{
		{"IPv4 带端口", "203.0.113.7:5678", "203.0.113.7"},
		{"IPv4 不带端口", "203.0.113.8", "203.0.113.8"},
		{"IPv6 带端口", "[2001:db8::1]:443", "2001:db8::1"},
		{"IPv6 方括号不带端口", "[::1]", "::1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newGinContextForIP(tc.remoteAddr, map[string]string{
				// 关闭信任代理时，这些头必须被完全忽略
				"CF-Connecting-IP": "1.1.1.1",
				"X-Real-IP":        "2.2.2.2",
				"X-Forwarded-For":  "3.3.3.3",
			})
			if got := GetClientIP(c); got != tc.want {
				t.Errorf("RemoteAddr=%q 期望 %q，实际 %q", tc.remoteAddr, tc.want, got)
			}
		})
	}
}

func TestGetClientIPTrustProxyEnabled(t *testing.T) {
	resetSettings(t)
	enabled := true
	SetTrustProxyOverride(&enabled, "test")
	t.Cleanup(func() { SetTrustProxyOverride(nil, "") })

	for _, tc := range []struct {
		name       string
		headers    map[string]string
		remoteAddr string
		want       string
	}{
		{
			"CF-Connecting-IP 优先级最高",
			map[string]string{"CF-Connecting-IP": "1.1.1.1", "X-Real-IP": "2.2.2.2", "X-Forwarded-For": "3.3.3.3"},
			"203.0.113.1:1000", "1.1.1.1",
		},
		{
			"CF-Connecting-IP 非法时回落 X-Real-IP",
			map[string]string{"CF-Connecting-IP": "not-an-ip", "X-Real-IP": "2.2.2.2", "X-Forwarded-For": "3.3.3.3"},
			"203.0.113.1:1000", "2.2.2.2",
		},
		{
			"CF/X-Real-IP 都非法时回落 X-Forwarded-For",
			map[string]string{"CF-Connecting-IP": "  ", "X-Real-IP": "bogus", "X-Forwarded-For": "3.3.3.3"},
			"203.0.113.1:1000", "3.3.3.3",
		},
		{
			"X-Forwarded-For 取最右一跳（防客户端伪造前缀）",
			map[string]string{"X-Forwarded-For": "6.6.6.6, 7.7.7.7, 8.8.8.8"},
			"203.0.113.1:1000", "8.8.8.8",
		},
		{
			"X-Forwarded-For 最右非法时继续向左",
			map[string]string{"X-Forwarded-For": "6.6.6.6, bogus"},
			"203.0.113.1:1000", "6.6.6.6",
		},
		{
			"X-Forwarded-For 全部非法时回落 TCP 对端",
			map[string]string{"X-Forwarded-For": "bogus, ???"},
			"203.0.113.9:1000", "203.0.113.9",
		},
		{
			"IPv6 带端口的代理头被归一化",
			map[string]string{"CF-Connecting-IP": "[::1]:1234"},
			"203.0.113.1:1000", "::1",
		},
		{
			"IPv4-mapped IPv6 被归一化为 IPv4",
			map[string]string{"CF-Connecting-IP": "::ffff:1.2.3.4"},
			"203.0.113.1:1000", "1.2.3.4",
		},
		{
			"没有任何代理头时使用 TCP 对端",
			map[string]string{},
			"203.0.113.10:1000", "203.0.113.10",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newGinContextForIP(tc.remoteAddr, tc.headers)
			if got := GetClientIP(c); got != tc.want {
				t.Errorf("期望 %q，实际 %q", tc.want, got)
			}
		})
	}
}

func TestGetClientIPFallsBackToPageSetting(t *testing.T) {
	resetSettings(t)
	SetTrustProxyOverride(nil, "")
	t.Cleanup(func() { SetTrustProxyOverride(nil, "") })

	setSetting(t, "trust_proxy", "true")
	c := newGinContextForIP("203.0.113.1:1000", map[string]string{"CF-Connecting-IP": "1.1.1.1"})
	if got := GetClientIP(c); got != "1.1.1.1" {
		t.Errorf("页面设置 trust_proxy=true 时应采用代理头，实际 %q", got)
	}

	// 其他取值都必须视为关闭
	for _, value := range []string{"false", "True", "1", "yes", ""} {
		setSetting(t, "trust_proxy", value)
		if got := GetClientIP(c); got != "203.0.113.1" {
			t.Errorf("trust_proxy=%q 时应使用 TCP 对端，实际 %q", value, got)
		}
	}
}

func TestNormalizeAndValidateIP(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  string
	}{
		{"空字符串", "", ""},
		{"纯空白", "   ", ""},
		{"标准 IPv4", "1.2.3.4", "1.2.3.4"},
		{"IPv4 带空格", "  1.2.3.4  ", "1.2.3.4"},
		{"IPv4 带端口", "1.2.3.4:5678", "1.2.3.4"},
		{"IPv6 方括号带端口", "[2001:db8::1]:443", "2001:db8::1"},
		{"IPv6 方括号不带端口", "[::1]", "::1"},
		{"IPv4-mapped IPv6", "::ffff:1.2.3.4", "1.2.3.4"},
		{"IPv4-mapped IPv6 大写", "::FFFF:1.2.3.4", "1.2.3.4"},
		{"裸 IPv6", "2001:db8::1", "2001:db8::1"},
		{"非法字符串", "not-an-ip", ""},
		{"通配符", "*", ""},
		{"端口号不是 IP", "5678", ""},
		{"IPv4 越界", "999.1.1.1", ""},
		{"注入尝试", "1.1.1.1'; DROP TABLE Comment; --", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeAndValidateIP(tc.input); got != tc.want {
				t.Errorf("normalizeAndValidateIP(%q) 期望 %q，实际 %q", tc.input, tc.want, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 信任代理开关
// ---------------------------------------------------------------------------

func TestTrustProxyOverride(t *testing.T) {
	resetSettings(t)
	t.Cleanup(func() { SetTrustProxyOverride(nil, "") })

	// 1. 未指定：以页面设置为准（默认关闭）
	SetTrustProxyOverride(nil, "")
	if TrustProxyEnabled() {
		t.Errorf("未设置 trust_proxy 时应默认关闭")
	}
	if src := TrustProxyOverrideSource(); src != "" {
		t.Errorf("未指定覆盖时来源应为空串，实际 %q", src)
	}

	setSetting(t, "trust_proxy", "true")
	if !TrustProxyEnabled() {
		t.Errorf("页面设置 trust_proxy=true 时应开启")
	}

	// 2. 显式开启：来源标记为 env
	enabled := true
	SetTrustProxyOverride(&enabled, "env")
	if !TrustProxyEnabled() {
		t.Errorf("显式开启时应为 true")
	}
	if src := TrustProxyOverrideSource(); src != "env" {
		t.Errorf("来源应为 env，实际 %q", src)
	}

	// 3. 显式关闭：优先级高于页面设置
	disabled := false
	SetTrustProxyOverride(&disabled, "config")
	if TrustProxyEnabled() {
		t.Errorf("显式关闭时不应被页面设置覆盖")
	}
	if src := TrustProxyOverrideSource(); src != "config" {
		t.Errorf("来源应为 config，实际 %q", src)
	}

	// 4. 恢复 nil：重新以页面设置为准
	SetTrustProxyOverride(nil, "")
	if !TrustProxyEnabled() {
		t.Errorf("恢复为未指定后应重新读取页面设置（true）")
	}
}
