package utils

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

/*
「文章标识净化 + 截断」的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

post_slug 会被签进挑战载荷，三端的净化与截断口径必须完全一致，否则会出现
「同一篇文章的挑战兑换自己的票据却被拒」或「签出的票据永远兑不掉」的假失败。

处理器的 sanitizePostSlug = CheckContent + TruncateRunes，这里直接钉住这两个原语。
*/

type sanitizeVector struct {
	Name   string `json:"name"`
	Input  string `json:"input"`
	Output string `json:"output"`
}

type sanitizeFixture struct {
	MaxPostSlug      int              `json:"maxPostSlug"`
	CheckContent     []sanitizeVector `json:"checkContent"`
	SanitizePostSlug []sanitizeVector `json:"sanitizePostSlug"`
}

func loadSanitizeFixture(t *testing.T) sanitizeFixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("sanitize-v2.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/sanitize-v2.json 失败: %v", err)
	}
	var fixture sanitizeFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/sanitize-v2.json 失败: %v", err)
	}
	return fixture
}

// TestCheckContentVectors 逐条复算内容净化口径
func TestCheckContentVectors(t *testing.T) {
	fixture := loadSanitizeFixture(t)
	if fixture.MaxPostSlug != 200 {
		t.Fatalf("fixture.maxPostSlug 期望 200，实际 %d", fixture.MaxPostSlug)
	}
	if len(fixture.CheckContent) == 0 {
		t.Fatal("fixture 里没有 checkContent 用例")
	}

	for _, tc := range fixture.CheckContent {
		t.Run(tc.Name, func(t *testing.T) {
			if got := CheckContent(tc.Input); got != tc.Output {
				t.Errorf("CheckContent 口径漂移:\n  输入=%q\n  got =%q\n  want=%q", tc.Input, got, tc.Output)
			}
		})
	}
}

// TestSanitizePostSlugVectors 逐条复算「净化 + 按码点截断」
func TestSanitizePostSlugVectors(t *testing.T) {
	fixture := loadSanitizeFixture(t)
	if len(fixture.SanitizePostSlug) == 0 {
		t.Fatal("fixture 里没有 sanitizePostSlug 用例")
	}

	for _, tc := range fixture.SanitizePostSlug {
		t.Run(tc.Name, func(t *testing.T) {
			got := TruncateRunes(CheckContent(tc.Input), fixture.MaxPostSlug)
			if got != tc.Output {
				t.Errorf("sanitizePostSlug 口径漂移:\n  输入=%q\n  got =%q (码点=%d 字节=%d)\n  want=%q (码点=%d 字节=%d)",
					tc.Input, got, utf8.RuneCountInString(got), len(got),
					tc.Output, utf8.RuneCountInString(tc.Output), len(tc.Output))
			}
			// 不变量：不超过上限码点，且是合法 UTF-8（按字节截断会切出非法尾巴）
			if n := utf8.RuneCountInString(got); n > fixture.MaxPostSlug {
				t.Errorf("结果码点数 %d 超过上限 %d", n, fixture.MaxPostSlug)
			}
			if !utf8.ValidString(got) {
				t.Errorf("结果不是合法 UTF-8: %q", got)
			}
		})
	}
}

// TestTruncateRunesBoundaries 钉住截断本身的边界语义
func TestTruncateRunesBoundaries(t *testing.T) {
	// 多字节字符不会被从中间切断
	multiByte := strings.Repeat("中", 201)
	got := TruncateRunes(multiByte, 200)
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != 200 {
		t.Errorf("按码点截断中文失败: 码点=%d 合法=%v", utf8.RuneCountInString(got), utf8.ValidString(got))
	}
	if len(got) != 600 {
		t.Errorf("200 个中文应为 600 字节，实际 %d", len(got))
	}

	// 补充平面字符（emoji）同样按码点计数
	emoji := strings.Repeat("😀", 201)
	gotEmoji := TruncateRunes(emoji, 200)
	if utf8.RuneCountInString(gotEmoji) != 200 || len(gotEmoji) != 800 {
		t.Errorf("emoji 截断结果异常: 码点=%d 字节=%d", utf8.RuneCountInString(gotEmoji), len(gotEmoji))
	}

	if TruncateRunes("abc", 0) != "" {
		t.Error("max<=0 应返回空串")
	}
	if TruncateRunes("abc", 99) != "abc" {
		t.Error("未超上限时应原样返回")
	}
}
