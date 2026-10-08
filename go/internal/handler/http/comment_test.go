package http

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

// ---------------------------------------------------------------------------
// 响应结构（与 doc/api.md 的字段口径对齐）
// ---------------------------------------------------------------------------

type commentResp struct {
	ID          int64          `json:"id"`
	Author      string         `json:"author"`
	URL         *string        `json:"url"`
	Avatar      string         `json:"avatar"`
	ContentText string         `json:"contentText"`
	ContentHTML string         `json:"contentHtml"`
	PubDate     string         `json:"pubDate"`
	ParentID    *int64         `json:"parentId"`
	Replies     []*commentResp `json:"replies"`
	IsBlogger   bool           `json:"isBlogger"`
}

type commentsPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Comments   []*commentResp `json:"comments"`
		Pagination struct {
			Page      int   `json:"page"`
			Limit     int   `json:"limit"`
			TotalPage int64 `json:"totalPage"`
		} `json:"pagination"`
		BloggerBadgeEnabled       string `json:"blogger_badge_enabled"`
		BloggerBadgeText          string `json:"blogger_badge_text"`
		PlaceholderName           string `json:"placeholder_name"`
		PlaceholderEmail          string `json:"placeholder_email"`
		PlaceholderContent        string `json:"placeholder_content"`
		PlaceholderURL            string `json:"placeholder_url"`
		AdminCommentKeyConfigured string `json:"admin_comment_key_configured"`
		AdminEmailHash            string `json:"admin_email_hash"`
		VerifyEnabled             string `json:"verify_enabled"`
		VerifyHoneypot            string `json:"verify_honeypot"`
	} `json:"data"`
}

const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const iPhoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
const iPadUA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

// ---------------------------------------------------------------------------
// POST /api/comments —— 正常路径
// ---------------------------------------------------------------------------

func TestPostCommentHappyPath(t *testing.T) {
	resetState(t)

	ip := nextIP()
	remoteAddr := ip + ":40000"
	before := time.Now().UnixMilli()

	body := `{"post_slug":"/posts/hello","author":"张三","email":"zhangsan@example.com",` +
		`"content":"你好 **世界**","url":"https://zhangsan.example.com",` +
		`"post_title":"标题","post_url":"https://blog.example.com/posts/hello"}`
	w := call(t, "POST", "/api/comments", body, map[string]string{"User-Agent": chromeUA}, remoteAddr)

	requireStatus(t, w, 200)
	m := decodeJSON(t, w)
	if m["message"] != "Comment submitted" {
		t.Errorf("message 期望 Comment submitted，实际 %v", m["message"])
	}
	if code, _ := m["code"].(float64); int(code) != 200 {
		t.Errorf("code 期望 200，实际 %v", m["code"])
	}
	after := time.Now().UnixMilli()

	if countComments(t) != 1 {
		t.Fatalf("应写入 1 条评论，实际 %d 条", countComments(t))
	}
	got := latestComment(t)

	if got.PostSlug != "/posts/hello" {
		t.Errorf("post_slug 期望 /posts/hello，实际 %q", got.PostSlug)
	}
	if got.Author != "张三" || got.Email != "zhangsan@example.com" {
		t.Errorf("作者/邮箱不正确: %+v", got)
	}
	if got.Status != "approved" {
		t.Errorf("未配置 comment_auto_approve 时应默认通过，实际 %q", got.Status)
	}
	if got.PubDate < before || got.PubDate > after {
		t.Errorf("pub_date 应为当前毫秒时间戳（%d~%d），实际 %d", before, after, got.PubDate)
	}
	if got.PubDate < 1_000_000_000_000 {
		t.Errorf("pub_date 必须是毫秒整数，实际 %d", got.PubDate)
	}
	if got.IPAddress == nil || *got.IPAddress != ip {
		t.Errorf("ip_address 期望 %q，实际 %v", ip, got.IPAddress)
	}
	if got.Device == nil || *got.Device != "Desktop" {
		t.Errorf("device 期望 Desktop，实际 %v", got.Device)
	}
	if got.Browser == nil || !strings.HasPrefix(*got.Browser, "Chrome 120") {
		t.Errorf("browser 应解析出 Chrome 120，实际 %v", got.Browser)
	}
	if got.OS == nil || !strings.HasPrefix(*got.OS, "Windows 10") {
		t.Errorf("os 应解析出 Windows 10，实际 %v", got.OS)
	}
	if got.UserAgent == nil || *got.UserAgent != chromeUA {
		t.Errorf("user_agent 应原样保存，实际 %v", got.UserAgent)
	}
	if got.ContentText != "你好 **世界**" {
		t.Errorf("content_text 应保存（已清洗的）原始文本，实际 %q", got.ContentText)
	}
	if !strings.Contains(got.ContentHTML, "<strong>世界</strong>") {
		t.Errorf("content_html 应包含 Markdown 渲染结果，实际 %q", got.ContentHTML)
	}
	if got.URL == nil || *got.URL != "https://zhangsan.example.com" {
		t.Errorf("url 期望原值，实际 %v", got.URL)
	}
	if got.ParentID != nil {
		t.Errorf("顶层评论的 parent_id 应为 NULL，实际 %v", got.ParentID)
	}
}

func TestPostCommentDeviceParsing(t *testing.T) {
	for _, tc := range []struct {
		name       string
		userAgent  string
		wantDevice string
	}{
		{"Chrome 桌面", chromeUA, "Desktop"},
		{"iPhone 移动端", iPhoneUA, "Mobile"},
		{"iPad 平板", iPadUA, "Tablet"},
		{"空 User-Agent 视为桌面", "", "Desktop"},
		{"爬虫 UA 视为桌面", "curl/8.4.0", "Desktop"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			w := call(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"),
				map[string]string{"User-Agent": tc.userAgent}, nextRemoteAddr())
			requireStatus(t, w, 200)

			got := latestComment(t)
			if got.Device == nil || *got.Device != tc.wantDevice {
				t.Errorf("device 期望 %q，实际 %v", tc.wantDevice, got.Device)
			}
		})
	}
}

