package utils

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// 设置的读写与遍历
// ---------------------------------------------------------------------------

func TestSetSettingAndGetSetting(t *testing.T) {
	resetSettings(t)

	if got := GetSetting("site_name"); got != "" {
		t.Errorf("不存在的设置项应返回空串，实际 %q", got)
	}

	setSetting(t, "site_name", "我的博客")
	requireSetting(t, "site_name", "我的博客")

	// 覆盖写（UPSERT）
	setSetting(t, "site_name", "新站名")
	requireSetting(t, "site_name", "新站名")

	var count int
	if err := settingsDB.Get(&count, "SELECT COUNT(*) FROM Settings WHERE key = 'site_name'"); err != nil {
		t.Fatalf("统计设置行失败: %v", err)
	}
	if count != 1 {
		t.Errorf("同名设置应只保留一行，实际 %d 行", count)
	}

	// 空值也必须能写入并读回
	setSetting(t, "blogger_badge_text", "")
	requireSetting(t, "blogger_badge_text", "")
}

func TestGetAllSettings(t *testing.T) {
	resetSettings(t)

	if got := GetAllSettings(); len(got) != 0 {
		t.Errorf("空表应返回空 map，实际 %v", got)
	}

	want := map[string]string{
		"site_name":            "站点",
		"admin_email":          "a@b.com",
		"comment_auto_approve": "false",
		"blogger_badge_text":   "",
	}
	for k, v := range want {
		setSetting(t, k, v)
	}

	got := GetAllSettings()
	if len(got) != len(want) {
		t.Errorf("应返回 %d 项，实际 %d 项: %v", len(want), len(got), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("设置 %s 期望 %q，实际 %q", k, v, got[k])
		}
	}
}

// ---------------------------------------------------------------------------
// IP 黑名单
// ---------------------------------------------------------------------------

func TestCheckIPBlacklist(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     string
		ip      string
		blocked bool
	}{
		{"空配置放行", "", "1.2.3.4", false},
		{"空数组放行", "[]", "1.2.3.4", false},
		{"精确命中 IPv4", `["1.2.3.4"]`, "1.2.3.4", true},
		{"精确未命中 IPv4", `["1.2.3.4"]`, "1.2.3.5", false},
		{"精确命中 IPv6", `["2001:db8::1"]`, "2001:db8::1", true},
		{"精确未命中 IPv6", `["2001:db8::1"]`, "2001:db8::2", false},
		{"CIDR /24 命中", `["10.0.0.0/24"]`, "10.0.0.99", true},
		{"CIDR /24 未命中", `["10.0.0.0/24"]`, "10.0.1.1", false},
		{"CIDR /32 命中", `["192.168.1.1/32"]`, "192.168.1.1", true},
		{"CIDR /0 命中任意 IPv4", `["0.0.0.0/0"]`, "8.8.8.8", true},
		{"IPv6 CIDR 命中", `["2001:db8::/32"]`, "2001:db8:abcd::1", true},
		{"IPv6 CIDR 未命中", `["2001:db8::/32"]`, "2001:dead::1", false},
		{"命中多项之一", `["9.9.9.9", "1.2.3.4", "10.0.0.0/8"]`, "10.255.255.255", true},
		{"非法 JSON 放行（fail-open）", `{"not":"array"}`, "1.2.3.4", false},
		{"坏 JSON 放行（fail-open）", `[`, "1.2.3.4", false},
		{"条目非法时忽略该条", `["not-an-ip"]`, "1.2.3.4", false},
		{"空 IP 不命中", `["1.2.3.4", "10.0.0.0/8"]`, "", false},
		{"JSON 里是数字而非字符串", `[123]`, "1.2.3.4", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			setSetting(t, "ip_blacklist", tc.raw)
			if got := CheckIPBlacklist(tc.ip); got != tc.blocked {
				t.Errorf("CheckIPBlacklist(%q) 配置为 %s 时期望 %v，实际 %v", tc.ip, tc.raw, tc.blocked, got)
			}
		})
	}
}

