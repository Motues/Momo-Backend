package utils

import (
	"sort"
	"strings"
	"testing"
)

// canonicalSettingKeys 是三端（Node / Go / Worker）共同的后台设置键白名单。
//
// 必须与以下实现逐字一致：
//   - nodejs/src/api/admin/dataImport.ts 的 allowedSettings
//   - nodejs/src/api/admin/settings.ts 的白名单
//   - worker/src/api/admin/settings.ts 的 ALLOWED_SETTINGS
//
// 背景（E3）：本包曾残留一份只有 17 个键的**过期副本**，而 handler 的
// GetSettings / UpdateSettings 又各自维护了一份完整副本，三处互相漂移；
// 那份过期副本还容易误导后续维护者。现在白名单只在 settings.go 维护一处，
// 本测试把它的内容钉死，避免再次出现缺项或与另外两端脱节。
var canonicalSettingKeys = []string{
	"admin_comment_key",
	"admin_comment_key_enabled",
	"admin_email",
	// 多管理员邮箱与通知收件人（与 Node/Worker 同步，见 doc/admin_emails.md）
	"admin_emails",
	"admin_name",
	"allow_origin",
	// 评论区头像来源：开关 + 预设 / 自定义 URL 模板（见 doc/avatar.md）
	"avatar_custom_url",
	"avatar_enabled",
	"avatar_source",
	"blogger_badge_enabled",
	"blogger_badge_text",
	"comment_auto_approve",
	"comment_spam_duplicate_window",
	"comment_spam_keywords",
	"comment_spam_max_links",
	"comment_spam_min_length",
	"comment_verify_block_automated",
	"comment_verify_difficulty",
	"comment_verify_domain_enabled",
	"comment_verify_enabled",
	"comment_verify_instr_enabled",
	"comment_verify_log_challenge",
	"comment_verify_retention_days",
	"email_blacklist",
	"email_enabled",
	"email_password",
	"email_secure",
	"email_user",
	"email_verify_enabled",
	// 表情设置：是否启用 + OwO 来源地址数组（+ 兼容用的旧单地址键，见 doc/emoji.md）
	"emoji_cdn_url",
	"emoji_cdn_urls",
	"emoji_enabled",
	"ip_blacklist",
	// 链接安全审查：休眠链接 + 历史链接批量更新 + 休眠提醒邮件（见 doc/link_security.md）
	"link_dormant_days",
	"link_dormant_notice_enabled",
	"link_security_enabled",
	"link_sync_enabled",
	// 外发邮件日志保留天数（面板「邮件管理」的数据保留期）
	"mail_log_retention_days",
	"notification_template",
	"notify_email",
	"placeholder_content",
	"placeholder_email",
	"placeholder_name",
	"placeholder_url",
	"reply_template",
	"site_name",
	"smtp_host",
	"smtp_port",
	"trust_proxy",
	"verify_base_url",
}

func TestAllowedSettingKeysMatchCanonicalList(t *testing.T) {
	got := AllowedSettingKeys()
	want := append([]string(nil), canonicalSettingKeys...)
	sort.Strings(want)

	if len(got) != len(want) {
		t.Fatalf("白名单数量不一致: got=%d want=%d\ngot=%v\nwant=%v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("白名单第 %d 项不一致: got=%q want=%q", i, got[i], want[i])
		}
	}
}

func TestAllowedSettingKeysSortedAndUnique(t *testing.T) {
	got := AllowedSettingKeys()

	if !sort.StringsAreSorted(got) {
		t.Errorf("AllowedSettingKeys 必须已排序（接口输出依赖它保持稳定），实际: %v", got)
	}

	seen := make(map[string]bool, len(got))
	for _, key := range got {
		if key == "" || strings.TrimSpace(key) != key {
			t.Errorf("白名单包含非法键: %q", key)
		}
		if seen[key] {
			t.Errorf("白名单包含重复键: %q", key)
		}
		seen[key] = true
	}
}

func TestIsAllowedSetting(t *testing.T) {
	for _, key := range canonicalSettingKeys {
		if !IsAllowedSetting(key) {
			t.Errorf("应被允许的设置键被拒绝: %q", key)
		}
	}

	// 这些键由系统内部维护，绝不能开放给后台读写
	for _, key := range []string{
		"",
		"admin_password",
		"password_changed",
		"comment_verify_secret",
		"unknown_key",
		"site_name ", // 尾随空格不得被当成合法键
		"SITE_NAME",  // 大小写敏感
	} {
		if IsAllowedSetting(key) {
			t.Errorf("不应被允许的设置键被接受: %q", key)
		}
	}
}