func TestPostCommentSanitizesInput(t *testing.T) {
	resetState(t)

	body := `{"post_slug":"/p","author":"<script>alert(1)</script>正常作者",` +
		`"email":"a@b.com","content":"前<script>alert(1)</script>后",` +
		`"url":"javascript:alert(1)"}`
	w := callJSON(t, "POST", "/api/comments", body)
	requireStatus(t, w, 200)

	got := latestComment(t)
	if strings.Contains(strings.ToLower(got.Author), "<script") {
		t.Errorf("author 不应保留 script 标签，实际 %q", got.Author)
	}
	if got.Author != "正常作者" {
		t.Errorf("author 期望 %q，实际 %q", "正常作者", got.Author)
	}
	if got.URL != nil {
		t.Errorf("javascript: 协议的 url 应被丢弃（NULL），实际 %v", *got.URL)
	}
	if strings.Contains(strings.ToLower(got.ContentHTML), "<script") {
		t.Errorf("content_html 不应保留 script 标签，实际 %q", got.ContentHTML)
	}
}

func TestPostCommentURLIsOptional(t *testing.T) {
	resetState(t)

	// 不传 url：应写入 NULL
	w := callJSON(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"))
	requireStatus(t, w, 200)
	got := latestComment(t)
	if got.URL != nil {
		t.Errorf("未提供 url 时应为 NULL，实际 %q", *got.URL)
	}

	// 传空 url：同样为 NULL
	w = callJSON(t, "POST", "/api/comments", `{"post_slug":"/p","author":"a","email":"a@b.com","content":"c","url":""}`)
	requireStatus(t, w, 200)
	got = latestComment(t)
	if got.URL != nil {
		t.Errorf("空 url 应写为 NULL，实际 %q", *got.URL)
	}

	// 相对路径 url 允许保留
	w = callJSON(t, "POST", "/api/comments", `{"post_slug":"/p","author":"a","email":"a@b.com","content":"c","url":"/about"}`)
	requireStatus(t, w, 200)
	got = latestComment(t)
	if got.URL == nil || *got.URL != "/about" {
		t.Errorf("相对路径 url 应被保留，实际 %v", got.URL)
	}
}

func TestPostCommentReplyKeepsParentID(t *testing.T) {
	resetState(t)

	parent := seedComment(t, &model.Comment{
		PostSlug: "/p", Author: "parent", Email: "p@x.com",
		ContentText: "parent", ContentHTML: "<p>parent</p>", Status: "approved",
	})

	body := fmt.Sprintf(`{"post_slug":"/p","author":"child","email":"c@x.com","content":"回复","parent_id":%d}`, parent.ID)
	w := callJSON(t, "POST", "/api/comments", body)
	requireStatus(t, w, 200)

	got := latestComment(t)
	if got.ParentID == nil || *got.ParentID != parent.ID {
		t.Errorf("parent_id 期望 %d，实际 %v", parent.ID, got.ParentID)
	}
}

// ---------------------------------------------------------------------------
// POST /api/comments —— 参数校验
// ---------------------------------------------------------------------------

func TestPostCommentValidationFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"空请求体", ""},
		{"非法 JSON", "{"},
		{"JSON 数组", "[]"},
		{"JSON null", "null"},
		{"缺少 post_slug", `{"author":"a","email":"a@b.com","content":"c"}`},
		{"post_slug 为空串", `{"post_slug":"","author":"a","email":"a@b.com","content":"c"}`},
		{"缺少 author", `{"post_slug":"/p","email":"a@b.com","content":"c"}`},
		{"author 为空串", `{"post_slug":"/p","author":"","email":"a@b.com","content":"c"}`},
		{"缺少 email", `{"post_slug":"/p","author":"a","content":"c"}`},
		{"email 为空串", `{"post_slug":"/p","author":"a","email":"","content":"c"}`},
		{"email 格式非法", `{"post_slug":"/p","author":"a","email":"not-an-email","content":"c"}`},
		{"email 缺少域名", `{"post_slug":"/p","author":"a","email":"a@","content":"c"}`},
		{"email 缺少本地部分", `{"post_slug":"/p","author":"a","email":"@b.com","content":"c"}`},
		{"缺少 content", `{"post_slug":"/p","author":"a","email":"a@b.com"}`},
		{"content 为空串", `{"post_slug":"/p","author":"a","email":"a@b.com","content":""}`},
		{"post_slug 类型错误", `{"post_slug":123,"author":"a","email":"a@b.com","content":"c"}`},
		{"parent_id 类型错误", `{"post_slug":"/p","author":"a","email":"a@b.com","content":"c","parent_id":"abc"}`},
		{"整体类型错误", `"just a string"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			w := callJSON(t, "POST", "/api/comments", tc.body)
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
			if countComments(t) != 0 {
				t.Errorf("校验失败时不应写入数据库，实际 %d 条", countComments(t))
			}
		})
	}
}

func TestPostCommentLengthBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name     string
		body     string
		wantCode int
	}{
		{"正文 2000 个字符（上限内）", postCommentBody("/p", "a", "a@b.com", strings.Repeat("字", 2000)), 200},
		{"正文 2001 个字符（超限）", postCommentBody("/p", "a", "a@b.com", strings.Repeat("字", 2001)), 400},
		{"正文 10000 个字符（远超限）", postCommentBody("/p", "a", "a@b.com", strings.Repeat("x", 10000)), 400},
		{"作者 100 个字符（上限内）", postCommentBody("/p", strings.Repeat("名", 100), "a@b.com", "c"), 200},
		{"作者 101 个字符（超限）", postCommentBody("/p", strings.Repeat("名", 101), "a@b.com", "c"), 400},
		{"邮箱 252 字节（上限内）", postCommentBody("/p", "a", strings.Repeat("a", 246)+"@b.com", "c"), 200},
		{"邮箱 255 字节（超限）", postCommentBody("/p", "a", strings.Repeat("a", 249)+"@b.com", "c"), 400},
		{"slug 200 字节（上限内）", postCommentBody("/"+strings.Repeat("s", 199), "a", "a@b.com", "c"), 200},
		{"slug 201 字节（超限）", postCommentBody("/"+strings.Repeat("s", 200), "a", "a@b.com", "c"), 400},
		{"url 500 字节（上限内）", `{"post_slug":"/p","author":"a","email":"a@b.com","content":"c","url":"https://a.com/` + strings.Repeat("u", 486) + `"}`, 200},
		{"url 501 字节（超限）", `{"post_slug":"/p","author":"a","email":"a@b.com","content":"c","url":"https://a.com/` + strings.Repeat("u", 487) + `"}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			w := callJSON(t, "POST", "/api/comments", tc.body)
			requireStatus(t, w, tc.wantCode)
			if tc.wantCode == 400 {
				m := decodeJSON(t, w)
				msg, _ := m["message"].(string)
				if !strings.Contains(msg, "Field too long") {
					t.Errorf("超长字段的错误信息应说明原因，实际 %q", msg)
				}
				if countComments(t) != 0 {
					t.Errorf("超长时应拒绝写入，实际 %d 条", countComments(t))
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// POST /api/comments —— 状态与限流
// ---------------------------------------------------------------------------

func TestPostCommentRespectsAutoApproveSetting(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *string
		want  string
	}{
		{"未配置时自动通过", nil, "approved"},
		{"comment_auto_approve=true", strPtr("true"), "approved"},
		{"comment_auto_approve 为空串", strPtr(""), "approved"},
		{"comment_auto_approve=false 进入待审核", strPtr("false"), "pending"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			if tc.value != nil {
				setSetting(t, "comment_auto_approve", *tc.value)
			}

			w := callJSON(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"))
			requireStatus(t, w, 200)

			if got := latestComment(t).Status; got != tc.want {
				t.Errorf("状态期望 %q，实际 %q", tc.want, got)
			}
		})
	}
}

func TestPostCommentRateLimit(t *testing.T) {
	t.Run("冷却期内被拒绝", func(t *testing.T) {
		resetState(t)
		ip := nextIP()
		seedComment(t, &model.Comment{
			PostSlug: "/p", Author: "old", Email: "old@x.com", IPAddress: &ip,
			ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved",
			PubDate: time.Now().UnixMilli() - 59_000,
		})

		w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"), ip+":1234")
		requireStatus(t, w, 429)
		requireBodyCode(t, w, 429)
		if countComments(t) != 1 {
			t.Errorf("被限流时不应写入新评论，实际 %d 条", countComments(t))
		}
	})

	t.Run("冷却结束可以提交", func(t *testing.T) {
		resetState(t)
		ip := nextIP()
		seedComment(t, &model.Comment{
			PostSlug: "/p", Author: "old", Email: "old@x.com", IPAddress: &ip,
			ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved",
			PubDate: time.Now().UnixMilli() - 61_000,
		})

		w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"), ip+":1234")
		requireStatus(t, w, 200)
		if countComments(t) != 2 {
			t.Errorf("冷却结束后应写入新评论，实际 %d 条", countComments(t))
		}
	})

	t.Run("连续两次提交第二次被拒绝", func(t *testing.T) {
		resetState(t)
		addr := nextRemoteAddr()

		requireStatus(t, callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "第一条"), addr), 200)
		w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "第二条"), addr)
		requireStatus(t, w, 429)
	})

	t.Run("其他 IP 不受影响", func(t *testing.T) {
		resetState(t)
		ipA := nextIP()
		seedComment(t, &model.Comment{
			PostSlug: "/p", Author: "old", Email: "old@x.com", IPAddress: &ipA,
			ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved",
			PubDate: time.Now().UnixMilli(),
		})

		w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "b", "b@b.com", "内容"), nextRemoteAddr())
		requireStatus(t, w, 200)
	})

	t.Run("pub_date 为 0 的历史数据不触发限流", func(t *testing.T) {
		resetState(t)
		ip := nextIP()
		seedComment(t, &model.Comment{
			PostSlug: "/p", Author: "old", Email: "old@x.com", IPAddress: &ip,
			ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved",
			PubDate: 0,
		})

		w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"), ip+":1234")
		requireStatus(t, w, 200)
	})

	t.Run("管理员邮箱不限流：同一 IP 60 秒内可连续提交", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_email", "admin@example.com")
		addr := nextRemoteAddr()

		requireStatus(t, callFromIP(t, "POST", "/api/comments",
			postCommentBody("/p", "博主", "admin@example.com", "第一条"), addr), 200)
		requireStatus(t, callFromIP(t, "POST", "/api/comments",
			postCommentBody("/p", "博主", "admin@example.com", "第二条"), addr), 200)
	})

	t.Run("未配置 admin_email 时普通邮箱仍受限流约束", func(t *testing.T) {
		resetState(t)
		addr := nextRemoteAddr()

		requireStatus(t, callFromIP(t, "POST", "/api/comments",
			postCommentBody("/p", "a", "admin@example.com", "第一条"), addr), 200)
		w := callFromIP(t, "POST", "/api/comments",
			postCommentBody("/p", "a", "admin@example.com", "第二条"), addr)
		requireStatus(t, w, 429)
	})
}

