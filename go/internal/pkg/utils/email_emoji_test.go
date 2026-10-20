package utils

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

/*
邮件短代码水合（doc/mail.md 第 4 节）的验收。

覆盖：短代码推导与前端逐字一致、拉取/合并/去重、文本节点范围与边界规则、
图片地址白名单，以及各种失败都降级为纯文本（短代码原样保留、邮件照常发出）。
*/

// testOwoPackJSON 一份与默认源同构的 owo.json
const testOwoPackJSON = `{
  "颜文字": {
    "type": "emoticon",
    "container": [{"icon": "OωO", "text": "Author: DIYgod"}]
  },
  "Bilibili": {
    "type": "image",
    "container": [
      {"icon": "<img src=\"https://cdn.example.com/bilibili/doge.png\">", "text": "doge"},
      {"icon": "<img src=\"https://cdn.example.com/bilibili/sob.png\">", "text": "sob"}
    ]
  }
}`

// newOwoServer 起一个返回固定内容的来源，并统计请求次数
func newOwoServer(t *testing.T, status int, body string) (*httptest.Server, *int64) {
	t.Helper()
	var hits int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

// ---------------------------------------------------------------------------
// 短代码推导（与前端同一函数）
// ---------------------------------------------------------------------------

func TestEmojiShortcodeDerivation(t *testing.T) {
	const bilibiliSrc = "https://open.motues.top/static/emoji/bilibili/3dea3d8c3ebf19f4734afbe32c62f4a158cd3ebd.png"

	for _, testCase := range []struct {
		name string
		text string
		src  string
		want string
	}{
		{"小写字母数字直接使用", "doge", "https://x/ignored.png", "doge"},
		{"下划线归一为连字符", "tv_doge", "https://x/ignored.png", "tv-doge"},
		{"大写先小写化", "TV_DOGE", "https://x/ignored.png", "tv-doge"},
		{"首尾分隔符被去掉", "-doge-", "https://x/ignored.png", "doge"},
		{"连续分隔符压缩", "a  b", "https://x/ignored.png", "a-b"},
		{"无法归一化时用 FNV-1a（doc 示例）", "", bilibiliSrc, "e-3fb127fe"},
		{"中文无法归一化时用哈希", "你好", "https://example.com/a.png", "e-0b813296"},
		// 与前端 normalizeShortcode 一致：归一化后先截断到 32 个码点，再判形状
		{"超过 32 个码点先截断再判形状", strings.Repeat("a", 33), "https://example.com/a.png", strings.Repeat("a", 32)},
		{"全是分隔符时无法归一化", "!!!", "https://example.com/a.png", "e-0b813296"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := EmojiShortcodeFor(testCase.text, testCase.src); got != testCase.want {
				t.Errorf("EmojiShortcodeFor(%q, %q) 期望 %q，实际 %q",
					testCase.text, testCase.src, testCase.want, got)
			}
		})
	}

	// 纯归一化路径（不涉及哈希）
	if got := EmojiShortcodeFromText("doge"); got != "doge" {
		t.Errorf("EmojiShortcodeFromText 期望 doge，实际 %q", got)
	}
	if got := EmojiShortcodeFromText("你好"); got != "" {
		t.Errorf("无法归一化时应返回空串，实际 %q", got)
	}
}

func TestIsSafeEmojiImageURL(t *testing.T) {
	for _, testCase := range []struct {
		url  string
		want bool
	}{
		{"https://cdn.example.com/a.png", true},
		// 小写协议才放行（与前端 / Node / Worker 的 REMOTE_ICON_RE 一致）
		{"HTTPS://cdn.example.com/a.png", false},
		{"data:image/png;base64,AAAA", true},
		{"data:image/jpeg;base64,AAAA", true},
		{"data:image/gif;base64,AAAA", true},
		{"data:image/webp;base64,AAAA", true},
		{"data:image/png;base64,AA+/==", true},
		{"", false},
		{"   ", false},
		{"http://cdn.example.com/a.png", false},
		{"//cdn.example.com/a.png", false},
		{"javascript:alert(1)", false},
		{"data:image/svg+xml;base64,AAAA", false},
		{"data:text/html;base64,AAAA", false},
		{"data:image/png;base64,不是base64", false},
		{"data:image/png;base64,AAAA ", false},
		{`https://cdn.example.com/a"b.png`, false},
		{"https://cdn.example.com/a<b.png", false},
		// 超过码点上限（2048）的远程地址被丢弃
		{"https://cdn.example.com/" + strings.Repeat("a", 2100) + ".png", false},
	} {
		if got := IsSafeEmojiImageURL(testCase.url); got != testCase.want {
			t.Errorf("IsSafeEmojiImageURL(%q) 期望 %v，实际 %v", testCase.url, testCase.want, got)
		}
	}
}

