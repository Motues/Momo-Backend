package http

import (
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"momo-backend-go/internal/pkg/utils"
)

type loginPayload struct {
	Code               int    `json:"code"`
	Message            string `json:"message"`
	Token              string `json:"token"`
	NeedChangePassword bool   `json:"needChangePassword"`
}

// ---------------------------------------------------------------------------
// POST /admin/login
// ---------------------------------------------------------------------------

func TestAdminLoginSuccess(t *testing.T) {
	resetState(t)

	w := callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`, nextRemoteAddr())
	requireStatus(t, w, 200)

	var payload loginPayload
	decodeInto(t, w, &payload)

	if payload.Code != 200 {
		t.Errorf("code 期望 200，实际 %d", payload.Code)
	}
	if payload.Message != "Login successful" {
		t.Errorf("message 期望 Login successful，实际 %q", payload.Message)
	}
	if len(payload.Token) != 64 {
		t.Errorf("token 应为 64 位十六进制串，实际长度 %d（%q）", len(payload.Token), payload.Token)
	}
	if _, err := hex.DecodeString(payload.Token); err != nil {
		t.Errorf("token 应为合法十六进制: %v", err)
	}
	if !utils.IsTokenValid(payload.Token) {
		t.Errorf("登录返回的 token 必须有效")
	}
	if !payload.NeedChangePassword {
		t.Errorf("使用默认凭据登录时 needChangePassword 应为 true")
	}

	// token 立即可用于受保护接口
	w = callWithToken(t, "GET", "/admin/settings", "", payload.Token)
	requireStatus(t, w, 200)
}

func TestAdminLoginValidationFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"空请求体", ""},
		{"非法 JSON", "{"},
		{"JSON 数组", "[]"},
		{"JSON null", "null"},
		{"缺少 name", `{"password":"momo"}`},
		{"缺少 password", `{"name":"momo"}`},
		{"name 为空串", `{"name":"","password":"momo"}`},
		{"password 为空串", `{"name":"momo","password":""}`},
		{"name 非字符串", `{"name":123,"password":"momo"}`},
		{"password 非字符串", `{"name":"momo","password":true}`},
		{"name 为 null", `{"name":null,"password":"momo"}`},
		{"name 为对象", `{"name":{},"password":"momo"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			w := callFromIP(t, "POST", "/admin/login", tc.body, nextRemoteAddr())
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
		})
	}
}

func TestAdminLoginWrongCredentials(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"密码错误", `{"name":"momo","password":"wrong"}`},
		{"用户名错误", `{"name":"admin","password":"momo"}`},
		{"用户名与密码都错误", `{"name":"admin","password":"wrong"}`},
		{"大小写不同", `{"name":"MOMO","password":"MOMO"}`},
		{"空白字符", `{"name":" momo ","password":" momo "}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			ip := nextIP()
			t.Cleanup(func() { utils.Limiter.ResetAttempt(ip) })

			w := callFromIP(t, "POST", "/admin/login", tc.body, ip+":1234")
			requireStatus(t, w, 401)
			requireBodyCode(t, w, 401)

			var payload loginPayload
			decodeInto(t, w, &payload)
			if payload.Message != "Invalid username or password" {
				t.Errorf("message 期望 Invalid username or password，实际 %q", payload.Message)
			}
			if payload.Token != "" {
				t.Errorf("失败时不应返回 token，实际 %q", payload.Token)
			}
		})
	}
}

func TestAdminLoginLockoutAfterMaxAttempts(t *testing.T) {
	resetState(t)
	ip := nextIP()
	addr := ip + ":1234"
	t.Cleanup(func() { utils.Limiter.ResetAttempt(ip) })

	// 前 maxLoginAttempts-1 次失败返回 401
	for i := 1; i < maxLoginAttempts; i++ {
		w := callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"wrong"}`, addr)
		requireStatus(t, w, 401)
	}

	// 第 maxLoginAttempts 次失败起该 IP 被封禁（403）
	w := callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"wrong"}`, addr)
	requireStatus(t, w, 403)
	requireBodyCode(t, w, 403)

	// 封禁后即使凭据正确也应被拒绝
	w = callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`, addr)
	requireStatus(t, w, 403)
	requireBodyCode(t, w, 403)

	// 未被封禁的其他 IP 不受影响
	w = callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`, nextRemoteAddr())
	requireStatus(t, w, 200)

	// 手动解除封禁后可以再次登录
	utils.Limiter.ResetAttempt(ip)
	w = callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`, addr)
	requireStatus(t, w, 200)
}