// ---------------------------------------------------------------------------
// POST /api/comments —— 黑名单
// ---------------------------------------------------------------------------

func TestPostCommentIPBlacklist(t *testing.T) {
	for _, tc := range []struct {
		name       string
		blacklist  string
		remoteAddr string
		wantStatus int
	}{
		{"精确命中被拒绝", `["203.0.113.9"]`, "203.0.113.9:1234", 403},
		{"未命中放行", `["203.0.113.9"]`, "203.0.113.10:1234", 200},
		{"CIDR 命中被拒绝", `["203.0.113.0/24"]`, "203.0.113.55:1234", 403},
		{"CIDR 未命中放行", `["203.0.113.0/24"]`, "203.0.114.1:1234", 200},
		{"多项之一命中", `["198.51.100.1","203.0.113.0/24"]`, "203.0.113.7:1234", 403},
		{"IPv6 精确命中", `["2001:db8::5"]`, "[2001:db8::5]:1234", 403},
		{"IPv6 CIDR 命中", `["2001:db8::/32"]`, "[2001:db8:abcd::1]:1234", 403},
		// 记录当前缺陷：IPv4-mapped 归一化只在信任代理分支生效，
		// TCP 对端地址（不信任代理时的取值）不会归一化，因此精确匹配失效；
		// 而 CIDR 匹配在 net.IPNet.Contains 内部会做 4-in-6 转换，所以仍然生效。
		{"IPv4-mapped IPv6 精确匹配失效（记录行为）", `["203.0.113.9"]`, "[::ffff:203.0.113.9]:1234", 200},
		{"IPv4-mapped IPv6 可被 CIDR 命中", `["203.0.113.0/24"]`, "[::ffff:203.0.113.9]:1234", 403},
		{"配置损坏时放行（fail-open）", `{"broken":`, "203.0.113.9:1234", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			setSetting(t, "ip_blacklist", tc.blacklist)

			w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"), tc.remoteAddr)
			requireStatus(t, w, tc.wantStatus)
			if tc.wantStatus == 403 {
				m := decodeJSON(t, w)
				if m["message"] != "Your IP has been blocked" {
					t.Errorf("错误信息期望 Your IP has been blocked，实际 %v", m["message"])
				}
				if countComments(t) != 0 {
					t.Errorf("被封禁的 IP 不应写入评论，实际 %d 条", countComments(t))
				}
			}
		})
	}
}