// ---------------------------------------------------------------------------
// 文本节点替换范围与边界规则
// ---------------------------------------------------------------------------

func TestHydrateShortcodesTextNodesOnly(t *testing.T) {
	mapping := map[string]string{
		"doge": "https://cdn.example.com/doge.png",
		"sob":  "https://cdn.example.com/sob.png",
		"30":   "https://cdn.example.com/30.png",
	}
	image := func(name, src string) string {
		return `<img src="` + src + `" alt=":` + name + `:" title=":` + name + `:" style="max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;">`
	}

	for _, testCase := range []struct {
		name string
		in   string
		want string
	}{
		{"普通文本节点被替换", "<p>:doge:</p>", "<p>" + image("doge", mapping["doge"]) + "</p>"},
		{"同一文本节点多处替换", "<p>:doge: 和 :sob:</p>", "<p>" + image("doge", mapping["doge"]) + " 和 " + image("sob", mapping["sob"]) + "</p>"},
		{"code 内不替换", "<code>:doge:</code>", "<code>:doge:</code>"},
		{"pre 内不替换（含嵌套 code）", "<pre><code>:doge:</code></pre>", "<pre><code>:doge:</code></pre>"},
		{"script 内不替换", "<script>:doge:</script>", "<script>:doge:</script>"},
		{"style 内不替换", "<style>:doge:</style>", "<style>:doge:</style>"},
		{"textarea 内不替换", "<textarea>:doge:</textarea>", "<textarea>:doge:</textarea>"},
		{"闭合后恢复替换", "<code>:doge:</code>:doge:", "<code>:doge:</code>" + image("doge", mapping["doge"])},
		{"标签属性不替换", `<a href=":doge:" title=":sob:">:doge:</a>`, `<a href=":doge:" title=":sob:">` + image("doge", mapping["doge"]) + "</a>"},
		{"注释不替换", "<!-- :doge: -->:doge:", "<!-- :doge: -->" + image("doge", mapping["doge"])},
		{"未命中短代码保持原样", "<p>:nope:</p>", "<p>:nope:</p>"},
		{"前面是数字不替换", "<p>12:30:45</p>", "<p>12:30:45</p>"},
		{"后面紧跟数字不替换", "<p>:doge:1</p>", "<p>:doge:1</p>"},
		{"后面紧跟字母仍替换", "<p>:doge:abc</p>", "<p>" + image("doge", mapping["doge"]) + "abc</p>"},
		{"前面是非 ASCII 字母仍替换", "<p>好:doge:</p>", "<p>好" + image("doge", mapping["doge"]) + "</p>"},
		{"前面是标点仍替换", "<p>(:doge:)</p>", "<p>(" + image("doge", mapping["doge"]) + ")</p>"},
		{"没有冒号时原样返回", "<p>plain text</p>", "<p>plain text</p>"},
		{"空串", "", ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := hydrateShortcodes(testCase.in, mapping); got != testCase.want {
				t.Errorf("输入 %q\n期望 %q\n实际 %q", testCase.in, testCase.want, got)
			}
		})
	}

	// 空映射：一个字符都不改
	if got := hydrateShortcodes("<p>:doge:</p>", map[string]string{}); got != "<p>:doge:</p>" {
		t.Errorf("空映射不应改写内容，实际 %q", got)
	}
}

// ---------------------------------------------------------------------------
// 拉取、合并与缓存（本地 httptest 来源）
// ---------------------------------------------------------------------------