// TestAdminLoginBlockedIPIsRejectedBeforeBodyParsing 封禁检查先于请求体解析：
// 即使请求体非法，被封禁的 IP 也应得到 403 而不是 400。
func TestAdminLoginBlockedIPIsRejectedBeforeBodyParsing(t *testing.T) {
	resetState(t)
	ip := nextIP()
	t.Cleanup(func() { utils.Limiter.ResetAttempt(ip) })

	for i := 0; i < maxLoginAttempts; i++ {
		utils.Limiter.RecordAttempt(ip)
	}
	if !utils.Limiter.IsIPBlocked(ip) {
		t.Fatalf("前置条件：IP 应处于封禁状态")
	}

	w := callFromIP(t, "POST", "/admin/login", "{invalid json", ip+":1234")
	requireStatus(t, w, 403)
	requireBodyCode(t, w, 403)
}

func TestAdminLoginResetsFailureCounterOnSuccess(t *testing.T) {
	resetState(t)
	ip := nextIP()
	addr := ip + ":1234"
	t.Cleanup(func() { utils.Limiter.ResetAttempt(ip) })

	// 两次失败
	for i := 0; i < 2; i++ {
		requireStatus(t, callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"wrong"}`, addr), 401)
	}
	// 登录成功后计数清零
	requireStatus(t, callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`, addr), 200)

	// 再失败 maxLoginAttempts-1 次仍不应封禁
	for i := 1; i < maxLoginAttempts; i++ {
		w := callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"wrong"}`, addr)
		requireStatus(t, w, 401)
	}
	// 累计到上限才封禁
	requireStatus(t, callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"wrong"}`, addr), 403)
}

func TestAdminLoginAfterPasswordChange(t *testing.T) {
	resetState(t)

	if err := utils.ChangeAdminPassword("newboss", "new-password-1"); err != nil {
		t.Fatalf("修改管理员密码失败: %v", err)
	}

	t.Run("新凭据可以登录且不再提示改密", func(t *testing.T) {
		w := callFromIP(t, "POST", "/admin/login", `{"name":"newboss","password":"new-password-1"}`, nextRemoteAddr())
		requireStatus(t, w, 200)

		var payload loginPayload
		decodeInto(t, w, &payload)
		if payload.NeedChangePassword {
			t.Errorf("已改密后 needChangePassword 应为 false")
		}
	})

	t.Run("默认凭据失效", func(t *testing.T) {
		w := callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`, nextRemoteAddr())
		requireStatus(t, w, 401)
	})

	t.Run("旧用户名失效", func(t *testing.T) {
		w := callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"new-password-1"}`, nextRemoteAddr())
		requireStatus(t, w, 401)
	})
}

// ---------------------------------------------------------------------------
// AuthMiddleware
// ---------------------------------------------------------------------------

// protectedRoutes 是 /admin 下需要鉴权的全部路由（与 router.go 保持一致）
var protectedRoutes = []struct {
	method string
	target string
	body   string
}{
	{"GET", "/admin/settings", ""},
	{"PUT", "/admin/settings", `{}`},
	{"POST", "/admin/settings/test-email", ""},
	{"PUT", "/admin/password", `{}`},
	{"POST", "/admin/logout", ""},
	{"GET", "/admin/comments/list", ""},
	{"PUT", "/admin/comments/status", ""},
	{"PUT", "/admin/comments/edit", `{}`},
	{"GET", "/admin/stats/overview", ""},
	{"GET", "/admin/stats/users", ""},
	{"GET", "/admin/stats/users/comments", ""},
	{"POST", "/admin/users/blacklist", `{}`},
	{"DELETE", "/admin/users/blacklist", ""},
	{"GET", "/admin/data/export/settings", ""},
	{"GET", "/admin/data/export/comments", ""},
	{"POST", "/admin/data/import/comments", `{}`},
	{"POST", "/admin/data/import/settings", `{}`},
}