func TestPostCommentEmailBlacklist(t *testing.T) {
	for _, tc := range []struct {
		name       string
		blacklist  string
		email      string
		wantStatus int
	}{
		{"精确命中被拒绝", `["bad@x.com"]`, "bad@x.com", 403},
		{"大小写不敏感（查询大写）", `["bad@x.com"]`, "BAD@X.COM", 403},
		{"大小写不敏感（配置大写）", `["BAD@X.COM"]`, "bad@x.com", 403},
		{"未命中放行", `["bad@x.com"]`, "good@x.com", 200},
		{"配置损坏时放行（fail-open）", `{"broken":`, "bad@x.com", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetState(t)
			setSetting(t, "email_blacklist", tc.blacklist)

			w := callJSON(t, "POST", "/api/comments", postCommentBody("/p", "a", tc.email, "内容"))
			requireStatus(t, w, tc.wantStatus)
			if tc.wantStatus == 403 {
				m := decodeJSON(t, w)
				if m["message"] != "Your email has been blocked" {
					t.Errorf("错误信息期望 Your email has been blocked，实际 %v", m["message"])
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// POST /api/comments —— 无感验证与博主密钥
// ---------------------------------------------------------------------------

func TestPostCommentRequiresVerifyTicket(t *testing.T) {
	resetState(t)
	setSetting(t, "comment_verify_enabled", "true")

	ip := nextIP()
	addr := ip + ":1234"

	t.Run("缺少票据被拒绝", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"), nextRemoteAddr())
		requireStatus(t, w, 403)
		m := decodeJSON(t, w)
		if m["reason"] != "VERIFY_REQUIRED" {
			t.Errorf("reason 期望 VERIFY_REQUIRED，实际 %v", m["reason"])
		}
		if countComments(t) != 0 {
			t.Errorf("未通过人机验证不应写入评论")
		}
	})

	t.Run("票据与 IP/slug 匹配时放行", func(t *testing.T) {
		ticket, err := utils.CreateVerifyTicket(ip, "/p")
		if err != nil {
			t.Fatalf("签发票据失败: %v", err)
		}
		body := fmt.Sprintf(`{"post_slug":"/p","author":"a","email":"a@b.com","content":"内容","verify_ticket":%q}`, ticket)
		w := callFromIP(t, "POST", "/api/comments", body, addr)
		requireStatus(t, w, 200)
		if countComments(t) != 1 {
			t.Errorf("票据有效时应写入评论，实际 %d 条", countComments(t))
		}
	})

	t.Run("票据绑定其他文章时被拒绝", func(t *testing.T) {
		// 每个子用例使用独立 IP，避免命中 60 秒评论限流
		ownIP := nextIP()
		ticket, err := utils.CreateVerifyTicket(ownIP, "/other")
		if err != nil {
			t.Fatalf("签发票据失败: %v", err)
		}
		body := fmt.Sprintf(`{"post_slug":"/p","author":"a","email":"a@b.com","content":"内容","verify_ticket":%q}`, ticket)
		w := callFromIP(t, "POST", "/api/comments", body, ownIP+":1234")
		requireStatus(t, w, 403)
	})

	t.Run("票据绑定其他 IP 时被拒绝", func(t *testing.T) {
		ownIP := nextIP()
		ticket, err := utils.CreateVerifyTicket("198.51.100.77", "/p")
		if err != nil {
			t.Fatalf("签发票据失败: %v", err)
		}
		body := fmt.Sprintf(`{"post_slug":"/p","author":"a","email":"a@b.com","content":"内容","verify_ticket":%q}`, ticket)
		w := callFromIP(t, "POST", "/api/comments", body, ownIP+":1234")
		requireStatus(t, w, 403)
	})

	t.Run("验证开关关闭时不要求票据", func(t *testing.T) {
		setSetting(t, "comment_verify_enabled", "false")
		w := callFromIP(t, "POST", "/api/comments", postCommentBody("/p", "a", "a@b.com", "内容"), nextRemoteAddr())
		requireStatus(t, w, 200)
	})
}

func TestPostCommentAdminKey(t *testing.T) {
	t.Run("博主邮箱缺少密钥被拒绝", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_email", "admin@x.com")
		setSetting(t, "admin_comment_key", "secret-key")
		setSetting(t, "admin_comment_key_enabled", "true")

		w := callJSON(t, "POST", "/api/comments", postCommentBody("/p", "博主", "admin@x.com", "内容"))
		requireStatus(t, w, 403)
		m := decodeJSON(t, w)
		if m["message"] != "Invalid admin key" {
			t.Errorf("错误信息期望 Invalid admin key，实际 %v", m["message"])
		}
	})

	t.Run("密钥正确时免审核", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_email", "admin@x.com")
		setSetting(t, "admin_comment_key", "secret-key")
		setSetting(t, "admin_comment_key_enabled", "true")
		setSetting(t, "comment_auto_approve", "false")

		body := `{"post_slug":"/p","author":"博主","email":"admin@x.com","content":"内容","admin_key":"secret-key"}`
		w := callJSON(t, "POST", "/api/comments", body)
		requireStatus(t, w, 200)
		if got := latestComment(t).Status; got != "approved" {
			t.Errorf("博主评论应直接通过，实际 %q", got)
		}
	})

	t.Run("密钥错误被拒绝", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_email", "admin@x.com")
		setSetting(t, "admin_comment_key", "secret-key")
		setSetting(t, "admin_comment_key_enabled", "true")

		body := `{"post_slug":"/p","author":"博主","email":"admin@x.com","content":"内容","admin_key":"wrong"}`
		w := callJSON(t, "POST", "/api/comments", body)
		requireStatus(t, w, 403)
	})

	t.Run("非博主邮箱不校验密钥", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_email", "admin@x.com")
		setSetting(t, "admin_comment_key", "secret-key")
		setSetting(t, "admin_comment_key_enabled", "true")
		setSetting(t, "comment_auto_approve", "false")

		body := `{"post_slug":"/p","author":"路人","email":"user@x.com","content":"内容","admin_key":"wrong"}`
		w := callJSON(t, "POST", "/api/comments", body)
		requireStatus(t, w, 200)
		if got := latestComment(t).Status; got != "pending" {
			t.Errorf("普通用户仍应待审核，实际 %q", got)
		}
	})

	t.Run("密钥功能关闭时忽略 admin_key", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_email", "admin@x.com")
		setSetting(t, "admin_comment_key", "secret-key")
		setSetting(t, "admin_comment_key_enabled", "false")
		setSetting(t, "comment_auto_approve", "false")

		body := `{"post_slug":"/p","author":"博主","email":"admin@x.com","content":"内容","admin_key":"wrong"}`
		w := callJSON(t, "POST", "/api/comments", body)
		requireStatus(t, w, 200)
		if got := latestComment(t).Status; got != "pending" {
			t.Errorf("密钥功能关闭时不应免审核，实际 %q", got)
		}
	})

	t.Run("未配置密钥时不校验", func(t *testing.T) {
		resetState(t)
		setSetting(t, "admin_email", "admin@x.com")
		setSetting(t, "comment_auto_approve", "false")

		w := callJSON(t, "POST", "/api/comments", postCommentBody("/p", "博主", "admin@x.com", "内容"))
		requireStatus(t, w, 200)
	})
}

