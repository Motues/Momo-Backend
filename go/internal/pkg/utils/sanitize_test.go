package utils

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// CheckContent：纯文本字段的 XSS 清洗
// ---------------------------------------------------------------------------

func TestCheckContentRemovesDangerousMarkup(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  string
	}{
		{"script 标签被整体移除", `<script>alert(1)</script>hello`, "hello"},
		{"大写 SCRIPT 被移除", `<SCRIPT>alert(1)</SCRIPT>hello`, "hello"},
		{"大小写混合的 script 被移除", `<ScRiPt src="x.js"></sCrIpT>ok`, "ok"},
		{"带属性的 script 被移除", `<script type="text/javascript" src="//evil.com/x.js"></script>ok`, "ok"},
		{"style 标签被移除", `<style>body{display:none}</style>ok`, "ok"},
		{"多行 script 被移除", "<script>\nvar a = 1;\n</script>\nafter", "\nafter"},
		{"onerror 双引号属性被移除", `<img src=x onerror="alert(1)">`, `<img src=x>`},
		{"onerror 单引号属性被移除", `<img src=x onerror='alert(1)'>`, `<img src=x>`},
		{"onerror 无引号属性被移除", `<img src=x onerror=alert(1)>`, `<img src=x>`},
		{"onclick 被移除", `<a onclick="doIt()">点我</a>`, `<a>点我</a>`},
		{"onmouseover 被移除", `<div onmouseover=alert(1)>x</div>`, `<div>x</div>`},
		{"多个事件属性被移除", `<img src=x onerror=a onclick=b onload=c>`, `<img src=x>`},
		{"大写事件属性被移除", `<IMG SRC=x ONERROR=alert(1)>`, `<IMG SRC=x>`},
		{"iframe 被移除", `<iframe src="//evil.com"></iframe>ok`, "ok"},
		{"object/embed 被移除", `<object data=x></object><embed src=x>ok`, "ok"},
		{"form/input 被移除", `<form action=x><input name=y></form>tail`, "tail"},
		{"meta/link/base 被移除", `<meta http-equiv=refresh content=0><link rel=x><base href=x>tail`, "tail"},
		{"自闭合的危险标签被移除", `<iframe src=x/>ok`, "ok"},
		{"脚本前后都保留文本", `前<script>x</script>后`, "前后"},
		{"嵌套变形后不残留可用 script 标签", `<scr<script>ipt>alert(1)</script>`, "<scr"},
		{"空串", "", ""},
		{"纯文本原样返回", "普通文本 <b>加粗</b> & 符号", "普通文本 <b>加粗</b> & 符号"},
		{"良性标签保留", `<b>bold</b><i>it</i><em>e</em>`, `<b>bold</b><i>it</i><em>e</em>`},
		{"HTML 实体原样保留（不由本函数转义）", `&lt;script&gt;`, `&lt;script&gt;`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := CheckContent(tc.input)
			if got != tc.want {
				t.Errorf("CheckContent(%q) 期望 %q，实际 %q", tc.input, tc.want, got)
			}
			lower := strings.ToLower(got)
			if strings.Contains(lower, "<script") || strings.Contains(lower, "</script") {
				t.Errorf("清洗结果不应残留 script 标签: %q", got)
			}
			if strings.Contains(lower, "onerror=") || strings.Contains(lower, "onclick=") {
				t.Errorf("清洗结果不应残留事件属性: %q", got)
			}
		})
	}
}

// TestCheckContentNestedObfuscation 覆盖常见的嵌套/混淆写法：
// 只要求“不残留可执行的 script 标签或事件属性”，不锁定具体输出文本。
func TestCheckContentNestedObfuscation(t *testing.T) {
	payloads := []string{
		`<script<script>>alert(1)</script>`,
		`<img src=x onerror
			=alert(1)>`,
		`<div ONMOUSEOVER = "alert(1)">x</div>`,
		`<iframe src="javascript:alert(1)"></iframe>`,
		`<form><button formaction="javascript:alert(1)">x</button></form>`,
		`<svg><script>alert(1)</script></svg>`,
		`<style>@import 'evil.css';</style>x`,
	}
	for _, payload := range payloads {
		got := CheckContent(payload)
		lower := strings.ToLower(got)
		if strings.Contains(lower, "<script") && strings.Contains(lower, "</script") {
			t.Errorf("载荷 %q 清洗后仍残留成对 script 标签: %q", payload, got)
		}
		for _, event := range []string{"onerror=", "onclick=", "onmouseover="} {
			if strings.Contains(lower, event) {
				t.Errorf("载荷 %q 清洗后仍残留事件属性 %s: %q", payload, event, got)
			}
		}
		if strings.Contains(lower, "<iframe") || strings.Contains(lower, "<object") || strings.Contains(lower, "<embed") {
			t.Errorf("载荷 %q 清洗后仍残留危险标签: %q", payload, got)
		}
	}
}

