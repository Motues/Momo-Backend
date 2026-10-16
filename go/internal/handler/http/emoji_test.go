package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

/*
接口层：表情配置契约 v2（doc/emoji.md 第 1、3 节）。

覆盖 PUT /admin/settings 的 emoji_enabled / emoji_cdn_url 校验与归一化、type=emoji 分组、
GET /api/comments 的两个下发字段、GET /api/emoji 的删除（404），以及导出 / 导入往返。
跨语言固定向量在 utils 包的 emoji_vectors_test.go。
*/

const emojiTestSlug = "/posts/emoji"

// emojiCommentsPayload GET /api/comments 响应体中与本契约相关的最小视图
type emojiCommentsPayload struct {
	Code int `json:"code"`
	Data struct {
		EmojiCdnURL  string `json:"emoji_cdn_url"`
		EmojiEnabled string `json:"emoji_enabled"`
	} `json:"data"`
}

// emojiCommentsConfig 读取 /api/comments 下发的两个表情字段
func emojiCommentsConfig(t *testing.T) (url, enabled string) {
	t.Helper()
	w := callJSON(t, "GET", "/api/comments?post_slug="+queryEscape(emojiTestSlug), "")
	requireStatus(t, w, http.StatusOK)

	var payload emojiCommentsPayload
	decodeInto(t, w, &payload)
	return payload.Data.EmojiCdnURL, payload.Data.EmojiEnabled
}

// seedEmojiComment 写入一条评论，保证 GET /api/comments 有稳定可查的数据
func seedEmojiComment(t *testing.T) {
	t.Helper()
	seedComment(t, &model.Comment{
		PostSlug:    emojiTestSlug,
		Author:      "Alice",
		Email:       "alice@example.com",
		ContentText: "hello",
		ContentHTML: "<p>hello</p>",
		PubDate:     1730000000000,
	})
}

// emojiSettingRowCount 统计某个设置键在库中的行数（用于「不落库」断言）
func emojiSettingRowCount(t *testing.T, key string) int {
	t.Helper()
	var count int
	if err := testDB.Get(&count, "SELECT COUNT(*) FROM Settings WHERE key = ?", key); err != nil {
		t.Fatalf("查询设置 %s 失败: %v", key, err)
	}
	return count
}

// ---------------------------------------------------------------------------
// GET /api/emoji —— 路由已整体删除
// ---------------------------------------------------------------------------