// ---------------------------------------------------------------------------
// GET /api/comments
// ---------------------------------------------------------------------------

func TestGetCommentsRequiresPostSlug(t *testing.T) {
	resetState(t)

	for _, target := range []string{"/api/comments", "/api/comments?post_slug=", "/api/comments?post_slug=&page=1"} {
		w := callJSON(t, "GET", target, "")
		requireStatus(t, w, 400)
		requireBodyCode(t, w, 400)
	}
}

func TestGetCommentsOnlyApprovedForSlug(t *testing.T) {
	resetState(t)

	seedComment(t, &model.Comment{PostSlug: "/p", Author: "approved", Email: "a@x.com", ContentText: "a", ContentHTML: "<p>a</p>", Status: "approved", PubDate: 1000})
	seedComment(t, &model.Comment{PostSlug: "/p", Author: "pending", Email: "p@x.com", ContentText: "p", ContentHTML: "<p>p</p>", Status: "pending", PubDate: 2000})
	seedComment(t, &model.Comment{PostSlug: "/p", Author: "rejected", Email: "r@x.com", ContentText: "r", ContentHTML: "<p>r</p>", Status: "rejected", PubDate: 3000})
	seedComment(t, &model.Comment{PostSlug: "/p", Author: "deleted", Email: "d@x.com", ContentText: "d", ContentHTML: "<p>d</p>", Status: "deleted", PubDate: 4000})
	seedComment(t, &model.Comment{PostSlug: "/other", Author: "other", Email: "o@x.com", ContentText: "o", ContentHTML: "<p>o</p>", Status: "approved", PubDate: 5000})

	w := callJSON(t, "GET", "/api/comments?post_slug=/p", "")
	requireStatus(t, w, 200)

	var payload commentsPayload
	decodeInto(t, w, &payload)
	if payload.Code != 200 {
		t.Errorf("code 期望 200，实际 %d", payload.Code)
	}
	if len(payload.Data.Comments) != 1 {
		t.Fatalf("只应返回 1 条已通过评论，实际 %d 条", len(payload.Data.Comments))
	}
	if payload.Data.Comments[0].Author != "approved" {
		t.Errorf("返回了错误状态的评论: %+v", payload.Data.Comments[0])
	}
	if payload.Data.Pagination.TotalPage != 1 {
		t.Errorf("totalPage 期望 1，实际 %d", payload.Data.Pagination.TotalPage)
	}
}

func TestGetCommentsBuildsReplyTree(t *testing.T) {
	resetState(t)

	root := seedComment(t, &model.Comment{PostSlug: "/p", Author: "root", Email: "r@x.com", ContentText: "r", ContentHTML: "<p>r</p>", Status: "approved", PubDate: 1000})
	child := seedComment(t, &model.Comment{PostSlug: "/p", Author: "child", Email: "c@x.com", ContentText: "c", ContentHTML: "<p>c</p>", Status: "approved", PubDate: 2000, ParentID: &root.ID})
	grandchild := seedComment(t, &model.Comment{PostSlug: "/p", Author: "grandchild", Email: "g@x.com", ContentText: "g", ContentHTML: "<p>g</p>", Status: "approved", PubDate: 3000, ParentID: &child.ID})

	w := callJSON(t, "GET", "/api/comments?post_slug=/p", "")
	requireStatus(t, w, 200)

	var payload commentsPayload
	decodeInto(t, w, &payload)

	if len(payload.Data.Comments) != 1 {
		t.Fatalf("嵌套模式下顶层应只有 1 条根评论，实际 %d 条", len(payload.Data.Comments))
	}
	gotRoot := payload.Data.Comments[0]
	if gotRoot.ID != root.ID {
		t.Errorf("根评论 id 期望 %d，实际 %d", root.ID, gotRoot.ID)
	}
	if len(gotRoot.Replies) != 1 {
		t.Fatalf("根评论应有 1 条回复，实际 %d 条", len(gotRoot.Replies))
	}
	if gotRoot.Replies[0].ID != child.ID {
		t.Errorf("回复 id 期望 %d，实际 %d", child.ID, gotRoot.Replies[0].ID)
	}
	if gotRoot.Replies[0].ParentID == nil || *gotRoot.Replies[0].ParentID != root.ID {
		t.Errorf("回复的 parentId 应为根评论 id")
	}
	if len(gotRoot.Replies[0].Replies) != 1 {
		t.Fatalf("二级回复应挂在其父评论下，实际 %d 条", len(gotRoot.Replies[0].Replies))
	}
	if gotRoot.Replies[0].Replies[0].ID != grandchild.ID {
		t.Errorf("孙评论 id 期望 %d，实际 %d", grandchild.ID, gotRoot.Replies[0].Replies[0].ID)
	}
}

