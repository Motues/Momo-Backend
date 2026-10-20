package utils

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

/*
表情多来源契约 v3 的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

口径见 doc/emoji.md 第 1、3 节：常量 / 写入校验（五条错误文案）/ 读取归一化（回落、容错、截断）
只要有一端漂移，这里就会立刻失败。
*/

// emojiV3Fixture doc/vectors/emoji-v3.json 的结构化视图
type emojiV3Fixture struct {
	Defaults struct {
		CdnURL  string `json:"cdnUrl"`
		Enabled string `json:"enabled"`
	} `json:"defaults"`
	Limits struct {
		MaxCdnURLLen int `json:"maxCdnUrlLen"`
		MaxCdnUrls   int `json:"maxCdnUrls"`
	} `json:"limits"`
	Errors  map[string]string `json:"errors"`
	CdnUrls struct {
		Valid []struct {
			Value  *string  `json:"value"`
			Expect []string `json:"expect"`
		} `json:"valid"`
		Invalid []struct {
			Value *string `json:"value"`
			Error string  `json:"error"`
		} `json:"invalid"`
	} `json:"cdnUrls"`
	Resolve []struct {
		Name          string   `json:"name"`
		StoredUrls    *string  `json:"storedUrls"`
		StoredCdnUrl  string   `json:"storedCdnUrl"`
		StoredEnabled string   `json:"storedEnabled"`
		ExpectUrls    []string `json:"expectUrls"`
		ExpectEnabled string   `json:"expectEnabled"`
	} `json:"resolve"`
}

func loadEmojiV3Fixture(t *testing.T) emojiV3Fixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("emoji-v3.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/emoji-v3.json 失败: %v", err)
	}
	var fixture emojiV3Fixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/emoji-v3.json 失败: %v", err)
	}
	return fixture
}

// derefString JSON null 视为「未提供」，等价于空串
func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// TestEmojiV3Constants 钉死默认源 / 默认开关 / 长度上限与地址数量上限
func TestEmojiV3Constants(t *testing.T) {
	fixture := loadEmojiV3Fixture(t)

	if DefaultEmojiCDN != fixture.Defaults.CdnURL {
		t.Errorf("DefaultEmojiCDN 期望 %q，实际 %q", fixture.Defaults.CdnURL, DefaultEmojiCDN)
	}
	if DefaultEmojiEnabled != fixture.Defaults.Enabled {
		t.Errorf("DefaultEmojiEnabled 期望 %q，实际 %q", fixture.Defaults.Enabled, DefaultEmojiEnabled)
	}
	if MaxEmojiCDNURLLength != fixture.Limits.MaxCdnURLLen {
		t.Errorf("MaxEmojiCDNURLLength 期望 %d，实际 %d", fixture.Limits.MaxCdnURLLen, MaxEmojiCDNURLLength)
	}
	if MaxEmojiCDNURLs != fixture.Limits.MaxCdnUrls {
		t.Errorf("MaxEmojiCDNURLs 期望 %d，实际 %d", fixture.Limits.MaxCdnUrls, MaxEmojiCDNURLs)
	}
	if EmojiCdnURLsKey != "emoji_cdn_urls" {
		t.Errorf("EmojiCdnURLsKey 期望 emoji_cdn_urls，实际 %q", EmojiCdnURLsKey)
	}
}

// TestEmojiCdnURLsV3Valid 写入路径：合法取值必须通过，落库值再解析回来必须等于 fixture 的 expect
func TestEmojiCdnURLsV3Valid(t *testing.T) {
	fixture := loadEmojiV3Fixture(t)
	if len(fixture.CdnUrls.Valid) == 0 {
		t.Fatal("fixture 的 cdnUrls.valid 段为空，向量没有生效")
	}

	for _, testCase := range fixture.CdnUrls.Valid {
		raw := derefString(testCase.Value)
		t.Run("valid:"+vectorLabel(raw), func(t *testing.T) {
			normalized, msg := ValidateEmojiCdnURLs(raw)
			if msg != "" {
				t.Fatalf("期望通过校验，实际被拒：%s", msg)
			}
			if got := ParseEmojiCdnURLs(normalized); !reflect.DeepEqual(got, expectSlice(testCase.Expect)) {
				t.Errorf("落库值 %q 解析回来期望 %v，实际 %v", normalized, testCase.Expect, got)
			}
			// 写入路径的归一化必须幂等：二次校验不得改写落库值
			again, msg := ValidateEmojiCdnURLs(normalized)
			if msg != "" {
				t.Fatalf("归一化后的值再次校验失败：%s", msg)
			}
			if again != normalized {
				t.Errorf("归一化不幂等：%q -> %q", normalized, again)
			}
		})
	}
}