func TestAuthMiddlewareRejectsMissingToken(t *testing.T) {
	resetState(t)

	for _, route := range protectedRoutes {
		t.Run(route.method+" "+route.target, func(t *testing.T) {
			w := callJSON(t, route.method, route.target, route.body)
			if w.Code != 401 {
				t.Fatalf("未携带 token 应返回 401，实际 %d（body=%s）", w.Code, w.Body.String())
			}
			requireBodyCode(t, w, 401)
			m := decodeJSON(t, w)
			if m["message"] != "Invalid token" {
				t.Errorf("message 期望 Invalid token，实际 %v", m["message"])
			}
		})
	}
}

func TestAuthMiddlewareRejectsMalformedAuthorizationHeader(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name   string
		header string
	}{
		{"缺少 Bearer 前缀", token},
		{"Token 前缀", "Token " + token},
		{"小写 bearer", "bearer " + token},
		{"BEARER 大写", "BEARER " + token},
		{"只有 Bearer", "Bearer"},
		{"Bearer 后为空", "Bearer "},
		{"Bearer 后只有空格", "Bearer    "},
		{"token 多一个字符", "Bearer " + token + "0"},
		{"token 少一个字符", "Bearer " + token[:len(token)-1]},
		{"随机 token", "Bearer deadbeefdeadbeef"},
		{"Bearer 前有空格", " Bearer " + token},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := call(t, "GET", "/admin/settings", "", map[string]string{"Authorization": tc.header}, "")
			if w.Code != 401 {
				t.Errorf("非法 Authorization 头应返回 401，实际 %d", w.Code)
			}
		})
	}
}

func TestAuthMiddlewareRejectsExpiredToken(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	requireStatus(t, callWithToken(t, "GET", "/admin/settings", "", token), 200)

	// 把该 token 的过期时间改到过去
	utils.TokenStore.Lock()
	utils.TokenStore.Map[token] = time.Now().Add(-time.Minute)
	utils.TokenStore.Unlock()

	w := callWithToken(t, "GET", "/admin/settings", "", token)
	requireStatus(t, w, 401)
	requireBodyCode(t, w, 401)
}

func TestAuthMiddlewareAcceptsValidTokenForAllRoutes(t *testing.T) {
	resetState(t)

	for _, route := range protectedRoutes {
		t.Run(route.method+" "+route.target, func(t *testing.T) {
			// 每个路由用新 token：POST /admin/logout 会吊销当前 token
			token := adminToken(t)
			w := callWithToken(t, route.method, route.target, route.body, token)
			if w.Code == 401 {
				t.Errorf("携带有效 token 不应返回 401，实际 %d（body=%s）", w.Code, w.Body.String())
			}
		})
	}
}

func TestLogoutRevokesOnlyCurrentToken(t *testing.T) {
	resetState(t)

	tokenA := adminToken(t)
	tokenB := adminToken(t)

	m := decodeJSON(t, callWithToken(t, "POST", "/admin/logout", "", tokenA))
	if code, _ := m["code"].(float64); int(code) != 200 {
		t.Errorf("logout 应返回 code 200，实际 %v", m["code"])
	}
	if m["message"] != "Logged out" {
		t.Errorf("message 期望 Logged out，实际 %v", m["message"])
	}

	if utils.IsTokenValid(tokenA) {
		t.Errorf("已登出的 token 应失效")
	}
	requireStatus(t, callWithToken(t, "GET", "/admin/settings", "", tokenA), 401)

	// 其他未登出的会话不受影响
	tokenC := adminToken(t)
	requireStatus(t, callWithToken(t, "GET", "/admin/settings", "", tokenC), 200)

	// 登出第二个 token 同样生效
	m = decodeJSON(t, callWithToken(t, "POST", "/admin/logout", "", tokenB))
	if code, _ := m["code"].(float64); int(code) != 200 {
		t.Errorf("logout 应返回 code 200，实际 %v", m["code"])
	}
	if utils.IsTokenValid(tokenB) {
		t.Errorf("第二个 token 登出后也应失效")
	}
}