func TestGetCommentsOrphanReplyBecomesRoot(t *testing.T) {
	resetState(t)

	// 父评论处于待审核状态，不会被返回；此时子评论成为顶层
	parent := seedComment(t, &model.Comment{PostSlug: "/p", Author: "parent", Email: "p@x.com", ContentText: "p", ContentHTML: "<p>p</p>", Status: "pending", PubDate: 1000})
	child := seedComment(t, &model.Comment{PostSlug: "/p", Author: "child", Email: "c@x.com", ContentText: "c", ContentHTML: "<p>c</p>", Status: "approved", PubDate: 2000, ParentID: &parent.ID})

	w := callJSON(t, "GET", "/api/comments?post_slug=/p", "")
	requireStatus(t, w, 200)

	var payload commentsPayload
	decodeInto(t, w, &payload)

	if len(payload.Data.Comments) != 1 {
		t.Fatalf("期望 1 条顶层评论，实际 %d 条", len(payload.Data.Comments))
	}
	got := payload.Data.Comments[0]
	if got.ID != child.ID {
		t.Errorf("孤儿子评论应作为顶层返回，实际 id=%d", got.ID)
	}
	// 记录当前行为：parentId 仍指向未被返回的父评论
	if got.ParentID == nil || *got.ParentID != parent.ID {
		t.Errorf("当前实现会保留原 parentId，实际 %v", got.ParentID)
	}
}

func TestGetCommentsPagination(t *testing.T) {
	resetState(t)

	for i := 0; i < 5; i++ {
		seedComment(t, &model.Comment{
			PostSlug: "/p", Author: fmt.Sprintf("a%d", i), Email: fmt.Sprintf("a%d@x.com", i),
			ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: int64(1000 + i),
		})
	}

	for _, tc := range []struct {
		name          string
		query         string
		wantLen       int
		wantPage      int
		wantLimit     int
		wantTotalPage int64
	}{
		{"默认分页", "", 5, 1, 20, 1},
		{"limit=2 第一页", "&limit=2", 2, 1, 2, 3},
		{"limit=2 第二页", "&limit=2&page=2", 2, 2, 2, 3},
		{"limit=2 第三页", "&limit=2&page=3", 1, 3, 2, 3},
		{"越界页返回空数组", "&limit=2&page=99", 0, 99, 2, 3},
		{"limit=100 被夹到 50", "&limit=100", 5, 1, 50, 1},
		{"limit=0 回落 20", "&limit=0", 5, 1, 20, 1},
		{"limit 为负回落 20", "&limit=-5", 5, 1, 20, 1},
		{"limit 非数字回落 20", "&limit=abc", 5, 1, 20, 1},
		{"page=0 回落 1", "&page=0", 5, 1, 20, 1},
		{"page 为负回落 1", "&page=-3", 5, 1, 20, 1},
		{"page 非数字回落 1", "&page=xyz", 5, 1, 20, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := callJSON(t, "GET", "/api/comments?post_slug=/p"+tc.query, "")
			requireStatus(t, w, 200)

			var payload commentsPayload
			decodeInto(t, w, &payload)

			if len(payload.Data.Comments) != tc.wantLen {
				t.Errorf("条数期望 %d，实际 %d", tc.wantLen, len(payload.Data.Comments))
			}
			if payload.Data.Pagination.Page != tc.wantPage {
				t.Errorf("page 期望 %d，实际 %d", tc.wantPage, payload.Data.Pagination.Page)
			}
			if payload.Data.Pagination.Limit != tc.wantLimit {
				t.Errorf("limit 期望 %d，实际 %d", tc.wantLimit, payload.Data.Pagination.Limit)
			}
			if payload.Data.Pagination.TotalPage != tc.wantTotalPage {
				t.Errorf("totalPage 期望 %d，实际 %d", tc.wantTotalPage, payload.Data.Pagination.TotalPage)
			}
		})
	}

	// 空结果必须是 [] 而不是 null
	t.Run("空的评论列表序列化为空数组", func(t *testing.T) {
		w := callJSON(t, "GET", "/api/comments?post_slug=/not-exist", "")
		requireStatus(t, w, 200)
		if !strings.Contains(w.Body.String(), `"comments":[]`) {
			t.Errorf("空列表应序列化为 []，实际 %s", w.Body.String())
		}
	})
}

func TestGetCommentsNestedFalse(t *testing.T) {
	resetState(t)

	root := seedComment(t, &model.Comment{PostSlug: "/p", Author: "root", Email: "r@x.com", ContentText: "r", ContentHTML: "<p>r</p>", Status: "approved", PubDate: 1000})
	seedComment(t, &model.Comment{PostSlug: "/p", Author: "child", Email: "c@x.com", ContentText: "c", ContentHTML: "<p>c</p>", Status: "approved", PubDate: 2000, ParentID: &root.ID})

	w := callJSON(t, "GET", "/api/comments?post_slug=/p&nested=false", "")
	requireStatus(t, w, 200)

	var payload commentsPayload
	decodeInto(t, w, &payload)

	if len(payload.Data.Comments) != 2 {
		t.Fatalf("nested=false 应返回全部评论，实际 %d 条", len(payload.Data.Comments))
	}
	for _, c := range payload.Data.Comments {
		if len(c.Replies) != 0 {
			t.Errorf("nested=false 时不应组装回复树: %+v", c)
		}
	}
}