func TestIsValidIpOrCidr(t *testing.T) {
	for _, tc := range []struct {
		name  string
		entry string
		want  bool
	}{
		{"空串", "", false},
		{"纯空白", "   ", false},
		{"IPv4", "1.2.3.4", true},
		{"带空格的 IPv4", " 1.2.3.4 ", true},
		{"IPv6", "2001:db8::1", true},
		{"回环 IPv6", "::1", true},
		{"CIDR /24", "10.0.0.0/24", true},
		{"CIDR /0", "0.0.0.0/0", true},
		{"IPv6 CIDR", "2001:db8::/32", true},
		{"非法字符串", "abc", false},
		{"IPv4 越界", "999.1.1.1", false},
		{"前缀长度越界", "10.0.0.0/33", false},
		{"前缀不是数字", "10.0.0.0/xx", false},
		{"缺少掩码段", "10.0.0.0/", false},
		{"通配符", "*", false},
		{"CIDR 不合法地址", "10.0.0.256/24", false},
		{"带端口的地址", "1.2.3.4:80", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsValidIpOrCidr(tc.entry); got != tc.want {
				t.Errorf("IsValidIpOrCidr(%q) 期望 %v，实际 %v", tc.entry, tc.want, got)
			}
		})
	}
}

func TestValidateIPBlacklistJSON(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want bool
	}{
		{"空串视为合法（表示未配置）", "", true},
		{"空数组", "[]", true},
		{"单项合法 IP", `["1.2.3.4"]`, true},
		{"多项混合 IP/CIDR", `["1.2.3.4","10.0.0.0/8","2001:db8::/32"]`, true},
		{"非 JSON", "not-json", false},
		{"JSON 对象而非数组", `{"ip":"1.2.3.4"}`, false},
		{"JSON 字符串而非数组", `"1.2.3.4"`, false},
		{"数组中含非法项", `["1.2.3.4","nope"]`, false},
		{"数组中含空串", `[""]`, false},
		{"数组中含通配符", `["*"]`, false},
		{"数组中含 CIDR 越界", `["10.0.0.0/33"]`, false},
		{"数组中是数字", `[1]`, false},
		{"截断的 JSON", `["1.2.3.4"`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidateIPBlacklistJSON(tc.raw); got != tc.want {
				t.Errorf("ValidateIPBlacklistJSON(%q) 期望 %v，实际 %v", tc.raw, tc.want, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 邮箱黑名单
// ---------------------------------------------------------------------------

func TestCheckEmailBlacklist(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     string
		email   string
		blocked bool
	}{
		{"空配置放行", "", "a@b.com", false},
		{"空数组放行", "[]", "a@b.com", false},
		{"精确命中", `["a@b.com"]`, "a@b.com", true},
		{"大小写不敏感（配置大写）", `["A@B.COM"]`, "a@b.com", true},
		{"大小写不敏感（查询大写）", `["a@b.com"]`, "A@B.COM", true},
		{"大小写不敏感（混合）", `["Ab@Cd.Com"]`, "aB@cD.cOM", true},
		{"未命中", `["a@b.com"]`, "c@d.com", false},
		{"子串不算命中", `["a@b.com"]`, "xa@b.com", false},
		{"命中多项之一", `["x@y.com","a@b.com"]`, "a@b.com", true},
		{"非法 JSON 放行（fail-open）", `{`, "a@b.com", false},
		{"非法 JSON 类型放行", `{"a":"b"}`, "a@b.com", false},
		{"空邮箱不命中", `["a@b.com"]`, "", false},
		{"前后空格不做归一化", `["a@b.com"]`, " a@b.com", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			setSetting(t, "email_blacklist", tc.raw)
			if got := CheckEmailBlacklist(tc.email); got != tc.blocked {
				t.Errorf("CheckEmailBlacklist(%q) 配置为 %s 时期望 %v，实际 %v", tc.email, tc.raw, tc.blocked, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 状态 / 开关 / 模板
// ---------------------------------------------------------------------------

func TestIsValidCommentStatus(t *testing.T) {
	for _, tc := range []struct {
		status string
		want   bool
	}{
		{"pending", true},
		{"approved", true},
		{"rejected", true},
		{"deleted", true},
		{"", false},
		{"PENDING", false},
		{"Approved", false},
		{"pending ", false},
		{" pending", false},
		{"unknown", false},
		{"spam", false},
		{"' OR 1=1 --", false},
	} {
		t.Run(tc.status, func(t *testing.T) {
			if got := IsValidCommentStatus(tc.status); got != tc.want {
				t.Errorf("IsValidCommentStatus(%q) 期望 %v，实际 %v", tc.status, tc.want, got)
			}
		})
	}
}

func TestGetCommentStatus(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *string
		want  string
	}{
		{"未配置时默认自动通过", nil, "approved"},
		{"显式 true", strPtr("true"), "approved"},
		{"显式 false 时进入待审核", strPtr("false"), "pending"},
		{"其他取值一律视为通过", strPtr("False"), "approved"},
		{"空值视为通过", strPtr(""), "approved"},
		{"1 视为通过（非严格布尔）", strPtr("1"), "approved"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			if tc.value != nil {
				setSetting(t, "comment_auto_approve", *tc.value)
			}
			if got := GetCommentStatus(); got != tc.want {
				t.Errorf("期望 %q，实际 %q", tc.want, got)
			}
		})
	}
}

func TestIsEmailEnabled(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *string
		want  bool
	}{
		{"未配置时默认开启", nil, true},
		{"显式 true", strPtr("true"), true},
		{"显式 false", strPtr("false"), false},
		{"其他取值视为开启", strPtr("0"), true},
		{"空值视为开启", strPtr(""), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			if tc.value != nil {
				setSetting(t, "email_enabled", *tc.value)
			}
			if got := IsEmailEnabled(); got != tc.want {
				t.Errorf("期望 %v，实际 %v", tc.want, got)
			}
		})
	}
}

func TestGetTemplate(t *testing.T) {
	resetSettings(t)

	const fallback = "<p>默认模板</p>"

	if got := GetTemplate("reply_template", fallback); got != fallback {
		t.Errorf("未配置时应返回兜底模板，实际 %q", got)
	}

	setSetting(t, "reply_template", "<p>自定义</p>")
	if got := GetTemplate("reply_template", fallback); got != "<p>自定义</p>" {
		t.Errorf("已配置时应返回自定义模板，实际 %q", got)
	}

	// 空字符串同样视为未配置
	setSetting(t, "reply_template", "")
	if got := GetTemplate("reply_template", fallback); got != fallback {
		t.Errorf("配置为空串时应返回兜底模板，实际 %q", got)
	}

	// 不存在的键同样返回兜底
	if got := GetTemplate("not_exist_key", fallback); got != fallback {
		t.Errorf("不存在的键应返回兜底模板，实际 %q", got)
	}
}

// ---------------------------------------------------------------------------
// 管理员凭据
// ---------------------------------------------------------------------------

func TestCheckAdminCredentialsDefaults(t *testing.T) {
	resetSettings(t)

	for _, tc := range []struct {
		name     string
		user     string
		password string
		want     bool
	}{
		{"默认账号密码", DefaultAdminName, DefaultAdminPassword, true},
		{"用户名错误", "admin", DefaultAdminPassword, false},
		{"密码错误", DefaultAdminName, "wrong", false},
		{"大小写敏感", "MOMO", "momo", false},
		{"空用户名", "", DefaultAdminPassword, false},
		{"空密码", DefaultAdminName, "", false},
		{"都为空", "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := CheckAdminCredentials(tc.user, tc.password); got != tc.want {
				t.Errorf("CheckAdminCredentials(%q,%q) 期望 %v，实际 %v", tc.user, tc.password, tc.want, got)
			}
		})
	}
}

func TestCheckAdminCredentialsPlaintext(t *testing.T) {
	resetSettings(t)
	setSetting(t, "admin_name", "boss")
	setSetting(t, "admin_password", "plain-pass")

	for _, tc := range []struct {
		name     string
		user     string
		password string
		want     bool
	}{
		{"正确明文凭据", "boss", "plain-pass", true},
		{"密码错误", "boss", "other", false},
		{"用户名错误", "momo", "plain-pass", false},
		{"默认账号不应再可用", DefaultAdminName, DefaultAdminPassword, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := CheckAdminCredentials(tc.user, tc.password); got != tc.want {
				t.Errorf("期望 %v，实际 %v", tc.want, got)
			}
		})
	}

	// 明文登录成功后应自动升级为 bcrypt 哈希
	upgraded := GetSetting("admin_password")
	if !strings.HasPrefix(upgraded, "$2") {
		t.Errorf("明文校验成功后应把密码自动升级为 bcrypt 哈希，实际 %q", upgraded)
	}
	if upgraded == "plain-pass" {
		t.Errorf("升级后不应保留明文密码")
	}
	if !CheckAdminCredentials("boss", "plain-pass") {
		t.Errorf("升级为哈希后仍应能登录")
	}
	if CheckAdminCredentials("boss", "plain-pas") {
		t.Errorf("升级为哈希后错误密码仍应被拒绝")
	}
}

// TestCheckAdminCredentialsDollarPrefixRegression 回归测试：
// 明文密码以 $ 开头时，历史上会被误判为 bcrypt 哈希而永久无法登录。
// 现约定只有 $2 前缀才走哈希分支。
func TestCheckAdminCredentialsDollarPrefixRegression(t *testing.T) {
	resetSettings(t)
	setSetting(t, "admin_name", "boss")
	setSetting(t, "admin_password", "$ecret-1234")

	if !CheckAdminCredentials("boss", "$ecret-1234") {
		t.Errorf("以 $ 开头的明文密码必须可以登录（回归：曾被误判为 bcrypt 哈希）")
	}
	if CheckAdminCredentials("boss", "ecret-1234") {
		t.Errorf("去掉 $ 前缀的密码不应通过")
	}
	if got := GetSetting("admin_password"); !strings.HasPrefix(got, "$2") {
		t.Errorf("以 $ 开头的明文登录成功后应升级为 bcrypt 哈希，实际 %q", got)
	}

	// 单独的 "$" 同样按明文处理
	resetSettings(t)
	setSetting(t, "admin_name", "boss")
	setSetting(t, "admin_password", "$")
	if !CheckAdminCredentials("boss", "$") {
		t.Errorf("密码仅为 $ 时应按明文比较")
	}
}

// TestCheckAdminCredentialsBcryptPrefix 记录当前实现取舍：
// 明文密码若恰好以 $2 开头，会被当作 bcrypt 哈希校验而无法登录。
func TestCheckAdminCredentialsBcryptPrefix(t *testing.T) {
	resetSettings(t)
	setSetting(t, "admin_name", "boss")
	setSetting(t, "admin_password", "$2plaintext-not-a-real-hash")

	if CheckAdminCredentials("boss", "$2plaintext-not-a-real-hash") {
		t.Errorf("形如 $2 开头的非法哈希不应通过校验")
	}
}

func TestCheckAdminCredentialsBcryptHash(t *testing.T) {
	resetSettings(t)

	// 借助 ChangeAdminPassword 生成一个真实的 bcrypt 哈希
	if err := ChangeAdminPassword("boss", "s3cret-pass"); err != nil {
		t.Fatalf("设置管理员密码失败: %v", err)
	}
	stored := GetSetting("admin_password")
	if !strings.HasPrefix(stored, "$2") {
		t.Fatalf("ChangeAdminPassword 应写入 bcrypt 哈希，实际 %q", stored)
	}

	for _, tc := range []struct {
		name     string
		user     string
		password string
		want     bool
	}{
		{"哈希分支：正确凭据", "boss", "s3cret-pass", true},
		{"哈希分支：密码错误", "boss", "s3cret-pas", false},
		{"哈希分支：大小写错误", "boss", "S3CRET-PASS", false},
		{"哈希分支：用户名错误但密码正确必须拒绝", "other", "s3cret-pass", false},
		{"哈希分支：用户名为空", "", "s3cret-pass", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := CheckAdminCredentials(tc.user, tc.password); got != tc.want {
				t.Errorf("期望 %v，实际 %v", tc.want, got)
			}
		})
	}

	// 哈希分支不应再改写数据库中的密码
	if got := GetSetting("admin_password"); got != stored {
		t.Errorf("哈希分支不应重写密码哈希，期望 %q，实际 %q", stored, got)
	}
}

