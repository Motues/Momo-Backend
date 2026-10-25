package utils

import "encoding/json"

// 系统设置导出（GET /admin/data/export/settings）的「完整快照」口径。
//
// 与 Node `utils/settingsExport.ts`、Worker `utils/settingsExport.ts` 逐字一致：
// 先铺一遍全部 47 个可写设置键的**生效默认值**，再用库里的值覆盖，最后把敏感键置空。
// 口径的唯一事实来源是 `doc/vectors/settings-export-v1.json`（三端读同一份）。
//
// 表情是唯一的跨键回落：`emoji_cdn_urls` 为空时实际生效的是「旧单地址键
// `emoji_cdn_url` → 内置默认源」。所以缺 `emoji_cdn_urls` 时导出**解析后的生效列表**，
// 直接写默认源会把旧的单地址覆盖掉（导入时列表优先）。
//
// 导入端不变：仍只写文件里出现的键（见 doc/api.md）。

// SettingsExportSensitiveKeys 导出时置空的敏感键（与向量文件的 sensitiveBlanked 一致）。
var SettingsExportSensitiveKeys = []string{
	"email_password",
	"admin_comment_key",
}

// settingsExportDefaults 全部可写设置键的生效默认值。
//
// 新增可写设置键时，必须同时更新这里与 `doc/vectors/settings-export-v1.json`、
// Node 的 `utils/settingsExport.ts`、Worker 的 `utils/settingsExport.ts`。
var settingsExportDefaults = map[string]string{
	"site_name":                      "Momo Blog",
	"admin_email":                    "",
	"admin_emails":                   "[]",
	"notify_email":                   "",
	"admin_name":                     DefaultAdminName,
	"smtp_host":                      "",
	"smtp_port":                      "465",
	"email_user":                     "",
	"email_password":                 "",
	"email_secure":                   "false",
	"allow_origin":                   "",
	"email_enabled":                  "true",
	"reply_template":                 "",
	"notification_template":          "",
	"comment_auto_approve":           "true",
	"comment_spam_keywords":          "[]",
	"comment_spam_max_links":         "0",
	"comment_spam_min_length":        "0",
	"comment_spam_duplicate_window":  "0",
	"ip_blacklist":                   "[]",
	"email_blacklist":                "[]",
	"blogger_badge_enabled":          "false",
	"blogger_badge_text":             "",
	"placeholder_name":               "",
	"placeholder_email":              "",
	"placeholder_content":            "",
	"placeholder_url":                "",
	"admin_comment_key":              "",
	"admin_comment_key_enabled":      "false",
	"email_verify_enabled":           "false",
	"verify_base_url":                "",
	"mail_log_retention_days":        "30",
	"comment_verify_enabled":         "false",
	"comment_verify_difficulty":      "1000000",
	"comment_verify_instr_enabled":   "false",
	"comment_verify_block_automated": "false",
	"comment_verify_domain_enabled":  "false",
	"comment_verify_retention_days":  "30",
	"comment_verify_log_challenge":   "true",
	"trust_proxy":                    "false",
	"emoji_enabled":                  "true",
	"emoji_cdn_url":                  "",
	// 表情来源默认列表（JSON 数组字符串）：与 DefaultEmojiCDN 一致
	"emoji_cdn_urls":              `["` + DefaultEmojiCDN + `"]`,
	"link_security_enabled":       "false",
	"link_dormant_days":           "30",
	"link_sync_enabled":           "false",
	"link_dormant_notice_enabled": "false",
}

// SettingsExportDefaults 返回生效默认值的副本（供测试/文档比对，避免调用方改到内部表）。
func SettingsExportDefaults() map[string]string {
	out := make(map[string]string, len(settingsExportDefaults))
	for key, value := range settingsExportDefaults {
		out[key] = value
	}
	return out
}

// BuildExportedSettings 把库里的设置合成一份导出快照。
//
// stored 是 GetAllSettings() 的结果（只含库里真实存在的键）。
func BuildExportedSettings(stored map[string]string) (map[string]string, []string) {
	settings := make(map[string]string, len(settingsExportDefaults))
	for key, fallback := range settingsExportDefaults {
		settings[key] = fallback
	}
	for key := range settingsExportDefaults {
		if value, ok := stored[key]; ok {
			settings[key] = value
		}
	}

	// 表情来源列表：缺键时导出「解析后的生效列表」，保住旧单地址键的回落语义
	if _, ok := stored["emoji_cdn_urls"]; !ok {
		urls, _ := ResolveEmojiConfig("", stored["emoji_cdn_url"], stored["emoji_enabled"])
		if raw, err := json.Marshal(urls); err == nil {
			settings["emoji_cdn_urls"] = string(raw)
		}
	}

	sensitiveOmitted := []string{}
	for _, key := range SettingsExportSensitiveKeys {
		// 库里存过非空值才算「被置空」；缺键或本来就是空串不登记
		if value, ok := stored[key]; ok && value != "" {
			sensitiveOmitted = append(sensitiveOmitted, key)
		}
		settings[key] = ""
	}

	return settings, sensitiveOmitted
}
