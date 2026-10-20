package utils

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

/*
表情配置契约 v2 的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

口径见 doc/emoji.md 第 1、3 节：默认源 / 默认开关 / 长度上限、写入路径校验与读取路径
归一化只要有一端漂移，这里就会立刻失败。
*/

// emojiFixture doc/vectors/emoji-v2.json 的结构化视图
type emojiFixture struct {
	Defaults struct {
		CdnURL  string `json:"cdnUrl"`
		Enabled string `json:"enabled"`
	} `json:"defaults"`
	Limits struct {
		MaxCdnURLLen int `json:"maxCdnUrlLen"`
	} `json:"limits"`
	Enabled struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"enabled"`
	CdnURL struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"cdnUrl"`
	Resolve []struct {
		Name          string `json:"name"`
		StoredURL     string `json:"storedUrl"`
		StoredEnabled string `json:"storedEnabled"`
		ExpectURL     string `json:"expectUrl"`
		ExpectEnabled string `json:"expectEnabled"`
	} `json:"resolve"`
}

func loadEmojiFixture(t *testing.T) emojiFixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("emoji-v2.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/emoji-v2.json 失败: %v", err)
	}
	var fixture emojiFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/emoji-v2.json 失败: %v", err)
	}
	return fixture
}

// TestEmojiVectorDefaults 钉死默认源 / 默认开关与长度上限
func TestEmojiVectorDefaults(t *testing.T) {
	fixture := loadEmojiFixture(t)

	if DefaultEmojiCDN != fixture.Defaults.CdnURL {
		t.Errorf("DefaultEmojiCDN 期望 %q，实际 %q", fixture.Defaults.CdnURL, DefaultEmojiCDN)
	}
	if DefaultEmojiEnabled != fixture.Defaults.Enabled {
		t.Errorf("DefaultEmojiEnabled 期望 %q，实际 %q", fixture.Defaults.Enabled, DefaultEmojiEnabled)
	}
	if MaxEmojiCDNURLLength != fixture.Limits.MaxCdnURLLen {
		t.Errorf("MaxEmojiCDNURLLength 期望 %d，实际 %d", fixture.Limits.MaxCdnURLLen, MaxEmojiCDNURLLength)
	}
}

// TestEmojiCdnURLVector 写入路径：emoji_cdn_url 的合法 / 非法取值（全量）
func TestEmojiCdnURLVector(t *testing.T) {
	fixture := loadEmojiFixture(t)

	for _, value := range fixture.CdnURL.Valid {
		t.Run("valid:"+vectorLabel(value), func(t *testing.T) {
			if msg := ValidateEmojiCdnURL(value); msg != "" {
				t.Errorf("期望通过校验，实际被拒：%s", msg)
			}
		})
	}
	for _, value := range fixture.CdnURL.Invalid {
		t.Run("invalid:"+vectorLabel(value), func(t *testing.T) {
			if msg := ValidateEmojiCdnURL(value); msg == "" {
				t.Errorf("期望被拒，实际通过校验：%q", value)
			}
		})
	}
}

// TestEmojiEnabledVector 写入路径：emoji_enabled 的合法 / 非法取值（全量）
func TestEmojiEnabledVector(t *testing.T) {
	fixture := loadEmojiFixture(t)

	for _, value := range fixture.Enabled.Valid {
		t.Run("valid:"+vectorLabel(value), func(t *testing.T) {
			if msg := ValidateEmojiEnabled(value); msg != "" {
				t.Errorf("期望通过校验，实际被拒：%s", msg)
			}
			// 合法值归一化后必须落在 "" / "true" / "false" 三者之一（写入路径存的就是它）
			switch normalized := NormalizeEmojiEnabled(value); normalized {
			case "", "true", "false":
			default:
				t.Errorf("归一化结果 %q 不在允许集合内", normalized)
			}
		})
	}
	for _, value := range fixture.Enabled.Invalid {
		t.Run("invalid:"+vectorLabel(value), func(t *testing.T) {
			msg := ValidateEmojiEnabled(value)
			if msg == "" {
				t.Errorf("期望被拒，实际通过校验：%q", value)
			} else if msg != "emoji_enabled 只能是 true 或 false" {
				t.Errorf("错误信息不符：%q", msg)
			}
		})
	}
}

// TestEmojiResolveVector 读取路径：ResolveEmojiConfig 的每个固定用例。
//
// v2 契约只有单地址键，因此这里固定把 emoji_cdn_urls 传空串，
// 走「数组为空 → 回落旧键 → 再回落默认源」这条链（与 v2 语义完全一致）。
func TestEmojiResolveVector(t *testing.T) {
	fixture := loadEmojiFixture(t)
	if len(fixture.Resolve) == 0 {
		t.Fatal("fixture 的 resolve 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Resolve {
		t.Run(testCase.Name, func(t *testing.T) {
			urls, gotEnabled := ResolveEmojiConfig("", testCase.StoredURL, testCase.StoredEnabled)
			if len(urls) == 0 {
				t.Fatalf("urls 不应为空")
			}
			if gotURL := urls[0]; gotURL != testCase.ExpectURL {
				t.Errorf("url 期望 %q，实际 %q", testCase.ExpectURL, gotURL)
			}
			if gotEnabled != testCase.ExpectEnabled {
				t.Errorf("enabled 期望 %q，实际 %q", testCase.ExpectEnabled, gotEnabled)
			}
		})
	}
}

// TestResolveEmojiConfigFailOpen 补充断言读取路径的 fail-open 口径与幂等性
func TestResolveEmojiConfigFailOpen(t *testing.T) {
	for _, stored := range []string{"", "   ", "yes", "1", "TRUE", "True", "unknowable"} {
		if _, enabled := ResolveEmojiConfig("", "", stored); enabled != "true" {
			t.Errorf("storedEnabled=%q 应 fail-open 为 true，实际 %q", stored, enabled)
		}
	}
	for _, stored := range []string{"false", "FALSE", " False ", "\tfalse\n"} {
		if _, enabled := ResolveEmojiConfig("", "", stored); enabled != "false" {
			t.Errorf("storedEnabled=%q 应判为关闭，实际 %q", stored, enabled)
		}
	}
	// 关闭时地址照常下发，而不是被清空
	if urls, enabled := ResolveEmojiConfig("", "https://a.com/owo.json", "false"); len(urls) != 1 ||
		urls[0] != "https://a.com/owo.json" || enabled != "false" {
		t.Errorf("关闭时地址应照常下发，实际 (%v, %q)", urls, enabled)
	}
	// 归一化是幂等的
	for _, stored := range []string{"", " ", "true", "false", "FALSE", "yes"} {
		_, first := ResolveEmojiConfig("", "", stored)
		_, second := ResolveEmojiConfig("", "", first)
		if first != second {
			t.Errorf("storedEnabled=%q 归一化不幂等：%q != %q", stored, first, second)
		}
	}
}

// vectorLabel 生成不会因为过长 / 含引号而难以阅读的子用例名
func vectorLabel(value string) string {
	label := value
	if len(label) > 40 {
		label = label[:40]
	}
	return strings.NewReplacer("\n", `\n`, "\t", `\t`).Replace(label)
}
