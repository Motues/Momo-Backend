package http

import (
	"encoding/json"
	"strings"
	"testing"

	"momo-backend-go/internal/pkg/utils"
)

type settingsPayload struct {
	Code    int               `json:"code"`
	Message string            `json:"message"`
	Data    map[string]string `json:"data"`
}

// ---------------------------------------------------------------------------
// GET /admin/settings
// ---------------------------------------------------------------------------

func TestGetSettingsReturnsWhitelistedValues(t *testing.T) {
	resetState(t)
	setSetting(t, "site_name", "我的博客")
	setSetting(t, "admin_email", "admin@x.com")
	setSetting(t, "email_password", "smtp-secret")
	setSetting(t, "admin_comment_key", "blogger-key")
	setSetting(t, "ip_blacklist", `["1.2.3.4"]`)

	token := adminToken(t)
	w := callWithToken(t, "GET", "/admin/settings", "", token)
	requireStatus(t, w, 200)

	var payload settingsPayload
	decodeInto(t, w, &payload)

	if payload.Code != 200 {
		t.Errorf("code 期望 200，实际 %d", payload.Code)
	}
	if payload.Message != "Settings fetched" {
		t.Errorf("message 期望 Settings fetched，实际 %q", payload.Message)
	}
	if payload.Data["site_name"] != "我的博客" {
		t.Errorf("site_name 应返回真实值，实际 %q", payload.Data["site_name"])
	}
	if payload.Data["admin_email"] != "admin@x.com" {
		t.Errorf("admin_email 应返回真实值，实际 %q", payload.Data["admin_email"])
	}
	if payload.Data["ip_blacklist"] != `["1.2.3.4"]` {
		t.Errorf("ip_blacklist 应返回真实值，实际 %q", payload.Data["ip_blacklist"])
	}

	// 敏感字段必须置空，不得回传明文
	if got := payload.Data["email_password"]; got != "" {
		t.Errorf("email_password 应被置空，实际 %q", got)
	}
	if got := payload.Data["admin_comment_key"]; got != "" {
		t.Errorf("admin_comment_key 应被置空，实际 %q", got)
	}

	// admin_password / password_changed 不在白名单内，不应出现
	for _, key := range []string{"admin_password", "password_changed"} {
		if _, ok := payload.Data[key]; ok {
			t.Errorf("设置 %s 不应下发到前端", key)
		}
	}

	// email_enabled 未配置时补默认值 true
	if got := payload.Data["email_enabled"]; got != "true" {
		t.Errorf("email_enabled 未配置时应补默认值 true，实际 %q", got)
	}
}

