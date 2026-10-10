package utils

import (
	"encoding/hex"
	"strconv"
	"testing"
)

/*
跨语言一致性测试（协议 v2）

Node.js / Go / Cloudflare Worker / 前端四套实现必须使用完全相同的算法口径，
否则同一份密钥下签发的挑战与票据无法互相校验。本文件只做「原语口径」的交叉复核；
整条链路的固定向量验收在 verify_vectors_test.go（读 doc/vectors/verify-v2.json）。

向量生成方式（Node.js 侧，见 nodejs/scripts/gen-verify-vectors.ts）：
	secret    = 见 fixture
	ip_hash   = hex(SHA256("ip:" + secret + ":" + ip))[:16]
	honeypot  = "v_" + hex(SHA256("hp:" + secret + ":" + slug))[:10]
	prefix    = base64url(JSON.stringify({v:2, cid, iph, slug, iat}))
	prefix_sig = base64url(HMAC-SHA256(prefix, secret))
	ticket_body = base64url(JSON.stringify({v:2, iph, slug, iat, exp, jti}))
	ticket_sig  = base64url(HMAC-SHA256(ticket_body, secret))

若其中任何一项变化，说明四端口径已经漂移。
*/

func TestCrossLanguageConsistency(t *testing.T) {
	fixture := loadVerifyFixture(t)

	if got := hashVerifyIP(fixture.IP, fixture.Secret); got != fixture.IPHash {
		t.Errorf("IP 哈希口径漂移: got=%s want=%s", got, fixture.IPHash)
	}
	if got := honeypotFieldName(fixture.Slug, fixture.Secret); got != fixture.Honeypot {
		t.Errorf("蜜罐字段名口径漂移: got=%s want=%s", got, fixture.Honeypot)
	}
	if got := hmacSHA256(fixture.Prefix, fixture.Secret); got != fixture.Sig {
		t.Errorf("前缀签名口径漂移: got=%s want=%s", got, fixture.Sig)
	}
	if got := b64urlEncode([]byte(fixture.ChallengePayloadJSON)); got != fixture.Prefix {
		t.Errorf("base64url 载荷编码口径漂移: got=%s want=%s", got, fixture.Prefix)
	}
	if got := hex.EncodeToString(deriveHashwxChallenge(fixture.Cid, fixture.Secret)); got != fixture.Hashwx.C {
		t.Errorf("HashWX 挑战派生口径漂移: got=%s want=%s", got, fixture.Hashwx.C)
	}
	if decoded, err := b64urlDecode(fixture.Prefix + "=="); err != nil {
		t.Errorf("应容忍带填充的 base64url 输入: %v", err)
	} else if b64urlEncode(decoded) != fixture.Prefix {
		t.Errorf("base64url 往返不一致")
	}
}

// TestParseIntJSMatchNode 钉住难度设置的解析口径与 Node 的 parseInt(raw, 10) 一致
func TestParseIntJSMatchNode(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		value float64
		ok    bool
	}{
		{"18", 18, true},
		{" 18", 18, true},
		{"\t18", 18, true},
		{"18abc", 18, true},
		{"+18", 18, true},
		{"-18", -18, true},
		{"0x10", 0, true}, // parseInt(...,10) 在 'x' 处停止
		{"18.9", 18, true},
		{"", 0, false},
		{"abc", 0, false},
		{"  ", 0, false},
	} {
		value, ok := parseIntJS(tc.raw)
		if ok != tc.ok || (ok && value != tc.value) {
			t.Errorf("parseIntJS(%q) 期望 (%v,%v)，实际 (%v,%v)", tc.raw, tc.value, tc.ok, value, ok)
		}
	}
}

// TestTicketSelfConsistency 校验票据的签发与校验在同一实现内闭环，
// 覆盖 IP 绑定、文章绑定与防篡改。
func TestTicketSelfConsistency(t *testing.T) {
	fixture := loadVerifyFixture(t)

	verifySecretOnce.Do(func() {})
	previous := verifySecretVal
	verifySecretVal = fixture.Secret
	t.Cleanup(func() { verifySecretVal = previous })

	ticket, err := CreateVerifyTicket(fixture.IP, fixture.Slug)
	if err != nil {
		t.Fatalf("签发票据失败: %v", err)
	}

	if !VerifyTicket(ticket, fixture.IP, fixture.Slug) {
		t.Errorf("自己签发的票据无法通过校验")
	}
	if VerifyTicket(ticket, "10.0.0.1", fixture.Slug) {
		t.Errorf("票据不应跨 IP 有效")
	}
	if VerifyTicket(ticket, fixture.IP, "/posts/other") {
		t.Errorf("票据不应跨文章有效")
	}
	if VerifyTicket(ticket[:len(ticket)-4]+"aaaa", fixture.IP, fixture.Slug) {
		t.Errorf("被篡改的票据不应通过校验")
	}
	if VerifyTicket("", fixture.IP, fixture.Slug) {
		t.Errorf("空票据不应通过校验")
	}
	if VerifyTicket("nodot", fixture.IP, fixture.Slug) {
		t.Errorf("格式错误的票据不应通过校验")
	}

	// 票据版本必须为 v2
	dot := len(ticket) - 1
	for i := len(ticket) - 1; i >= 0; i-- {
		if ticket[i] == '.' {
			dot = i
			break
		}
	}
	raw, err := b64urlDecode(ticket[:dot])
	if err != nil {
		t.Fatalf("票据 body 解码失败: %v", err)
	}
	if !containsSubstring(string(raw), `"v":`+strconv.Itoa(VerifyProtocolVersion)) {
		t.Errorf("票据载荷应带 v:%d，实际 %s", VerifyProtocolVersion, raw)
	}
}

func containsSubstring(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