func TestGetEmojiRouteRemoved(t *testing.T) {
	resetState(t)
	seedEmojiComment(t)

	// 路由已整体删除后 /api/emoji 不再命中任何 handler：
	// main.go 的 NoRoute 明确排除 /api 前缀（不做 SPA 兜底），因此实际行为是 404。
	// 断言以「不再是 owo 接口」为主，另外钉住当前的实际状态码。
	for _, testCase := range []struct {
		name   string
		result *httptest.ResponseRecorder
	}{
		{"公开访问", callJSON(t, "GET", "/api/emoji", "")},
		{"带 token 访问", callWithToken(t, "GET", "/api/emoji", "", adminToken(t))},
	} {
		w := testCase.result
		if w.Code != http.StatusNotFound {
			t.Errorf("%s：Go 端 /api/* 不参与静态兜底，期望 404，实际 %d；body=%s",
				testCase.name, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "Emoji packs fetched") {
			t.Errorf("%s：不应再返回旧的 owo 接口响应体：%s", testCase.name, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "emoji_packs") {
			t.Errorf("%s：响应不应再出现表情包数据：%s", testCase.name, w.Body.String())
		}
	}
}

// ---------------------------------------------------------------------------
// PUT /admin/settings —— emoji_enabled
// ---------------------------------------------------------------------------

func TestUpdateSettingsEmojiEnabled(t *testing.T) {
	resetState(t)

	t.Run("缺少 token 返回 401", func(t *testing.T) {
		requireStatus(t, callJSON(t, "PUT", "/admin/settings", `{"emoji_enabled":"true"}`), http.StatusUnauthorized)
	})

	t.Run("合法值写入归一化后的结果", func(t *testing.T) {
		for _, testCase := range []struct {
			raw  string
			want string
		}{
			{"true", "true"},
			{"false", "false"},
			{" TRUE ", "true"},
			{"False", "false"},
			{"  False  ", "false"},
			{"", ""},
			{"   ", ""},
		} {
			truncateAll()
			token := adminToken(t)
			body := `{"emoji_enabled":` + mustJSONString(t, testCase.raw) + `}`
			requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusOK)

			if got := utils.GetSetting("emoji_enabled"); got != testCase.want {
				t.Errorf("写入 %q 后落库期望 %q，实际 %q", testCase.raw, testCase.want, got)
			}
		}
	})

	t.Run("非法值返回 400 且不落库", func(t *testing.T) {
		for _, raw := range []string{"1", "0", "yes", "on", "true1", " false1", "true false", "null", "2", "否"} {
			truncateAll()
			token := adminToken(t)
			// 先写一个合法值：非法请求既不能改写它，也不能新增行
			setSetting(t, "emoji_enabled", "true")

			body := `{"emoji_enabled":` + mustJSONString(t, raw) + `}`
			w := callWithToken(t, "PUT", "/admin/settings", body, token)
			requireStatus(t, w, http.StatusBadRequest)

			m := decodeJSON(t, w)
			if got, _ := m["message"].(string); got != "emoji_enabled 只能是 true 或 false" {
				t.Errorf("值 %q 的错误信息期望 %q，实际 %q", raw, "emoji_enabled 只能是 true 或 false", got)
			}
			if got := utils.GetSetting("emoji_enabled"); got != "true" {
				t.Errorf("值 %q 被拒后不应改写已有配置，实际 %q", raw, got)
			}
			if count := emojiSettingRowCount(t, "emoji_enabled"); count != 1 {
				t.Errorf("值 %q 被拒后不应新增行，实际 %d 行", raw, count)
			}
		}
	})

	t.Run("非法值不落库（库中原本没有该键）", func(t *testing.T) {
		truncateAll()
		token := adminToken(t)
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"emoji_enabled":"yes"}`, token), http.StatusBadRequest)
		if count := emojiSettingRowCount(t, "emoji_enabled"); count != 0 {
			t.Errorf("非法值不应落库，实际 %d 行", count)
		}
	})

	t.Run("同一批里的其它键也不落库", func(t *testing.T) {
		truncateAll()
		token := adminToken(t)
		body := `{"site_name":"不应写入","emoji_enabled":"也许"}`
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusBadRequest)
		if got := utils.GetSetting("site_name"); got != "" {
			t.Errorf("校验失败时不应写入任何设置，site_name 实际 %q", got)
		}
	})
}

// ---------------------------------------------------------------------------
// PUT /admin/settings —— emoji_cdn_url
// ---------------------------------------------------------------------------

func TestUpdateSettingsEmojiCdnURL(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	maxURL := "https://cdn.example.com/" + strings.Repeat("a", utils.MaxEmojiCDNURLLength-len("https://cdn.example.com/"))
	tooLongURL := maxURL + "a"

	t.Run("非法地址返回 400 且不落库", func(t *testing.T) {
		for _, testCase := range []struct {
			value string
			want  string
		}{
			{"ftp://a.com/owo.json", "emoji_cdn_url 只允许 http/https 地址"},
			{"javascript:alert(1)", "emoji_cdn_url 只允许 http/https 地址"},
			{"owo.json", "emoji_cdn_url 只允许 http/https 地址"},
			{"//example.com/owo.json", "emoji_cdn_url 只允许 http/https 地址"},
			{`https://cdn.example.com/a"b.json`, "emoji_cdn_url 只允许 http/https 地址"},
			{`<img src=x>`, "emoji_cdn_url 只允许 http/https 地址"},
			{"data:application/json,{}", "emoji_cdn_url 只允许 http/https 地址"},
			{tooLongURL, "emoji_cdn_url 不能超过 500 个字符"},
		} {
			truncateAll()
			token = adminToken(t)

			body := `{"emoji_cdn_url":` + mustJSONString(t, testCase.value) + `}`
			w := callWithToken(t, "PUT", "/admin/settings", body, token)
			requireStatus(t, w, http.StatusBadRequest)
			requireBodyCode(t, w, http.StatusBadRequest)

			m := decodeJSON(t, w)
			if got, _ := m["message"].(string); got != testCase.want {
				t.Errorf("地址 %q 的错误信息期望 %q，实际 %q", testCase.value, testCase.want, got)
			}
			if count := emojiSettingRowCount(t, "emoji_cdn_url"); count != 0 {
				t.Errorf("地址 %q 非法时不应落库，实际 %d 行", testCase.value, count)
			}
		}
	})

	t.Run("合法地址写入 trim 后的值", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)

		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"emoji_cdn_url":"  https://cdn.example.com/owo.json?group=Emoji  "}`, token), http.StatusOK)
		if got := utils.GetSetting("emoji_cdn_url"); got != "https://cdn.example.com/owo.json?group=Emoji" {
			t.Errorf("地址两侧空格应被归一化，实际 %q", got)
		}

		// 大写协议同样合法，且原样保存（只 trim，不改大小写）
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"emoji_cdn_url":"HTTPS://Example.COM/OWO.JSON"}`, token), http.StatusOK)
		if got := utils.GetSetting("emoji_cdn_url"); got != "HTTPS://Example.COM/OWO.JSON" {
			t.Errorf("合法地址应原样保存，实际 %q", got)
		}

		// 恰好 500 码点通过
		requireStatus(t, callWithToken(t, "PUT", "/admin/settings", `{"emoji_cdn_url":`+mustJSONString(t, maxURL)+`}`, token), http.StatusOK)
	})

	t.Run("空串与空白串等价于未配置", func(t *testing.T) {
		truncateAll()
		token = adminToken(t)

		for _, raw := range []string{"", "   "} {
			body := `{"emoji_cdn_url":` + mustJSONString(t, raw) + `}`
			requireStatus(t, callWithToken(t, "PUT", "/admin/settings", body, token), http.StatusOK)
			if got := utils.GetSetting("emoji_cdn_url"); got != "" {
				t.Errorf("写入 %q 后应存空串，实际 %q", raw, got)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// GET /admin/settings?type=emoji
// ---------------------------------------------------------------------------

func TestGetSettingsEmojiGroup(t *testing.T) {
	resetState(t)
	token := adminToken(t)
	setSetting(t, "emoji_enabled", "false")
	setSetting(t, "emoji_cdn_url", "https://cdn.example.com/owo.json")
	setSetting(t, "site_name", "我的站")

	w := callWithToken(t, "GET", "/admin/settings?type=emoji", "", token)
	requireStatus(t, w, http.StatusOK)

	var payload settingsPayload
	decodeInto(t, w, &payload)

	if got := payload.Data["emoji_enabled"]; got != "false" {
		t.Errorf("emoji_enabled 未下发：%v", got)
	}
	if got := payload.Data["emoji_cdn_url"]; got != "https://cdn.example.com/owo.json" {
		t.Errorf("emoji_cdn_url 未下发：%v", got)
	}
	// 分组固定下发默认值补全的 email_enabled，其它键一律不得混入
	if got := payload.Data["email_enabled"]; got != "true" {
		t.Errorf("email_enabled 期望补默认值 true，实际 %q", got)
	}
	if len(payload.Data) != 3 {
		t.Errorf("type=emoji 应只含 emoji_enabled / emoji_cdn_url / email_enabled，实际 %v", keysOf(payload.Data))
	}
	if _, exists := payload.Data["site_name"]; exists {
		t.Errorf("type=emoji 不应带回其它分组字段：%v", keysOf(payload.Data))
	}
	if _, exists := payload.Data["emoji_packs"]; exists {
		t.Errorf("emoji_packs 已从契约删除，不应出现：%v", keysOf(payload.Data))
	}
}

// ---------------------------------------------------------------------------
// GET /api/comments —— 下发 emoji_enabled + 归一化后的 emoji_cdn_url
// ---------------------------------------------------------------------------

func TestCommentsCarryEmojiConfig(t *testing.T) {
	resetState(t)
	seedEmojiComment(t)

	t.Run("未配置时回落默认源并启用", func(t *testing.T) {
		url, enabled := emojiCommentsConfig(t)
		if url != utils.DefaultEmojiCDN {
			t.Errorf("未配置时地址应回落默认源 %q，实际 %q", utils.DefaultEmojiCDN, url)
		}
		if enabled != "true" {
			t.Errorf("未配置时开关应 fail-open 为 true，实际 %q", enabled)
		}
	})

	for _, testCase := range []struct {
		name      string
		storedURL string
		storedOn  string
		expectURL string
		expectOn  string
	}{
		{"已配置：地址与开关原样下发", "https://cdn.example.com/owo.json", "true", "https://cdn.example.com/owo.json", "true"},
		{"关闭时地址照常下发", "https://cdn.example.com/owo.json?group=Emoji", "false", "https://cdn.example.com/owo.json?group=Emoji", "false"},
		{"地址两侧空格被裁掉", "  https://cdn.example.com/owo.json  ", "true", "https://cdn.example.com/owo.json", "true"},
		{"历史脏值 FALSE 判为关闭", "https://cdn.example.com/owo.json", "FALSE", "https://cdn.example.com/owo.json", "false"},
		{"无法识别的开关 fail-open 为启用", "https://cdn.example.com/owo.json", "yes", "https://cdn.example.com/owo.json", "true"},
		{"关闭且未配地址：地址仍回落默认源", "", "false", utils.DefaultEmojiCDN, "false"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			setSetting(t, "emoji_cdn_url", testCase.storedURL)
			setSetting(t, "emoji_enabled", testCase.storedOn)

			url, enabled := emojiCommentsConfig(t)
			if url != testCase.expectURL {
				t.Errorf("emoji_cdn_url 期望 %q，实际 %q", testCase.expectURL, url)
			}
			if enabled != testCase.expectOn {
				t.Errorf("emoji_enabled 期望 %q，实际 %q", testCase.expectOn, enabled)
			}
		})
	}

	t.Run("响应体里两个字段都是字符串", func(t *testing.T) {
		w := callJSON(t, "GET", "/api/comments?post_slug="+queryEscape(emojiTestSlug), "")
		requireStatus(t, w, http.StatusOK)

		m := decodeJSON(t, w)
		data, ok := m["data"].(map[string]interface{})
		if !ok {
			t.Fatalf("响应缺少 data 对象: %s", w.Body.String())
		}
		for _, key := range []string{"emoji_enabled", "emoji_cdn_url"} {
			if _, ok := data[key].(string); !ok {
				t.Errorf("data.%s 必须是字符串，实际 %T（%v）", key, data[key], data[key])
			}
		}
	})
}

// ---------------------------------------------------------------------------
// 导出 / 导入往返
// ---------------------------------------------------------------------------

func TestSettingsExportImportEmoji(t *testing.T) {
	resetState(t)
	token := adminToken(t)
	setSetting(t, "emoji_enabled", "false")
	setSetting(t, "emoji_cdn_url", "https://cdn.example.com/owo.json")

	exported := callWithToken(t, "GET", "/admin/data/export/settings", "", token)
	requireStatus(t, exported, http.StatusOK)

	var payload struct {
		Data struct {
			Settings map[string]string `json:"settings"`
		} `json:"data"`
	}
	decodeInto(t, exported, &payload)

	if got := payload.Data.Settings["emoji_enabled"]; got != "false" {
		t.Errorf("导出缺少 emoji_enabled：%v", got)
	}
	if got := payload.Data.Settings["emoji_cdn_url"]; got != "https://cdn.example.com/owo.json" {
		t.Errorf("导出缺少 emoji_cdn_url：%v", got)
	}
	if _, exists := payload.Data.Settings["emoji_packs"]; exists {
		t.Errorf("emoji_packs 已从契约删除，不应出现在导出里")
	}

	t.Run("导入往返并归一化", func(t *testing.T) {
		truncateAll()
		importToken := adminToken(t)

		body := `{"emoji_enabled":" FALSE ","emoji_cdn_url":"  https://cdn.example.com/owo.json  "}`
		requireStatus(t, callWithToken(t, "POST", "/admin/data/import/settings", body, importToken), http.StatusOK)

		if got := utils.GetSetting("emoji_enabled"); got != "false" {
			t.Errorf("导入后 emoji_enabled 应被归一化为 false，实际 %q", got)
		}
		if got := utils.GetSetting("emoji_cdn_url"); got != "https://cdn.example.com/owo.json" {
			t.Errorf("导入后 emoji_cdn_url 应被去空格，实际 %q", got)
		}
	})

	t.Run("导入非法 emoji_enabled 被拒绝且不落库", func(t *testing.T) {
		truncateAll()
		importToken := adminToken(t)

		w := callWithToken(t, "POST", "/admin/data/import/settings", `{"emoji_enabled":"yes"}`, importToken)
		requireStatus(t, w, http.StatusBadRequest)

		m := decodeJSON(t, w)
		if got, _ := m["message"].(string); got != "emoji_enabled 只能是 true 或 false" {
			t.Errorf("导入校验错误信息不正确: %q", got)
		}
		if count := emojiSettingRowCount(t, "emoji_enabled"); count != 0 {
			t.Errorf("非法开关不应落库，实际 %d 行", count)
		}
	})

	t.Run("导入非法 emoji_cdn_url 被拒绝且不落库", func(t *testing.T) {
		truncateAll()
		importToken := adminToken(t)

		w := callWithToken(t, "POST", "/admin/data/import/settings", `{"emoji_cdn_url":"ftp://a.com/owo.json"}`, importToken)
		requireStatus(t, w, http.StatusBadRequest)

		m := decodeJSON(t, w)
		if got, _ := m["message"].(string); got != "emoji_cdn_url 只允许 http/https 地址" {
			t.Errorf("导入校验错误信息不正确: %q", got)
		}
		if count := emojiSettingRowCount(t, "emoji_cdn_url"); count != 0 {
			t.Errorf("非法地址不应落库，实际 %d 行", count)
		}
	})
}

// ---------------------------------------------------------------------------
// emoji_packs 已从白名单移除
// ---------------------------------------------------------------------------

func TestUpdateSettingsRejectsEmojiPacks(t *testing.T) {
	resetState(t)
	token := adminToken(t)

	w := callWithToken(t, "PUT", "/admin/settings", `{"emoji_packs":"{}"}`, token)
	requireStatus(t, w, http.StatusBadRequest)

	m := decodeJSON(t, w)
	if got, _ := m["message"].(string); got != `Setting "emoji_packs" is not allowed` {
		t.Errorf("错误信息期望 %q，实际 %q", `Setting "emoji_packs" is not allowed`, got)
	}
	if count := emojiSettingRowCount(t, "emoji_packs"); count != 0 {
		t.Errorf("被拒绝的键不应落库，实际 %d 行", count)
	}

	// 导入路径同样不再接受该键（白名单之外的键一律跳过）
	importToken := adminToken(t)
	callWithToken(t, "POST", "/admin/data/import/settings", `{"emoji_packs":"{}"}`, importToken)
	if count := emojiSettingRowCount(t, "emoji_packs"); count != 0 {
		t.Errorf("导入不得写入 emoji_packs，实际 %d 行", count)
	}
}