func TestGetSettingsTypeGroups(t *testing.T) {
	resetState(t)

	// 为每个分组的关键项都写入数据：只有存在于数据库中的键才会被下发
	for key, value := range map[string]string{
		"site_name": "站点", "admin_email": "a@b.com", "comment_auto_approve": "true",
		"blogger_badge_enabled": "true", "blogger_badge_text": "博主",
		"placeholder_name": "昵称", "placeholder_email": "邮箱",
		"placeholder_content": "内容", "placeholder_url": "网址",
		"smtp_host": "smtp.x.com", "smtp_port": "587", "email_user": "u@x.com",
		"email_password": "p", "email_secure": "true", "email_verify_enabled": "true",
		"verify_base_url": "https://x.com", "reply_template": "回复模板", "notification_template": "通知模板",
		"allow_origin": "https://a.com", "admin_comment_key": "k", "admin_comment_key_enabled": "true",
		"ip_blacklist": `[]`, "email_blacklist": `[]`,
		"comment_verify_enabled": "true", "comment_verify_difficulty": "12", "trust_proxy": "false",
		"admin_name": "boss",
	} {
		setSetting(t, key, value)
	}

	for _, tc := range []struct {
		name        string
		typeParam   string
		mustHave    []string
		mustNotHave []string
	}{
		{
			name:      "basic 分组",
			typeParam: "basic",
			mustHave: []string{
				"site_name", "admin_email", "comment_auto_approve",
				"blogger_badge_enabled", "blogger_badge_text",
				"placeholder_name", "placeholder_email", "placeholder_content", "placeholder_url",
			},
			// email_enabled 会被补默认值（记录该行为）
			mustNotHave: []string{"smtp_host", "ip_blacklist", "trust_proxy", "admin_name"},
		},
		{
			name:      "email 分组",
			typeParam: "email",
			mustHave: []string{
				"smtp_host", "smtp_port", "email_user", "email_password", "email_secure",
				"email_verify_enabled", "verify_base_url", "reply_template", "notification_template",
			},
			mustNotHave: []string{"site_name", "ip_blacklist", "admin_name"},
		},
		{
			name:      "security 分组",
			typeParam: "security",
			mustHave: []string{
				"ip_blacklist", "email_blacklist", "allow_origin", "admin_comment_key",
				"admin_comment_key_enabled", "comment_verify_enabled", "comment_verify_difficulty", "trust_proxy",
			},
			mustNotHave: []string{"site_name", "smtp_host", "admin_name"},
		},
		{
			name:        "account 分组（仍会补 email_enabled）",
			typeParam:   "account",
			mustHave:    []string{"admin_name"},
			mustNotHave: []string{"site_name", "smtp_host", "ip_blacklist"},
		},
		{
			name:        "未知分组回落为全部",
			typeParam:   "unknown-group",
			mustHave:    []string{"site_name", "smtp_host", "ip_blacklist", "admin_name"},
			mustNotHave: nil,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := adminToken(t)
			w := callWithToken(t, "GET", "/admin/settings?type="+tc.typeParam, "", token)
			requireStatus(t, w, 200)

			var payload settingsPayload
			decodeInto(t, w, &payload)

			for _, key := range tc.mustHave {
				if _, ok := payload.Data[key]; !ok {
					t.Errorf("分组 %s 应包含 %s，实际返回 %v", tc.typeParam, key, keysOf(payload.Data))
				}
			}
			for _, key := range tc.mustNotHave {
				if _, ok := payload.Data[key]; ok {
					t.Errorf("分组 %s 不应包含 %s", tc.typeParam, key)
				}
			}
			// 敏感项即使被下发也必须置空
			if v, ok := payload.Data["email_password"]; ok && v != "" {
				t.Errorf("email_password 应被置空，实际 %q", v)
			}
			if v, ok := payload.Data["admin_comment_key"]; ok && v != "" {
				t.Errorf("admin_comment_key 应被置空，实际 %q", v)
			}
			// 每个分组都必须带 email_enabled 默认值
			if got, ok := payload.Data["email_enabled"]; !ok || got != "true" {
				t.Errorf("未配置 email_enabled 时应补默认值 true，实际 %q（存在=%v）", got, ok)
			}
			// 测试进程显式覆盖了 TRUST_PROXY（来源 test），security 分组应如实上报
			if tc.typeParam == "security" {
				if got := payload.Data["trust_proxy_override"]; got != "test" {
					t.Errorf("security 分组应上报 trust_proxy_override=test，实际 %q", got)
				}
			}
		})
	}

	t.Run("type 为空串等价于不过滤", func(t *testing.T) {
		token := adminToken(t)
		w := callWithToken(t, "GET", "/admin/settings?type=", "", token)
		requireStatus(t, w, 200)

		var payload settingsPayload
		decodeInto(t, w, &payload)
		if _, ok := payload.Data["smtp_host"]; !ok {
			t.Errorf("type 为空串时应返回全部设置，实际 %v", keysOf(payload.Data))
		}
	})
}

func TestGetSettingsTrustProxyOverrideHint(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	// 未指定覆盖（nil）时不返回 trust_proxy_override
	utils.SetTrustProxyOverride(nil, "")
	var payload settingsPayload
	decodeInto(t, callWithToken(t, "GET", "/admin/settings", "", token), &payload)
	if _, ok := payload.Data["trust_proxy_override"]; ok {
		t.Errorf("未显式指定 TRUST_PROXY 时不应下发 trust_proxy_override")
	}

	// 显式指定时下发来源，供前端提示“页面设置不生效”
	enabled := true
	utils.SetTrustProxyOverride(&enabled, "env")
	payload = settingsPayload{}
	decodeInto(t, callWithToken(t, "GET", "/admin/settings", "", token), &payload)
	if got := payload.Data["trust_proxy_override"]; got != "env" {
		t.Errorf("trust_proxy_override 期望 env，实际 %q", got)
	}

	// 恢复测试进程的默认覆盖（不信任代理头）
	disabled := false
	utils.SetTrustProxyOverride(&disabled, "test")
}