// TestCheckContentUnclosedScriptTagIsKept 记录当前行为：
// CheckContent 使用「成对标签」正则，未闭合的 <script> 不会被移除。
// 因此 content 字段的最终安全依赖 Markdown 渲染后的 bluemonday 净化
// （见 TestParseMarkdownSanitizesXSS），纯文本列则由前端按文本渲染。
func TestCheckContentUnclosedScriptTagIsKept(t *testing.T) {
	inputs := []string{
		`<script>alert(1)`,
		`<style>body{}`,
		`<img src=x onerror`,
	}
	for _, input := range inputs {
		if got := CheckContent(input); got != input {
			t.Errorf("未闭合标签的输入 %q 当前应原样返回，实际 %q", input, got)
		}
		// 但 Markdown 渲染路径必须净化掉
		if rendered := ParseMarkdown(input); strings.Contains(strings.ToLower(rendered), "<script") {
			t.Errorf("Markdown 渲染路径不应残留 script 标签: %q", rendered)
		}
	}
}

// ---------------------------------------------------------------------------
// SanitizeUrl：协议白名单
// ---------------------------------------------------------------------------

func TestSanitizeUrl(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  string
	}{
		{"空串", "", ""},
		{"纯空白", "   ", ""},
		{"普通 https", "https://example.com/a?b=1", "https://example.com/a?b=1"},
		{"普通 http", "http://example.com", "http://example.com"},
		{"大写协议", "HTTPS://EXAMPLE.COM", "HTTPS://EXAMPLE.COM"},
		{"mailto", "mailto:a@b.com", "mailto:a@b.com"},
		{"相对路径", "/posts/1", "/posts/1"},
		{"相对路径（无前导斜杠）", "posts/1", "posts/1"},
		{"协议相对地址", "//evil.com/x", "//evil.com/x"},
		{"javascript 协议被拒绝", "javascript:alert(1)", ""},
		{"JAVASCRIPT 大写被拒绝", "JAVASCRIPT:alert(1)", ""},
		{"vbscript 被拒绝", "vbscript:msgbox(1)", ""},
		{"data URI 被拒绝", "data:text/html;base64,PHNjcmlwdD4=", ""},
		{"file 协议被拒绝", "file:///etc/passwd", ""},
		{"未知协议被拒绝", "ftp://example.com/x", ""},
		{"内嵌制表符的 javascript 被拒绝（浏览器会剥离控制字符）", "\tjava\tscript:alert(1)", ""},
		{"内嵌换行的 javascript 被拒绝", "java\nscript:alert(1)", ""},
		{"内嵌回车的 javascript 被拒绝", "java\rscript:alert(1)", ""},
		{"前导空格的 javascript 被拒绝", "   javascript:alert(1)", ""},
		{"前导空格 + http 保留（去掉首尾空格）", "  https://a.com  ", "https://a.com"},
		{"查询串中的冒号不误判", "?q=1:2", "?q=1:2"},
		{"数字开头的伪协议按相对路径处理", "1abc:def", "1abc:def"},
		{"冒号在路径中", "/a/b:c", "/a/b:c"},
		{"仅一个冒号", ":", ":"},
		{"锚点", "#frag", "#frag"},
		{"包含中文的相对路径", "/文章/1", "/文章/1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := SanitizeUrl(tc.input); got != tc.want {
				t.Errorf("SanitizeUrl(%q) 期望 %q，实际 %q", tc.input, tc.want, got)
			}
		})
	}
}