// TestCheckAdminCredentialsPartialSettings 记录当前行为：
// 只写入 admin_name 或 admin_password 其中一项时，会回落到默认 momo/momo 凭据。
func TestCheckAdminCredentialsPartialSettings(t *testing.T) {
	resetSettings(t)
	setSetting(t, "admin_name", "boss") // admin_password 为空

	if CheckAdminCredentials(DefaultAdminName, DefaultAdminPassword) != true {
		t.Errorf("仅设置 admin_name 时当前实现会回落到默认凭据（记录该行为）")
	}
	if CheckAdminCredentials("boss", "") != false {
		t.Errorf("密码为空不应通过")
	}
}

func TestChangeAdminPassword(t *testing.T) {
	resetSettings(t)

	if !IsDefaultAdmin() {
		t.Errorf("初始状态应视为默认管理员")
	}

	if err := ChangeAdminPassword("newboss", "brand-new-pass"); err != nil {
		t.Fatalf("修改密码失败: %v", err)
	}

	requireSetting(t, "admin_name", "newboss")
	requireSetting(t, "password_changed", "true")
	if IsDefaultAdmin() {
		t.Errorf("改密后 IsDefaultAdmin 应为 false")
	}
	if !CheckAdminCredentials("newboss", "brand-new-pass") {
		t.Errorf("改密后应能用新凭据登录")
	}
	if CheckAdminCredentials("newboss", "brand-new-pas") {
		t.Errorf("改密后错误密码应被拒绝")
	}
	if CheckAdminCredentials(DefaultAdminName, DefaultAdminPassword) {
		t.Errorf("改密后默认凭据必须失效")
	}

	// 再次改密：用户名与密码都应更新
	if err := ChangeAdminPassword("second", "another-pass-1"); err != nil {
		t.Fatalf("二次修改密码失败: %v", err)
	}
	if CheckAdminCredentials("newboss", "brand-new-pass") {
		t.Errorf("二次改密后旧用户名应失效")
	}
	if !CheckAdminCredentials("second", "another-pass-1") {
		t.Errorf("二次改密后应能用新凭据登录")
	}
}

func TestIsDefaultAdmin(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *string
		want  bool
	}{
		{"未设置视为默认管理员", nil, true},
		{"空值视为默认管理员", strPtr(""), true},
		{"false 视为默认管理员", strPtr("false"), true},
		{"true 表示已改密", strPtr("true"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			if tc.value != nil {
				setSetting(t, "password_changed", *tc.value)
			}
			if got := IsDefaultAdmin(); got != tc.want {
				t.Errorf("期望 %v，实际 %v", tc.want, got)
			}
		})
	}
}

// strPtr 返回字符串指针，便于构造三元场景
func strPtr(s string) *string { return &s }