// ---------------------------------------------------------------------------
// PUT /admin/settings
// ---------------------------------------------------------------------------

func TestUpdateSettingsRoundTrip(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"site_name":"新站名","admin_email":"admin@x.com","comment_auto_approve":"false"}`
	w := callWithToken(t, "PUT", "/admin/settings", body, token)
	requireStatus(t, w, 200)

	var resp struct {
		Code        int    `json:"code"`
		Message     string `json:"message"`
		SMTPChanged bool   `json:"smtpChanged"`
	}
	decodeInto(t, w, &resp)
	if resp.Code != 200 || resp.Message != "Settings updated" {
		t.Errorf("PUT 响应不正确: %+v", resp)
	}
	if resp.SMTPChanged {
		t.Errorf("未改动 SMTP 时 smtpChanged 应为 false")
	}

	for key, want := range map[string]string{
		"site_name":            "新站名",
		"admin_email":          "admin@x.com",
		"comment_auto_approve": "false",
	} {
		if got := utils.GetSetting(key); got != want {
			t.Errorf("设置 %s 期望 %q，实际 %q", key, want, got)
		}
	}

	// GET 应返回刚写入的值
	var payload settingsPayload
	decodeInto(t, callWithToken(t, "GET", "/admin/settings", "", token), &payload)
	if payload.Data["site_name"] != "新站名" {
		t.Errorf("GET 应返回刚保存的值，实际 %q", payload.Data["site_name"])
	}
}

func TestUpdateSettingsSMTPChangedFlag(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	for _, tc := range []struct {
		name string
		body string
		want bool
	}{
		{"改动 smtp_host", `{"smtp_host":"smtp.x.com"}`, true},
		{"改动 smtp_port", `{"smtp_port":"587"}`, true},
		{"改动 email_user", `{"email_user":"u@x.com"}`, true},
		{"改动 email_password", `{"email_password":"p"}`, true},
		{"显式写空 smtp_host 视为未改动", `{"smtp_host":""}`, false},
		{"无关设置", `{"site_name":"x"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callWithToken(t, "PUT", "/admin/settings", tc.body, token)
			requireStatus(t, w, 200)

			var resp struct {
				SMTPChanged bool `json:"smtpChanged"`
			}
			decodeInto(t, w, &resp)
			if resp.SMTPChanged != tc.want {
				t.Errorf("smtpChanged 期望 %v，实际 %v", tc.want, resp.SMTPChanged)
			}
		})
	}
}

