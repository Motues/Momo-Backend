package utils

import (
	"strings"
	"testing"
)

func TestParseMarkdown(t *testing.T) {
	for _, tc := range []struct {
		name        string
		input       string
		mustContain []string
		mustNotHave []string
	}{
		{"空输入返回空串", "", nil, nil},
		{"加粗", "**bold**", []string{"<strong>bold</strong>"}, nil},
		{"斜体", "*it*", []string{"<em>it</em>"}, nil},
		{"一级标题", "# Title", []string{"<h1>Title</h1>"}, nil},
		{"三级标题", "### 小标题", []string{"<h3>小标题</h3>"}, nil},
		{"无序列表", "- a\n- b", []string{"<ul>", "<li>a</li>", "<li>b</li>"}, nil},
		{"有序列表", "1. a\n2. b", []string{"<ol>", "<li>a</li>"}, nil},
		{"行内代码", "`code`", []string{"<code>code</code>"}, nil},
		{"代码块", "```\nx\n```", []string{"<pre>"}, nil},
		{"引用", "> quote", []string{"<blockquote>"}, nil},
		{"链接", "[x](https://a.com)", []string{`href="https://a.com"`}, nil},
		{"图片", "![alt](https://a.com/i.png)", []string{"<img", `src="https://a.com/i.png"`, `alt="alt"`}, nil},
		{"裸链接自动识别", "https://a.com", []string{`href="https://a.com"`}, nil},
		{"换行分段", "a\n\nb", []string{"<p>a</p>", "<p>b</p>"}, nil},
		{"水平线", "---", []string{"<hr"}, nil},
		{"纯文本被包裹为段落", "just text", []string{"<p>just text</p>"}, nil},
		{"中文内容", "**微博**", []string{"<strong>微博</strong>"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseMarkdown(tc.input)
			for _, want := range tc.mustContain {
				if !strings.Contains(got, want) {
					t.Errorf("ParseMarkdown(%q) 结果应包含 %q，实际 %q", tc.input, want, got)
				}
			}
			for _, bad := range tc.mustNotHave {
				if strings.Contains(got, bad) {
					t.Errorf("ParseMarkdown(%q) 结果不应包含 %q，实际 %q", tc.input, bad, got)
				}
			}
		})
	}
}

// TestParseMarkdownSanitizesXSS 确认 Markdown 渲染后的 HTML 会被 bluemonday 净化
func TestParseMarkdownSanitizesXSS(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
	}{
		{"script 标签", `<script>alert(1)</script>`},
		{"script 与正文混合", `hello <script>alert(document.cookie)</script> world`},
		{"img onerror", `<img src=x onerror="alert(1)">`},
		{"javascript 链接", `[click](javascript:alert(1))`},
		{"iframe", `<iframe src="//evil.com"></iframe>`},
		{"svg onload", `<svg onload="alert(1)"></svg>`},
		{"style 注入", `<style>body{display:none}</style>text`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseMarkdown(tc.input)
			lower := strings.ToLower(got)
			for _, bad := range []string{"<script", "onerror=", "onload=", "javascript:", "<iframe", "<style"} {
				if strings.Contains(lower, bad) {
					t.Errorf("ParseMarkdown(%q) 输出残留 %q: %q", tc.input, bad, got)
				}
			}
		})
	}
}

// TestParseMarkdownKeepsLiteralAngleBrackets 记录行为：
// 纯文本里的尖括号内容会按 Markdown/HTML 语义处理，而不是被当作纯文本保留。
func TestParseMarkdownKeepsLiteralAngleBrackets(t *testing.T) {
	got := ParseMarkdown("我写 <script> 会怎样")
	lower := strings.ToLower(got)
	if strings.Contains(lower, "<script") {
		t.Errorf("尖括号内容被渲染为 script 标签，说明净化失效: %q", got)
	}
	if !strings.Contains(got, "我写") {
		t.Errorf("普通文本部分应保留，实际 %q", got)
	}
}