func TestGetCommentsResponseFields(t *testing.T) {
	resetState(t)
	setSetting(t, "admin_email", "admin@x.com")
	setSetting(t, "blogger_badge_enabled", "true")
	setSetting(t, "blogger_badge_text", "博主")
	setSetting(t, "placeholder_name", "请输入昵称")
	setSetting(t, "placeholder_email", "请输入邮箱")
	setSetting(t, "placeholder_content", "请输入内容")
	setSetting(t, "placeholder_url", "请输入网址")

	seedComment(t, &model.Comment{PostSlug: "/p", Author: "博主", Email: "admin@x.com", ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1712345678901, URL: strPtr("https://a.com")})
	seedComment(t, &model.Comment{PostSlug: "/p", Author: "路人", Email: "user@x.com", ContentText: "u", ContentHTML: "<p>u</p>", Status: "approved", PubDate: 1712345679000})

	w := callJSON(t, "GET", "/api/comments?post_slug=/p", "")
	requireStatus(t, w, 200)

	var payload commentsPayload
	decodeInto(t, w, &payload)

	if len(payload.Data.Comments) != 2 {
		t.Fatalf("期望 2 条评论，实际 %d 条", len(payload.Data.Comments))
	}

	var blogger, user *commentResp
	for _, c := range payload.Data.Comments {
		if c.Author == "博主" {
			blogger = c
		} else {
			user = c
		}
	}
	if blogger == nil || user == nil {
		t.Fatalf("未找到预期的两条评论: %+v", payload.Data.Comments)
	}

	if !blogger.IsBlogger {
		t.Errorf("博主评论的 isBlogger 应为 true")
	}
	if user.IsBlogger {
		t.Errorf("普通用户的 isBlogger 应为 false")
	}
	if !strings.HasPrefix(blogger.Avatar, "https://open.motues.top/avatar?name=") {
		t.Errorf("avatar 应为头像服务地址，实际 %q", blogger.Avatar)
	}
	// 哈希为邮箱小写形式的 MD5（具体向量由 utils 包的 avatar 测试钉死）
	rest := strings.TrimPrefix(blogger.Avatar, "https://open.motues.top/avatar?name=")
	hash, _, _ := strings.Cut(rest, "&")
	if len(hash) != 32 || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(hash) {
		t.Errorf("avatar 中的哈希应为 32 位小写十六进制，实际 %q", hash)
	}
	if blogger.PubDate != "2024-04-05T19:34:38.901Z" {
		t.Errorf("pubDate 应为毫秒 ISO（UTC），实际 %q", blogger.PubDate)
	}
	if blogger.URL == nil || *blogger.URL != "https://a.com" {
		t.Errorf("url 应原样返回，实际 %v", blogger.URL)
	}
	if blogger.ContentText != "t" || blogger.ContentHTML != "<p>t</p>" {
		t.Errorf("正文字段不正确: %+v", blogger)
	}

	if payload.Data.BloggerBadgeEnabled != "true" || payload.Data.BloggerBadgeText != "博主" {
		t.Errorf("博主标识设置未下发: %+v", payload.Data)
	}
	if payload.Data.PlaceholderName != "请输入昵称" || payload.Data.PlaceholderEmail != "请输入邮箱" ||
		payload.Data.PlaceholderContent != "请输入内容" || payload.Data.PlaceholderURL != "请输入网址" {
		t.Errorf("占位符设置未下发: %+v", payload.Data)
	}
	if payload.Data.VerifyEnabled != "false" || payload.Data.VerifyHoneypot != "" {
		t.Errorf("默认应关闭无感验证，实际 %q / %q", payload.Data.VerifyEnabled, payload.Data.VerifyHoneypot)
	}
}

func TestGetCommentsAdminCommentKeyMetadata(t *testing.T) {
	resetState(t)

	t.Run("未启用时不泄露管理员邮箱哈希", func(t *testing.T) {
		setSetting(t, "admin_email", "admin@x.com")
		w := callJSON(t, "GET", "/api/comments?post_slug=/p", "")
		requireStatus(t, w, 200)

		var payload commentsPayload
		decodeInto(t, w, &payload)
		if payload.Data.AdminCommentKeyConfigured != "false" {
			t.Errorf("未启用时 admin_comment_key_configured 应为 false，实际 %q", payload.Data.AdminCommentKeyConfigured)
		}
		if payload.Data.AdminEmailHash != "" {
			t.Errorf("未启用博主密钥时不应下发邮箱哈希，实际 %q", payload.Data.AdminEmailHash)
		}
	})

	t.Run("启用时下发规范化后的邮箱哈希", func(t *testing.T) {
		setSetting(t, "admin_email", "Admin@X.com") // 大小写与空格都应被归一化
		setSetting(t, "admin_comment_key", "k")
		setSetting(t, "admin_comment_key_enabled", "true")

		w := callJSON(t, "GET", "/api/comments?post_slug=/p", "")
		requireStatus(t, w, 200)

		var payload commentsPayload
		decodeInto(t, w, &payload)
		if payload.Data.AdminCommentKeyConfigured != "true" {
			t.Errorf("启用时 admin_comment_key_configured 应为 true，实际 %q", payload.Data.AdminCommentKeyConfigured)
		}
		want := fmt.Sprintf("%x", sha256.Sum256([]byte("admin@x.com")))
		if payload.Data.AdminEmailHash != want {
			t.Errorf("admin_email_hash 期望 %q，实际 %q", want, payload.Data.AdminEmailHash)
		}
	})

	t.Run("开启人机验证时下发蜜罐字段名", func(t *testing.T) {
		setSetting(t, "comment_verify_enabled", "true")
		w := callJSON(t, "GET", "/api/comments?post_slug=/p", "")
		requireStatus(t, w, 200)

		var payload commentsPayload
		decodeInto(t, w, &payload)
		if payload.Data.VerifyEnabled != "true" {
			t.Errorf("verify_enabled 期望 true，实际 %q", payload.Data.VerifyEnabled)
		}
		if !strings.HasPrefix(payload.Data.VerifyHoneypot, "v_") || len(payload.Data.VerifyHoneypot) != 12 {
			t.Errorf("verify_honeypot 应形如 v_ + 10 位十六进制，实际 %q", payload.Data.VerifyHoneypot)
		}
	})
}

// ---------------------------------------------------------------------------
// 分页与树构建的内部函数（单元测试）
// ---------------------------------------------------------------------------

func TestSlicePagination(t *testing.T) {
	for _, tc := range []struct {
		name      string
		total     int
		page      int
		limit     int
		wantStart int
		wantEnd   int
	}{
		{"首页", 10, 1, 5, 0, 5},
		{"中间页", 10, 2, 5, 5, 10},
		{"末页不满", 7, 2, 5, 5, 7},
		{"越界页返回空区间", 10, 5, 5, 10, 10},
		{"total 为 0", 0, 1, 5, 0, 0},
		// handler 层已把 page < 1 校正为 1，函数本身也把负 start 夹到 total
		{"page 为 0（夹到空区间）", 10, 0, 5, 10, 10},
		{"limit 为 0", 10, 1, 0, 0, 0},
		// handler 层已把 limit 夹到 >= 1；函数本身对负 end 一并夹取
		{"limit 为负", 10, 1, -5, 10, 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			start, end := slicePagination(tc.total, tc.page, tc.limit)
			if start != tc.wantStart || end != tc.wantEnd {
				t.Errorf("slicePagination(%d,%d,%d) 期望 (%d,%d)，实际 (%d,%d)",
					tc.total, tc.page, tc.limit, tc.wantStart, tc.wantEnd, start, end)
			}
		})
	}
}