func TestBuildEmailEmojiMapMultiSource(t *testing.T) {
	resetEmailEmojiCache()

	first, _ := newOwoServer(t, http.StatusOK, `{
	  "A": {"type": "image", "container": [
	    {"icon": "<img src=\"https://a.example.com/doge.png\">", "text": "doge"},
	    {"icon": "<img src=\"ftp://a.example.com/bad.png\">", "text": "bad"}
	  ]},
	  "Text": {"type": "emoticon", "container": [{"icon": "OωO", "text": "OωO"}]}
	}`)
	second, _ := newOwoServer(t, http.StatusOK, `{
	  "A": {"type": "image", "container": [
	    {"icon": "<img src=\"https://b.example.com/doge.png\">", "text": "doge"}
	  ]},
	  "B": {"type": "image", "container": [
	    {"icon": "<img src=\"https://b.example.com/doge.png\">", "text": "doge"},
	    {"icon": "<img src=\"data:image/gif;base64,R0lGOD\">", "text": "gif!"}
	  ]}
	}`)

	mapping := BuildEmailEmojiMap([]string{first.URL, second.URL})

	if got := mapping["doge"]; got != "https://a.example.com/doge.png" {
		t.Errorf("跨包重名应由靠前的包先占名，实际 %q", got)
	}
	if got := mapping["doge-2"]; got != "https://b.example.com/doge.png" {
		t.Errorf("跨包重名应追加 -2，实际 %q", got)
	}
	// 同一个包内两次出现同一名字同样追加后缀
	if got := mapping["doge-3"]; got != "https://b.example.com/doge.png" {
		t.Errorf("同包重名应继续追加 -3，实际 %q", got)
	}
	if got := mapping["gif"]; got != "data:image/gif;base64,R0lGOD" {
		t.Errorf("data:image/gif 应被接受，实际 %q", got)
	}
	// emoticon 是文本，不参与水合；非 https 的图片地址被丢弃
	if _, ok := mapping["o-o"]; ok {
		t.Errorf("emoticon 项不应进入映射：%v", mapping)
	}
	if _, ok := mapping["bad"]; ok {
		t.Errorf("非 https 的图片地址应被丢弃：%v", mapping)
	}
}

// TestBuildEmailEmojiMapMergesTabsBeforeNaming 先按标签合并、再统一推导短代码。
//
// 逐包推导会得到不同的后缀分配：同一个标签被后面的来源追加时，追加进来的项应当**紧跟**
// 这个标签原有的项，而不是排在后面所有标签之后（前端 / Node / Worker 都是先合并）。
func TestBuildEmailEmojiMapMergesTabsBeforeNaming(t *testing.T) {
	resetEmailEmojiCache()

	first, _ := newOwoServer(t, http.StatusOK, `{
	  "A": {"type": "image", "container": [{"icon": "<img src=\"https://a.example.com/1.png\">", "text": "doge"}]},
	  "B": {"type": "image", "container": [{"icon": "<img src=\"https://a.example.com/b.png\">", "text": "doge"}]}
	}`)
	second, _ := newOwoServer(t, http.StatusOK, `{
	  "A": {"type": "image", "container": [{"icon": "<img src=\"https://b.example.com/a.png\">", "text": "doge"}]}
	}`)

	mapping := BuildEmailEmojiMap([]string{first.URL, second.URL})

	if got := mapping["doge"]; got != "https://a.example.com/1.png" {
		t.Errorf("A 标签的第一个项应占 doge，实际 %q", got)
	}
	if got := mapping["doge-2"]; got != "https://b.example.com/a.png" {
		t.Errorf("A 标签里被追加进来的项应接着占 doge-2，实际 %q", got)
	}
	if got := mapping["doge-3"]; got != "https://a.example.com/b.png" {
		t.Errorf("后面的标签 B 应排到最后占 doge-3，实际 %q", got)
	}
}

// TestBuildEmailEmojiMapToleratesPartialPacks 单个标签 / 单个项畸形时只丢它们自己，
// 不让整份 owo.json 失效（与 Node / Worker 的 mergeOwoPacks 一致）
func TestBuildEmailEmojiMapToleratesPartialPacks(t *testing.T) {
	resetEmailEmojiCache()

	server, _ := newOwoServer(t, http.StatusOK, `{
	  "Bad": "not an object",
	  "Good": {"type": "image", "container": [
	    "not an object",
	    {"icon": "<img src=\"https://a.example.com/a.png\">", "text": "doge"},
	    {"icon": 123, "text": 456}
	  ]},
	  "NoContainer": {"type": "image"}
	}`)

	mapping := BuildEmailEmojiMap([]string{server.URL})

	if got := mapping["doge"]; got != "https://a.example.com/a.png" {
		t.Errorf("畸形标签不应影响同一份 owo.json 里的合法项，实际 %q", got)
	}
	// icon 是数字时按 JS 的 String(123) = "123" 处理 —— 不是 <img src="…">，丢弃
	if len(mapping) != 1 {
		t.Errorf("期望只有 1 个可水合项，实际 %v", mapping)
	}
}

