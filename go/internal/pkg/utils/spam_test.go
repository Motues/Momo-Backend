package utils

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// 审核自动化 —— 关键词解析
// ---------------------------------------------------------------------------

func TestParseSpamKeywords(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want []string
	}{
		{"未配置", "", nil},
		{"空白", "   ", nil},
		{"空数组", "[]", []string{}},
		{"普通数组", `["加微信","casino"]`, []string{"加微信", "casino"}},
		{"去空白并转小写", `["  SPAM  ","XSS"]`, []string{"spam", "xss"}},
		{"丢弃空串与非字符串", `["ok","","   ",42,null]`, []string{"ok"}},
		{"非法 JSON 放行", "{oops", nil},
		{"非数组放行", `{"a":1}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseSpamKeywords(tc.raw)
			if len(got) != len(tc.want) {
				t.Fatalf("期望 %v，实际 %v", tc.want, got)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("第 %d 项期望 %q，实际 %q", i, tc.want[i], got[i])
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 审核自动化 —— 数值配置
// ---------------------------------------------------------------------------

func TestParseSpamNumber(t *testing.T) {
	for _, tc := range []struct {
		name     string
		raw      string
		fallback int
		max      int
		want     int
	}{
		{"未配置用默认值", "", 3, 50, 3},
		{"空白用默认值", "  ", 3, 50, 3},
		{"正常数字", "10", 3, 50, 10},
		{"0 表示关闭", "0", 3, 50, 0},
		{"超过上限按上限夹取", "999", 3, 50, 50},
		{"负数用默认值", "-1", 3, 50, 3},
		{"小数用默认值", "1.5", 3, 50, 3},
		{"带单位用默认值", "10m", 5, 2000, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseSpamNumber(tc.raw, tc.fallback, tc.max); got != tc.want {
				t.Errorf("期望 %d，实际 %d", tc.want, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 审核自动化 —— 链接统计
// ---------------------------------------------------------------------------

func TestCountLinks(t *testing.T) {
	for _, tc := range []struct {
		name string
		text string
		want int
	}{
		{"空文本", "", 0},
		{"无链接", "这是一条普通评论", 0},
		{"单个 http", "看 http://a.com", 1},
		{"单个 https", "看 https://a.com", 1},
		{"多个带协议链接", "https://a.com 和 http://b.com", 2},
		{"裸 www", "看 www.a.com", 1},
		{"多个裸 www", "www.a.com 与 www.b.com", 2},
		{"https://www. 只算一次", "https://www.a.com", 1},
		{"Markdown 链接", "[点这里](https://a.com)", 1},
		{"混合形式", "https://a.com 与 www.b.com", 2},
		{"大小写不敏感", "HTTPS://A.COM 与 WWW.B.COM", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := CountLinks(tc.text); got != tc.want {
				t.Errorf("期望 %d，实际 %d", tc.want, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 审核自动化 —— 规则判定
// ---------------------------------------------------------------------------

func TestEvaluateSpamRulesDisabled(t *testing.T) {
	// 全部阈值置 0（不启用）时任何内容都不应被判为垃圾
	if got := EvaluateSpamRules("好", "a", "", nil, 0, 0); got != "" {
		t.Errorf("全部规则关闭时应放行，实际 %q", got)
	}
}

func TestEvaluateSpamRulesKeywords(t *testing.T) {
	keywords := []string{"加微信", "casino"}

	for _, tc := range []struct {
		name    string
		content string
		author  string
		url     string
		want    string
	}{
		{"正文命中", "请加微信 123", "a", "", "keyword:加微信"},
		{"昵称命中", "正常评论内容", "casino 代理", "", "keyword:casino"},
		{"网址命中", "正常评论内容", "a", "https://casino.example.com", "keyword:casino"},
		{"大小写不敏感", "Visit CASINO now", "a", "", "keyword:casino"},
		{"未命中", "这是一条正常的评论", "a", "https://example.com", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// 链接与长度阈值刻意关闭，隔离关键词规则
			if got := EvaluateSpamRules(tc.content, tc.author, tc.url, keywords, 0, 0); got != tc.want {
				t.Errorf("期望 %q，实际 %q", tc.want, got)
			}
		})
	}
}

func TestEvaluateSpamRulesLinks(t *testing.T) {
	for _, tc := range []struct {
		name     string
		content  string
		url      string
		maxLinks int
		want     string
	}{
		{"超过阈值", "https://a.com https://b.com https://c.com https://d.com", "", 3, "too_many_links:4"},
		{"等于阈值放行", "https://a.com https://b.com https://c.com", "", 3, ""},
		{"个人网址字段计 1", "https://a.com https://b.com https://c.com", "https://me.com", 3, "too_many_links:4"},
		{"阈值 0 不限制", strings.Repeat("https://a.com ", 20), "", 0, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := EvaluateSpamRules(tc.content, "a", tc.url, nil, tc.maxLinks, 0); got != tc.want {
				t.Errorf("期望 %q，实际 %q", tc.want, got)
			}
		})
	}
}

func TestEvaluateSpamRulesLength(t *testing.T) {
	for _, tc := range []struct {
		name      string
		content   string
		minLength int
		want      string
	}{
		{"短于阈值", "内容", 5, "too_short:2"},
		{"等于阈值放行", "你好世界啊", 5, ""},
		{"长于阈值放行", "这是一条正常的评论", 5, ""},
		{"阈值 0 不限制", "顶", 0, ""},
		{"首尾空白不计入长度", "  内容  ", 3, "too_short:2"},
		{"emoji 按码点计数", "👍👍👍", 3, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := EvaluateSpamRules(tc.content, "a", "", nil, 0, tc.minLength); got != tc.want {
				t.Errorf("期望 %q，实际 %q", tc.want, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 审核自动化 —— 后台设置校验
// ---------------------------------------------------------------------------

func TestIsValidSpamKeywordsJSON(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want bool
	}{
		{"空串表示未设置", "", true},
		{"空数组", "[]", true},
		{"正常数组", `["a","b"]`, true},
		{"非法 JSON", "{oops", false},
		{"非数组", `{"a":1}`, false},
		{"包含空串", `["a",""]`, false},
		{"包含纯空白", `["a","  "]`, false},
		{"包含非字符串", `["a",1]`, false},
		{"超长单条", `["` + strings.Repeat("字", SpamMaxKeywordLength+1) + `"]`, false},
		{"单条达到上限", `["` + strings.Repeat("字", SpamMaxKeywordLength) + `"]`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsValidSpamKeywordsJSON(tc.raw); got != tc.want {
				t.Errorf("期望 %v，实际 %v", tc.want, got)
			}
		})
	}
}

func TestValidateSpamSetting(t *testing.T) {
	for _, tc := range []struct {
		name    string
		key     string
		value   string
		wantErr bool
	}{
		{"关键词合法", "comment_spam_keywords", `["a"]`, false},
		{"关键词非法", "comment_spam_keywords", "{oops", true},
		{"链接上限合法", "comment_spam_max_links", "3", false},
		{"链接上限为 0", "comment_spam_max_links", "0", false},
		{"链接上限为空（用默认值）", "comment_spam_max_links", "", false},
		{"链接上限超范围", "comment_spam_max_links", "51", true},
		{"链接上限非数字", "comment_spam_max_links", "abc", true},
		{"链接上限为负", "comment_spam_max_links", "-1", true},
		{"最短长度合法", "comment_spam_min_length", "5", false},
		{"最短长度超范围", "comment_spam_min_length", "2001", true},
		{"重复窗口合法", "comment_spam_duplicate_window", "10", false},
		{"重复窗口超范围", "comment_spam_duplicate_window", "10081", true},
		{"无关的键不校验", "site_name", "随便", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			msg := ValidateSpamSetting(tc.key, tc.value)
			if tc.wantErr && msg == "" {
				t.Error("期望校验失败，实际通过")
			}
			if !tc.wantErr && msg != "" {
				t.Errorf("期望校验通过，实际 %q", msg)
			}
		})
	}
}

func TestIsSpamSettingKey(t *testing.T) {
	for _, key := range []string{
		"comment_spam_keywords",
		"comment_spam_max_links",
		"comment_spam_min_length",
		"comment_spam_duplicate_window",
	} {
		if !IsSpamSettingKey(key) {
			t.Errorf("%s 应属于垃圾规则设置", key)
		}
	}
	for _, key := range []string{"comment_auto_approve", "ip_blacklist", "", "comment_spam_unknown"} {
		if IsSpamSettingKey(key) {
			t.Errorf("%s 不应属于垃圾规则设置", key)
		}
	}
}

// ---------------------------------------------------------------------------
// 审核自动化 —— 默认阈值（与后台页面 / Node / Worker 必须一致）
// ---------------------------------------------------------------------------

func TestSpamDefaultsMatchDashboard(t *testing.T) {
	// 四项默认值全部为 0（不启用）：升级后行为与旧版本完全一致，不会凭空拦下评论
	if SpamDefaultMaxLinks != 0 {
		t.Errorf("链接数默认阈值期望 0（不启用），实际 %d", SpamDefaultMaxLinks)
	}
	if SpamDefaultMinLength != 0 {
		t.Errorf("正文最短长度默认值期望 0（不启用），实际 %d", SpamDefaultMinLength)
	}
	if SpamDefaultDuplicateWindow != 0 {
		t.Errorf("重复检测默认时间窗期望 0（不启用），实际 %d", SpamDefaultDuplicateWindow)
	}
}

func TestGetCommentSpamSettingsDefaults(t *testing.T) {
	resetSettings(t)

	keywords, maxLinks, minLength, window := GetCommentSpamSettings()
	if keywords != nil {
		t.Errorf("未配置时关键词应为空，实际 %v", keywords)
	}
	if maxLinks != SpamDefaultMaxLinks || minLength != SpamDefaultMinLength || window != SpamDefaultDuplicateWindow {
		t.Errorf("未配置时应使用默认阈值，实际 maxLinks=%d minLength=%d window=%d",
			maxLinks, minLength, window)
	}

	setSetting(t, "comment_spam_keywords", `["加微信"]`)
	setSetting(t, "comment_spam_max_links", "7")
	setSetting(t, "comment_spam_min_length", "0")
	setSetting(t, "comment_spam_duplicate_window", "60")

	keywords, maxLinks, minLength, window = GetCommentSpamSettings()
	if len(keywords) != 1 || keywords[0] != "加微信" {
		t.Errorf("关键词解析错误: %v", keywords)
	}
	if maxLinks != 7 || minLength != 0 || window != 60 {
		t.Errorf("阈值解析错误: maxLinks=%d minLength=%d window=%d", maxLinks, minLength, window)
	}
}
