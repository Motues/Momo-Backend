package utils

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

/*
系统设置导出的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

导出是「完整快照」：50 个可写设置键全都要出现，缺的键按生效默认值补全。
只要有一端漏键、把默认值写成面板初值（例如把 email_secure 当成 true）、
或把表情来源列表直接写默认源（覆盖旧单地址键），这里就会立刻失败。
*/

type settingsExportVector struct {
	Version          int               `json:"version"`
	Defaults         map[string]string `json:"defaults"`
	SensitiveBlanked []string          `json:"sensitiveBlanked"`
}

func loadSettingsExportVector(t *testing.T) settingsExportVector {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("settings-export-v1.json"))
	if err != nil {
		t.Fatalf("读取 settings-export-v1.json 失败: %v", err)
	}
	var fixture settingsExportVector
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 settings-export-v1.json 失败: %v", err)
	}
	return fixture
}

func TestSettingsExportDefaultsMatchVector(t *testing.T) {
	fixture := loadSettingsExportVector(t)
	got := SettingsExportDefaults()

	if len(got) != 50 || len(fixture.Defaults) != 50 {
		t.Fatalf("默认值表应为 50 个键，实际 got=%d fixture=%d", len(got), len(fixture.Defaults))
	}
	for key, want := range fixture.Defaults {
		if got[key] != want {
			t.Errorf("%s 默认值期望 %q，实际 %q", key, want, got[key])
		}
	}
	for key := range got {
		if _, ok := fixture.Defaults[key]; !ok {
			t.Errorf("默认值表多出向量里没有的键: %s", key)
		}
	}

	if strings.Join(SettingsExportSensitiveKeys, ",") != strings.Join(fixture.SensitiveBlanked, ",") {
		t.Errorf("敏感键期望 %v，实际 %v", fixture.SensitiveBlanked, SettingsExportSensitiveKeys)
	}
}

func TestBuildExportedSettings(t *testing.T) {
	fixture := loadSettingsExportVector(t)

	// 空库：50 个键全部出现，值等于默认值表
	settings, omitted := BuildExportedSettings(map[string]string{})
	if len(settings) != 50 {
		t.Fatalf("空库导出应包含 50 个键，实际 %d", len(settings))
	}
	for key, want := range fixture.Defaults {
		if settings[key] != want {
			t.Errorf("空库导出 %s 期望 %q，实际 %q", key, want, settings[key])
		}
	}
	if len(omitted) != 0 {
		t.Errorf("空库不应有 sensitiveOmitted，实际 %v", omitted)
	}
	if settings["emoji_enabled"] != "true" {
		t.Errorf("表情默认应为启用，实际 %q", settings["emoji_enabled"])
	}
	if settings["emoji_cdn_urls"] != `["https://open.motues.top/emoji/owo.json"]` {
		t.Errorf("表情默认来源不对: %q", settings["emoji_cdn_urls"])
	}

	// 库里的值覆盖默认值，缺的键仍补齐
	overridden, _ := BuildExportedSettings(map[string]string{
		"site_name":      "我的博客",
		"emoji_enabled":  "false",
		"emoji_cdn_urls": `["https://cdn.example.com/owo.json"]`,
	})
	if overridden["site_name"] != "我的博客" {
		t.Errorf("site_name 应被覆盖，实际 %q", overridden["site_name"])
	}
	if overridden["emoji_enabled"] != "false" {
		t.Errorf("emoji_enabled 应被覆盖，实际 %q", overridden["emoji_enabled"])
	}
	if len(overridden) != 50 {
		t.Errorf("覆盖后仍应是 50 个键，实际 %d", len(overridden))
	}

	// 表情跨键回落：缺 emoji_cdn_urls 时用旧单地址键的解析结果，而不是默认源
	legacy, _ := BuildExportedSettings(map[string]string{
		"emoji_cdn_url": "https://cdn.example.com/legacy.json",
	})
	if legacy["emoji_cdn_urls"] != `["https://cdn.example.com/legacy.json"]` {
		t.Errorf("旧单地址键应被解析进列表，实际 %q", legacy["emoji_cdn_urls"])
	}

	// 敏感键：始终为空串，存过非空值才登记
	blank, blankOmitted := BuildExportedSettings(map[string]string{
		"email_password":    "",
		"admin_comment_key": "",
	})
	if blank["email_password"] != "" || blank["admin_comment_key"] != "" {
		t.Errorf("敏感键应置空: %v", blank)
	}
	if len(blankOmitted) != 0 {
		t.Errorf("空值不应登记 sensitiveOmitted，实际 %v", blankOmitted)
	}

	omittedSettings, sensitiveOmitted := BuildExportedSettings(map[string]string{
		"email_password":    "smtp-secret",
		"admin_comment_key": "blogger-key",
	})
	if omittedSettings["email_password"] != "" || omittedSettings["admin_comment_key"] != "" {
		t.Errorf("敏感键应置空: %v", omittedSettings)
	}
	if strings.Join(sensitiveOmitted, ",") != "email_password,admin_comment_key" {
		t.Errorf("sensitiveOmitted 期望两个键，实际 %v", sensitiveOmitted)
	}

	// 白名单外的键不会混进快照
	leaky, _ := BuildExportedSettings(map[string]string{
		"admin_password":        "$2b$10$deadbeef",
		"password_changed":      "true",
		"comment_verify_secret": "internal-secret",
		"secret_key":            "leak-me",
	})
	for _, key := range []string{"admin_password", "password_changed", "comment_verify_secret", "secret_key"} {
		if _, ok := leaky[key]; ok {
			t.Errorf("设置 %s 不应被导出", key)
		}
	}
}