// TestBuildEmailEmojiMapTabTypeAndEnabled 标签类型只认精确的 emoji / emoticon（大小写敏感），
// enabled = false 的标签整体跳过（与前端 / Node 一致）
func TestBuildEmailEmojiMapTabTypeAndEnabled(t *testing.T) {
	resetEmailEmojiCache()

	server, _ := newOwoServer(t, http.StatusOK, `{
	  "LowerEmoji": {"type": "emoji", "container": [{"icon": "<img src=\"https://a.example.com/1.png\">", "text": "one"}]},
	  "Text": {"type": "emoticon", "container": [{"icon": "<img src=\"https://a.example.com/2.png\">", "text": "two"}]},
	  "Off": {"type": "image", "enabled": false, "container": [{"icon": "<img src=\"https://a.example.com/3.png\">", "text": "three"}]},
	  "Image": {"container": [{"icon": "<img src=\"https://a.example.com/4.png\">", "text": "four"}]},
	  "Weird": {"type": "Emoji", "container": [{"icon": "<img src=\"https://a.example.com/5.png\">", "text": "five"}]},
	  "NoType": {"type": 7, "container": [{"icon": "<img src=\"https://a.example.com/6.png\">", "text": "six"}]}
	}`)

	mapping := BuildEmailEmojiMap([]string{server.URL})

	for _, name := range []string{"one", "two", "three"} {
		if _, ok := mapping[name]; ok {
			t.Errorf("文本标签 / 已关闭标签不应水合 %q：%v", name, mapping)
		}
	}
	// 缺省 type、非字符串 type、以及大小写不匹配的 "Emoji" 都按 image 处理
	for name, want := range map[string]string{
		"four": "https://a.example.com/4.png",
		"five": "https://a.example.com/5.png",
		"six":  "https://a.example.com/6.png",
	} {
		if got := mapping[name]; got != want {
			t.Errorf("%q 期望 %q，实际 %q（映射 %v）", name, want, got, mapping)
		}
	}
}

// TestEmojiImageSrcIsStrict icon 必须是严格的 <img src="…">（与前端 IMG_TAG_RE 一致）
func TestEmojiImageSrcIsStrict(t *testing.T) {
	for _, testCase := range []struct {
		icon string
		want string
	}{
		{`<img src="https://a.example.com/a.png">`, "https://a.example.com/a.png"},
		{`<img src="https://a.example.com/a.png"/>`, "https://a.example.com/a.png"},
		{`<img  src="https://a.example.com/a.png" >`, "https://a.example.com/a.png"},
		{`<div><img src="https://a.example.com/a.png"></div>`, ""},
		{`<img src='https://a.example.com/a.png'>`, ""},
		{`<img class="x" src="https://a.example.com/a.png">`, ""},
		{`<img src="https://a.example.com/a.png" alt="x">`, ""},
		{`<IMG SRC="https://a.example.com/a.png">`, ""},
		{"", ""},
	} {
		if got := emojiImageSrc(testCase.icon); got != testCase.want {
			t.Errorf("emojiImageSrc(%q) 期望 %q，实际 %q", testCase.icon, testCase.want, got)
		}
	}
}

func TestHydrateEmailEmojiEndToEnd(t *testing.T) {
	resetSettings(t)
	resetEmailEmojiCache()

	server, hits := newOwoServer(t, http.StatusOK, testOwoPackJSON)
	setSetting(t, EmojiCdnURLsKey, `["`+server.URL+`/owo.json"]`)
	setSetting(t, EmojiEnabledKey, "true")

	got := HydrateEmailEmoji(`<p>hi :doge: and <code>:doge:</code></p>`)
	if !strings.Contains(got, `src="https://cdn.example.com/bilibili/doge.png"`) {
		t.Errorf("短代码应被水合成内联小图，实际 %q", got)
	}
	if !strings.Contains(got, `alt=":doge:"`) || !strings.Contains(got, `title=":doge:"`) ||
		!strings.Contains(got, `style="max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;"`) {
		t.Errorf("注入的 <img> 属性口径不符：%q", got)
	}
	if !strings.Contains(got, "<code>:doge:</code>") {
		t.Errorf("code 内不应被替换：%q", got)
	}

	// 第二次读进程内缓存：不得再次请求来源
	before := atomic.LoadInt64(hits)
	if again := HydrateEmailEmoji(`<p>:sob:</p>`); !strings.Contains(again, `src="https://cdn.example.com/bilibili/sob.png"`) {
		t.Errorf("缓存命中时也应正常水合，实际 %q", again)
	}
	if after := atomic.LoadInt64(hits); after != before {
		t.Errorf("10 分钟缓存内不应重复拉取，请求数 %d -> %d", before, after)
	}
}