// TestEmojiCdnURLsV3Invalid 写入路径：非法取值的错误文案必须与 fixture 逐字一致
func TestEmojiCdnURLsV3Invalid(t *testing.T) {
	fixture := loadEmojiV3Fixture(t)
	if len(fixture.CdnUrls.Invalid) == 0 {
		t.Fatal("fixture 的 cdnUrls.invalid 段为空，向量没有生效")
	}

	for _, testCase := range fixture.CdnUrls.Invalid {
		raw := derefString(testCase.Value)
		t.Run("invalid:"+vectorLabel(raw), func(t *testing.T) {
			normalized, msg := ValidateEmojiCdnURLs(raw)
			if msg == "" {
				t.Fatalf("期望被拒，实际通过校验（归一化值 %q）", normalized)
			}
			want, ok := fixture.Errors[testCase.Error]
			if !ok {
				t.Fatalf("fixture 的 errors 段缺少键 %q", testCase.Error)
			}
			if msg != want {
				t.Errorf("错误文案期望 %q，实际 %q", want, msg)
			}
		})
	}
}

// TestEmojiResolveV3Vector 读取路径：多来源 + 旧键回落 + 容错 + 截断
func TestEmojiResolveV3Vector(t *testing.T) {
	fixture := loadEmojiV3Fixture(t)
	if len(fixture.Resolve) == 0 {
		t.Fatal("fixture 的 resolve 段为空，向量没有生效")
	}

	for _, testCase := range fixture.Resolve {
		t.Run(testCase.Name, func(t *testing.T) {
			urls, enabled := ResolveEmojiConfig(
				derefString(testCase.StoredUrls), testCase.StoredCdnUrl, testCase.StoredEnabled)
			if len(urls) == 0 {
				t.Fatalf("解析结果不应为空（至少要回落默认源）")
			}
			if !reflect.DeepEqual(urls, expectSlice(testCase.ExpectUrls)) {
				t.Errorf("urls 期望 %v，实际 %v", testCase.ExpectUrls, urls)
			}
			if enabled != testCase.ExpectEnabled {
				t.Errorf("enabled 期望 %q，实际 %q", testCase.ExpectEnabled, enabled)
			}
		})
	}
}

// expectSlice 把可能为 nil 的期望值归一为空切片，便于与实现返回值直接比较
func expectSlice(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// TestEmojiCdnURLsErrorPrecedence 单条地址「同时超长且协议不合法」时的文案优先级。
//
// fixture 没有这种组合，但 Node / Worker 都是**先判长度、后判协议**（旧键 emoji_cdn_url 亦然），
// 这里把它钉住，避免三端对同一个值给出不同文案。
func TestEmojiCdnURLsErrorPrecedence(t *testing.T) {
	tooLongAndBadScheme := `["ftp://cdn.example.com/` + strings.Repeat("a", MaxEmojiCDNURLLength) + `"]`

	if _, msg := ValidateEmojiCdnURLs(tooLongAndBadScheme); msg != "emoji_cdn_urls 不能超过 500 个字符" {
		t.Errorf("同时超长与坏协议时应先报长度，实际 %q", msg)
	}

	// 旧键同一顺序
	legacy := "ftp://cdn.example.com/" + strings.Repeat("a", MaxEmojiCDNURLLength)
	if msg := ValidateEmojiCdnURL(legacy); msg != "emoji_cdn_url 不能超过 500 个字符" {
		t.Errorf("旧键同时超长与坏协议时应先报长度，实际 %q", msg)
	}
}