// ---------------------------------------------------------------------------
// PUT /admin/password
// ---------------------------------------------------------------------------

func TestChangePasswordValidation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{"空请求体", "", 400},
		{"非法 JSON", "{", 400},
		{"缺少全部字段", `{}`, 400},
		{"缺少 new_password", `{"old_name":"momo","old_password":"momo","new_name":"boss"}`, 400},
		{"缺少 old_password", `{"old_name":"momo","new_name":"boss","new_password":"12345678"}`, 400},
		{"new_password 不足 8 位", `{"old_name":"momo","old_password":"momo","new_name":"boss","new_password":"1234567"}`, 400},
		{"new_password 为空", `{"old_name":"momo","old_password":"momo","new_name":"boss","new_password":""}`, 400},
		{"旧凭据错误", `{"old_name":"momo","old_password":"wrong","new_name":"boss","new_password":"12345678"}`, 401},
		{"旧用户名错误", `{"old_name":"someone","old_password":"momo","new_name":"boss","new_password":"12345678"}`, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)

			w := callWithToken(t, "PUT", "/admin/password", tc.body, token)
			requireStatus(t, w, tc.wantStatus)
			requireBodyCode(t, w, tc.wantStatus)
		})
	}
}

func TestChangePasswordHappyPathRevokesSessions(t *testing.T) {
	resetState(t)

	token := adminToken(t)
	requireStatus(t, callWithToken(t, "GET", "/admin/settings", "", token), 200)

	body := `{"old_name":"momo","old_password":"momo","new_name":"boss","new_password":"brand-new-pass"}`
	w := callWithToken(t, "PUT", "/admin/password", body, token)
	requireStatus(t, w, 200)
	requireBodyCode(t, w, 200)

	// 改密后旧会话必须立即失效
	if utils.IsTokenValid(token) {
		t.Errorf("改密后旧 token 应被吊销")
	}
	requireStatus(t, callWithToken(t, "GET", "/admin/settings", "", token), 401)

	// 新凭据可以登录，旧凭据失效
	w = callFromIP(t, "POST", "/admin/login", `{"name":"boss","password":"brand-new-pass"}`, nextRemoteAddr())
	requireStatus(t, w, 200)

	w = callFromIP(t, "POST", "/admin/login", `{"name":"momo","password":"momo"}`, nextRemoteAddr())
	requireStatus(t, w, 401)
}

// ---------------------------------------------------------------------------
// POST /admin/settings/test-email
// ---------------------------------------------------------------------------

// TestTestEmailConfigurationBranches 覆盖不产生真实网络请求的三个分支
func TestTestEmailConfigurationBranches(t *testing.T) {
	for _, tc := range []struct {
		name        string
		settings    map[string]string
		wantMessage string
	}{
		{
			name:        "未配置管理员邮箱",
			settings:    map[string]string{},
			wantMessage: "Admin email is not configured.",
		},
		{
			name:        "已配置管理员邮箱但缺少 SMTP",
			settings:    map[string]string{"admin_email": "admin@x.com"},
			wantMessage: "SMTP is not configured.",
		},
		{
			name: "SMTP 完整但邮件功能被关闭",
			settings: map[string]string{
				"admin_email": "admin@x.com", "smtp_host": "smtp.example.com",
				"email_user": "u@example.com", "email_password": "p", "email_enabled": "false",
			},
			wantMessage: "The email notification feature is currently disabled.",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			for k, v := range tc.settings {
				setSetting(t, k, v)
			}
			token := adminToken(t)

			w := callWithToken(t, "POST", "/admin/settings/test-email", "", token)
			requireStatus(t, w, 400)

			m := decodeJSON(t, w)
			msg, _ := m["message"].(string)
			if !strings.Contains(msg, tc.wantMessage) {
				t.Errorf("message 应包含 %q，实际 %q", tc.wantMessage, msg)
			}
		})
	}
}