func TestHydrateEmailEmojiSkippedWhenDisabled(t *testing.T) {
	resetSettings(t)
	resetEmailEmojiCache()

	server, hits := newOwoServer(t, http.StatusOK, testOwoPackJSON)
	setSetting(t, EmojiCdnURLsKey, `["`+server.URL+`/owo.json"]`)
	setSetting(t, EmojiEnabledKey, "false")

	if got := HydrateEmailEmoji(`<p>:doge:</p>`); got != `<p>:doge:</p>` {
		t.Errorf("关闭表情时不应水合，实际 %q", got)
	}
	if n := atomic.LoadInt64(hits); n != 0 {
		t.Errorf("关闭表情时不应发起任何请求，实际 %d 次", n)
	}
}

func TestHydrateEmailEmojiDegradesToPlainText(t *testing.T) {
	const input = `<p>hi :doge:</p>`

	for _, testCase := range []struct {
		name   string
		status int
		body   string
	}{
		{"来源返回 500", http.StatusInternalServerError, testOwoPackJSON},
		{"来源不是 JSON", http.StatusOK, "not json"},
		{"顶层不是对象", http.StatusOK, `["a"]`},
		{"标签值不是对象", http.StatusOK, `{"A": "nope"}`},
		{"响应体超过 1 MiB", http.StatusOK, `{"A": {"type": "image", "container": [{"icon": "<img src=\"https://x/a.png\">", "text": "` + strings.Repeat("a", 2<<20) + `"}]}}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			resetSettings(t)
			resetEmailEmojiCache()

			server, _ := newOwoServer(t, testCase.status, testCase.body)
			setSetting(t, EmojiCdnURLsKey, `["`+server.URL+`/owo.json"]`)
			setSetting(t, EmojiEnabledKey, "true")

			if got := HydrateEmailEmoji(input); got != input {
				t.Errorf("失败时应降级为纯文本（短代码原样保留），实际 %q", got)
			}
		})
	}

	t.Run("一个来源失败不影响另一个", func(t *testing.T) {
		resetSettings(t)
		resetEmailEmojiCache()

		broken, _ := newOwoServer(t, http.StatusNotFound, "nope")
		good, _ := newOwoServer(t, http.StatusOK, testOwoPackJSON)
		setSetting(t, EmojiCdnURLsKey, `["`+broken.URL+`/owo.json","`+good.URL+`/owo.json"]`)
		setSetting(t, EmojiEnabledKey, "true")

		got := HydrateEmailEmoji(input)
		if !strings.Contains(got, `src="https://cdn.example.com/bilibili/doge.png"`) {
			t.Errorf("可用来源仍应生效，实际 %q", got)
		}
	})
}

// TestBuildEmailEmojiMapUsesOldKeyFallback 旧键 emoji_cdn_url 仍可作为来源回落
func TestBuildEmailEmojiMapUsesOldKeyFallback(t *testing.T) {
	resetSettings(t)
	resetEmailEmojiCache()

	server, _ := newOwoServer(t, http.StatusOK, testOwoPackJSON)
	setSetting(t, EmojiCdnURLKey, server.URL+"/owo.json")
	setSetting(t, EmojiEnabledKey, "true")

	urls, enabled := ResolveEmojiConfig(
		GetSetting(EmojiCdnURLsKey), GetSetting(EmojiCdnURLKey), GetSetting(EmojiEnabledKey))
	if len(urls) != 1 || urls[0] != server.URL+"/owo.json" {
		t.Fatalf("旧键应作为回落来源，实际 %v", urls)
	}
	if enabled != "true" {
		t.Fatalf("开关应为 true，实际 %q", enabled)
	}

	got := HydrateEmailEmoji(`<p>:doge:</p>`)
	if !strings.Contains(got, `src="https://cdn.example.com/bilibili/doge.png"`) {
		t.Errorf("旧键来源应照常水合，实际 %q", got)
	}
}