func TestUpdateSettingsRejectsUnknownKeys(t *testing.T) {
	for _, tc := range []struct {
		name   string
		body   string
		badKey string
	}{
		{"未知设置项", `{"hack":"1"}`, "hack"},
		{"禁止改写管理员密码哈希", `{"admin_password":"$2a$10$xxx"}`, "admin_password"},
		{"禁止改写改密标记", `{"password_changed":"false"}`, "password_changed"},
		{"禁止注入任意键", `{"comment_verify_secret":"attacker"}`, "comment_verify_secret"},
		{"混合合法与非法键", `{"site_name":"被拒绝","hack":"1"}`, "hack"},
		{"空键名", `{"":"x"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)

			w := callWithToken(t, "PUT", "/admin/settings", tc.body, token)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)

			m := decodeJSON(t, w)
			msg, _ := m["message"].(string)
			if !strings.Contains(msg, "not allowed") {
				t.Errorf("message 应说明设置项不被允许，实际 %q", msg)
			}

			// 校验发生在写入之前：任何键都不应落库
			var count int
			query := "SELECT COUNT(*) FROM Settings WHERE key = ?"
			if err := testDB.Get(&count, query, tc.badKey); err != nil {
				t.Fatalf("查询设置失败: %v", err)
			}
			if count != 0 {
				t.Errorf("被拒绝的键 %q 不应写入数据库", tc.badKey)
			}
			if utils.GetSetting("site_name") == "被拒绝" {
				t.Errorf("校验失败时不应写入任何键")
			}
		})
	}
}

func TestUpdateSettingsIPBlacklistValidation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		value      string
		wantStatus int
	}{
		{"合法单 IP", `["1.2.3.4"]`, 200},
		{"合法 CIDR", `["10.0.0.0/8"]`, 200},
		{"合法多值", `["1.2.3.4","2001:db8::/32"]`, 200},
		{"空数组", `[]`, 200},
		{"空串（表示清空）", ``, 200},
		{"非法 JSON", `{"a":1}`, 400},
		{"非法条目", `["nope"]`, 400},
		{"CIDR 前缀越界", `["10.0.0.0/33"]`, 400},
		{"通配符", `["*"]`, 400},
		{"数字条目", `[1]`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)

			body := `{"ip_blacklist":` + mustJSONString(t, tc.value) + `}`
			w := callWithToken(t, "PUT", "/admin/settings", body, token)
			requireStatus(t, w, tc.wantStatus)

			if tc.wantStatus == 200 {
				if got := utils.GetSetting("ip_blacklist"); got != tc.value {
					t.Errorf("ip_blacklist 期望 %q，实际 %q", tc.value, got)
				}
			} else {
				m := decodeJSON(t, w)
				msg, _ := m["message"].(string)
				if !strings.Contains(msg, "ip_blacklist") {
					t.Errorf("message 应说明 ip_blacklist 非法，实际 %q", msg)
				}
			}
		})
	}
}

func TestUpdateSettingsEmailPasswordNotOverwrittenByEmpty(t *testing.T) {
	resetState(t)
	setSetting(t, "email_password", "existing-secret")
	token := adminToken(t)

	w := callWithToken(t, "PUT", "/admin/settings", `{"email_password":""}`, token)
	requireStatus(t, w, 200)
	if got := utils.GetSetting("email_password"); got != "existing-secret" {
		t.Errorf("空字符串不应覆盖已有 SMTP 密码，实际 %q", got)
	}

	w = callWithToken(t, "PUT", "/admin/settings", `{"email_password":"new-secret"}`, token)
	requireStatus(t, w, 200)
	if got := utils.GetSetting("email_password"); got != "new-secret" {
		t.Errorf("非空值应覆盖 SMTP 密码，实际 %q", got)
	}
}

func TestUpdateSettingsEmptyObject(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "PUT", "/admin/settings", `{}`, token)
	requireStatus(t, w, 200)

	var resp struct {
		Message     string `json:"message"`
		SMTPChanged bool   `json:"smtpChanged"`
	}
	decodeInto(t, w, &resp)
	if resp.Message != "Settings updated" || resp.SMTPChanged {
		t.Errorf("空对象应成功且 smtpChanged=false，实际 %+v", resp)
	}
	if len(utils.GetAllSettings()) != 0 {
		t.Errorf("空对象不应写入任何设置，实际 %v", utils.GetAllSettings())
	}
}

func TestUpdateSettingsMalformedBody(t *testing.T) {
	for _, tc := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{"空请求体", "", 400},
		{"非法 JSON", "{", 400},
		{"JSON 数组", "[]", 400},
		{"值类型错误", `{"site_name":123}`, 400},
		{"嵌套对象", `{"site_name":{"a":1}}`, 400},
		// 记录当前行为：JSON null 能成功绑定为 nil map，等价于空对象
		{"JSON null", "null", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)
			w := callWithToken(t, "PUT", "/admin/settings", tc.body, token)
			requireStatus(t, w, tc.wantStatus)
			requireBodyCode(t, w, tc.wantStatus)
		})
	}
}

// TestUpdateSettingsAcceptsUnvalidatedValues 记录当前行为：
// 除 ip_blacklist 外，大部分设置项只做白名单校验，不做取值校验。
func TestUpdateSettingsAcceptsUnvalidatedValues(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	body := `{"smtp_port":"not-a-number","email_secure":"maybe","comment_verify_difficulty":"999","trust_proxy":"yes"}`
	w := callWithToken(t, "PUT", "/admin/settings", body, token)
	requireStatus(t, w, 200)

	for key, want := range map[string]string{
		"smtp_port":                 "not-a-number",
		"email_secure":              "maybe",
		"comment_verify_difficulty": "999",
		"trust_proxy":               "yes",
	} {
		if got := utils.GetSetting(key); got != want {
			t.Errorf("设置 %s 期望原样保存 %q，实际 %q", key, want, got)
		}
	}
}

// keysOf 返回 map 的键（用于失败信息）
func keysOf(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// mustJSONString 把字符串编码为 JSON 字面量（用于拼接请求体）
func mustJSONString(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("编码 JSON 字符串失败: %v", err)
	}
	return string(b)
}
