package http

import (
	"net/http"
	"testing"

	"momo-backend-go/internal/pkg/utils"
)

// API 地址（verify_base_url）与邮箱验证开关的写入口径（三端逐字一致）。
func TestUpdateSettingsVerifyBaseURL(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	// 归一化：去首尾空格与末尾斜杠
	body := `{"verify_base_url":"  https://api.example.com///  "}`
	requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusOK)
	if got := utils.GetSetting("verify_base_url"); got != "https://api.example.com" {
		t.Errorf("API 地址应去空格与末尾斜杠，实际 %q", got)
	}

	// 非法地址整批拒绝，且不写入同请求里的其它键
	invalid := []string{
		"api.example.com",
		"ftp://api.example.com",
		"https://",
		"https://a.com?x=1",
		"https://u:p@a.com",
	}
	for _, value := range invalid {
		w := callWithToken(t, "PUT", "/admin/settings",
			`{"verify_base_url":"`+value+`","site_name":"不应写入"}`, token)
		requireStatus(t, w, http.StatusBadRequest)
		payload := decodeJSON(t, w)
		if got, _ := payload["message"].(string); got != utils.VerifyBaseURLError {
			t.Errorf("%q 的错误信息期望 %q，实际 %q", value, utils.VerifyBaseURLError, got)
		}
		if got := utils.GetSetting("site_name"); got != "" {
			t.Errorf("校验失败时不应落库，site_name 实际 %q", got)
		}
	}
}

func TestUpdateSettingsVerifyDependencies(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"邮箱验证开启但未填 API 地址", `{"email_verify_enabled":"true"}`, utils.EmailVerifyNeedsBaseURLError},
		{"链接同步开启但未填 API 地址", `{"link_sync_enabled":"true"}`, utils.LinkSyncNeedsBaseURLError},
		{"休眠提醒开启但未填 API 地址", `{"link_dormant_notice_enabled":"true"}`, utils.DormantNoticeNeedsBaseURLError},
		{"邮箱验证开关脏值", `{"email_verify_enabled":"yes"}`, utils.EmailVerifyEnabledError},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resetState(t)
			token := adminToken(t)
			w := callWithToken(t, "PUT", "/admin/settings", testCase.body, token)
			requireStatus(t, w, http.StatusBadRequest)
			payload := decodeJSON(t, w)
			if got, _ := payload["message"].(string); got != testCase.want {
				t.Errorf("错误信息期望 %q，实际 %q", testCase.want, got)
			}
		})
	}

	t.Run("同一请求填地址并开启功能可以通过", func(t *testing.T) {
		resetState(t)
		token := adminToken(t)
		body := `{"verify_base_url":"https://api.example.com","email_verify_enabled":"true",` +
			`"link_sync_enabled":"true","link_dormant_notice_enabled":"true"}`
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusOK)
	})
}

func TestUpdateSettingsCannotClearBaseURLWhileDependentEnabled(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	setSetting(t, "verify_base_url", "https://api.example.com")
	setSetting(t, "link_sync_enabled", "true")

	w := callWithToken(t, "PUT", "/admin/settings", `{"verify_base_url":""}`, token)
	requireStatus(t, w, http.StatusBadRequest)
	payload := decodeJSON(t, w)
	if got, _ := payload["message"].(string); got != utils.LinkSyncNeedsBaseURLError {
		t.Errorf("错误信息期望 %q，实际 %q", utils.LinkSyncNeedsBaseURLError, got)
	}

	setSetting(t, "link_sync_enabled", "false")
	requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"verify_base_url":""}`, token), http.StatusOK)
	if got := utils.GetSetting("verify_base_url"); got != "" {
		t.Errorf("关闭依赖后应可清空 API 地址，实际 %q", got)
	}
}

func TestImportSettingsVerifyDependencies(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "POST", "/admin/data/import/settings", `{"link_dormant_notice_enabled":"true"}`, token)
	requireStatus(t, w, http.StatusBadRequest)
	payload := decodeJSON(t, w)
	if got, _ := payload["message"].(string); got != utils.DormantNoticeNeedsBaseURLError {
		t.Errorf("导入时错误信息期望 %q，实际 %q", utils.DormantNoticeNeedsBaseURLError, got)
	}

	body := `{"verify_base_url":"https://api.example.com","link_dormant_notice_enabled":"true"}`
	requireStatus(t, callWithToken(t, "POST", "/admin/data/import/settings", body, token), http.StatusOK)
}