// TestSlicePaginationIntegerOverflow 验证溢出保护：
// (page-1)*limit 在 64 位平台上会溢出为负数，修复后必须被夹到 [0,total]，
// 不能把负下标返回给调用方。
func TestSlicePaginationIntegerOverflow(t *testing.T) {
	const hugePage = 200_000_000_000_000_000
	start, end := slicePagination(10, hugePage, 50)
	if start != 10 || end != 10 {
		t.Fatalf("溢出页应返回空区间 (10,10)，实际 (%d,%d)", start, end)
	}
	if start < 0 || end < 0 {
		t.Errorf("返回值不能为负，实际 (%d,%d)", start, end)
	}
}

// TestGetCommentsHugePagePanics 验证真实缺陷已修复：
// GET /api/comments?page=<超大值>&limit=50 曾让 slicePagination 整数溢出，
// 产生负下标切片 panic，最终返回 HTTP 500。修复后应返回 200 空列表。
// 相关代码：go/internal/handler/http/comment.go 的 slicePagination 与 GetComments。
func TestGetCommentsHugePagePanics(t *testing.T) {
	resetState(t)
	seedComment(t, &model.Comment{PostSlug: "/p", Author: "a", Email: "a@x.com", ContentText: "t", ContentHTML: "<p>t</p>", Status: "approved", PubDate: 1000})

	w := callJSON(t, "GET", "/api/comments?post_slug=/p&page=200000000000000000&limit=50", "")
	requireStatus(t, w, 200)

	var payload commentsPayload
	decodeInto(t, w, &payload)
	if len(payload.Data.Comments) != 0 {
		t.Errorf("越界页应返回空列表，实际 %d 条", len(payload.Data.Comments))
	}
}

func TestBuildCommentTree(t *testing.T) {
	root := &model.CommentResponse{ID: 1}
	child := &model.CommentResponse{ID: 2, ParentID: int64Ptr(1)}
	grandchild := &model.CommentResponse{ID: 3, ParentID: int64Ptr(2)}
	orphan := &model.CommentResponse{ID: 4, ParentID: int64Ptr(999)}
	second := &model.CommentResponse{ID: 5}

	tree := buildCommentTree([]*model.CommentResponse{root, child, grandchild, orphan, second})
	if len(tree) != 3 {
		t.Fatalf("应产生 3 个根节点，实际 %d 个", len(tree))
	}
	if len(root.Replies) != 1 || root.Replies[0].ID != 2 {
		t.Errorf("根节点 1 应包含子节点 2: %+v", root.Replies)
	}
	if len(child.Replies) != 1 || child.Replies[0].ID != 3 {
		t.Errorf("节点 2 应包含子节点 3: %+v", child.Replies)
	}
	if len(grandchild.Replies) != 0 {
		t.Errorf("叶子节点不应有子节点")
	}
	// 父节点不存在的评论会成为根节点
	foundOrphan := false
	for _, n := range tree {
		if n.ID == 4 {
			foundOrphan = true
		}
	}
	if !foundOrphan {
		t.Errorf("父节点缺失的评论应作为根节点返回: %+v", tree)
	}
}

func TestBuildCommentTreeEmpty(t *testing.T) {
	if tree := buildCommentTree(nil); len(tree) != 0 {
		t.Errorf("空输入应返回空树，实际 %d 个节点", len(tree))
	}
	if tree := buildCommentTree([]*model.CommentResponse{}); len(tree) != 0 {
		t.Errorf("空切片应返回空树，实际 %d 个节点", len(tree))
	}
}

func TestBuildCommentTreeCycleDoesNotHang(t *testing.T) {
	// 互相指向的两条评论：不应无限递归或 panic
	a := &model.CommentResponse{ID: 1, ParentID: int64Ptr(2)}
	b := &model.CommentResponse{ID: 2, ParentID: int64Ptr(1)}
	tree := buildCommentTree([]*model.CommentResponse{a, b})
	if len(tree) != 0 {
		t.Errorf("互相引用的评论不会成为根节点，实际 %d 个根", len(tree))
	}
	if len(a.Replies) != 1 || a.Replies[0].ID != b.ID {
		t.Errorf("互相引用的两条评论仍会互相挂载: %+v", a.Replies)
	}
}

func TestClampSlug(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  string
	}{
		{"普通 slug", "/posts/hello", "/posts/hello"},
		{"去除首尾空白", "  /posts/hello  ", "/posts/hello"},
		{"空串", "", ""},
		{"恰好 200 字节", strings.Repeat("a", 200), strings.Repeat("a", 200)},
		{"201 字节被截断到 200", strings.Repeat("a", 201), strings.Repeat("a", 200)},
		{"远超长度被截断", strings.Repeat("a", 1000), strings.Repeat("a", 200)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := clampSlug(tc.input); got != tc.want {
				t.Errorf("clampSlug 期望长度 %d 的字符串，实际长度 %d", len(tc.want), len(got))
			}
		})
	}

	// 记录当前行为：clampSlug 按字节截断，会切断多字节字符（100 个汉字 = 300 字节，
	// 截到 200 字节时第 67 个汉字只剩 2 个字节），产生非法 UTF-8。
	t.Run("多字节字符被按字节截断", func(t *testing.T) {
		got := clampSlug(strings.Repeat("汉", 100))
		if len(got) != 200 {
			t.Errorf("截断后长度应为 200 字节，实际 %d", len(got))
		}
		if utf8.ValidString(got) {
			t.Errorf("当前实现按字节截断多字节字符，截断结果应为非法 UTF-8（记录该行为）")
		}
	})
}

// strPtr 返回字符串指针
func strPtr(s string) *string { return &s }

// int64Ptr 返回 int64 指针
func int64Ptr(v int64) *int64 { return &v }