func TestSanitizeUrlNeverReturnsDangerousScheme(t *testing.T) {
	dangerous := []string{
		"javascript:alert(1)",
		"  javascript:alert(1)",
		"javaS\ncript:alert(1)",
		"\tjavascript:alert(1)",
		"vbscript:x",
		"data:text/html,<script>alert(1)</script>",
		"blob:https://x/y",
	}
	for _, raw := range dangerous {
		got := SanitizeUrl(raw)
		lower := strings.ToLower(strings.ReplaceAll(got, " ", ""))
		for _, scheme := range []string{"javascript:", "vbscript:", "data:", "blob:"} {
			if strings.Contains(lower, scheme) {
				t.Errorf("SanitizeUrl(%q) 返回了危险地址 %q", raw, got)
			}
		}
		if got != "" {
			t.Errorf("SanitizeUrl(%q) 应返回空串，实际 %q", raw, got)
		}
	}
}

// ---------------------------------------------------------------------------
// SanitizeHtml：已渲染 HTML 的净化
// ---------------------------------------------------------------------------

func TestSanitizeHtml(t *testing.T) {
	for _, tc := range []struct {
		name        string
		input       string
		mustContain []string
		mustNotHave []string
	}{
		{
			"保留段落与加粗",
			`<p>hello <strong>world</strong></p>`,
			[]string{"<p>", "<strong>world</strong>"},
			nil,
		},
		{
			"移除 script 标签与内容",
			`<p>x</p><script>alert(1)</script>`,
			[]string{"<p>x</p>"},
			[]string{"<script", "alert(1)"},
		},
		{
			"移除事件属性",
			`<img src="https://a.com/i.png" alt="a" onerror="alert(1)">`,
			[]string{"<img", `src="https://a.com/i.png"`},
			[]string{"onerror"},
		},
		{
			"移除 javascript: 链接地址",
			`<a href="javascript:alert(1)">click</a>`,
			[]string{"click"},
			[]string{"javascript:", "href"},
		},
		{
			"保留 http 链接",
			`<a href="https://a.com" rel="nofollow">x</a>`,
			[]string{`href="https://a.com"`},
			nil,
		},
		{
			"移除 iframe",
			`<iframe src="//evil.com"></iframe>ok`,
			[]string{"ok"},
			[]string{"iframe"},
		},
		{
			"移除注释",
			`<p>a</p><!-- secret -->`,
			[]string{"<p>a</p>"},
			[]string{"secret"},
		},
		{
			"移除 style 标签",
			`<style>body{background:url(javascript:1)}</style><p>ok</p>`,
			[]string{"<p>ok</p>"},
			[]string{"<style", "javascript:"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := SanitizeHtml(tc.input)
			for _, want := range tc.mustContain {
				if !strings.Contains(got, want) {
					t.Errorf("净化结果应包含 %q，实际 %q", want, got)
				}
			}
			lower := strings.ToLower(got)
			for _, bad := range tc.mustNotHave {
				if strings.Contains(lower, strings.ToLower(bad)) {
					t.Errorf("净化结果不应包含 %q，实际 %q", bad, got)
				}
			}
		})
	}

	if got := SanitizeHtml(""); got != "" {
		t.Errorf("空输入应返回空串，实际 %q", got)
	}
}

// ---------------------------------------------------------------------------
// HtmlEscape：邮件模板注入防护
// ---------------------------------------------------------------------------

func TestHtmlEscape(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  string
	}{
		{"空串", "", ""},
		{"纯文本不变", "hello 世界", "hello 世界"},
		{"五个特殊字符全部转义", `&<>"'`, "&amp;&lt;&gt;&quot;&#39;"},
		{"& 只转义一次（不会被二次转义）", "&amp;", "&amp;amp;"},
		{"标签被转义", `<script>alert(1)</script>`, "&lt;script&gt;alert(1)&lt;/script&gt;"},
		{"属性注入被转义", `" onmouseover="alert(1)`, "&quot; onmouseover=&quot;alert(1)"},
		{"混合内容", `Tom & "Jerry" <b>`, "Tom &amp; &quot;Jerry&quot; &lt;b&gt;"},
		{"单引号", "it's", "it&#39;s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := HtmlEscape(tc.input); got != tc.want {
				t.Errorf("HtmlEscape(%q) 期望 %q，实际 %q", tc.input, tc.want, got)
			}
		})
	}

	// 转义结果里不应残留可被解析为标签的原始尖括号
	escaped := HtmlEscape(`<img src=x onerror=alert(1)>`)
	if strings.Contains(escaped, "<") || strings.Contains(escaped, ">") {
		t.Errorf("转义后不应残留裸尖括号，实际 %q", escaped)
	}
}
