package utils

import (
	"crypto/sha256"
	"strconv"
	"testing"
)

/*
跨语言一致性测试

Node.js / Go / Cloudflare Worker 三套实现必须使用完全相同的算法口径，
否则同一份密钥下签发的票据无法互相校验。本测试用一组固定向量把这套口径钉死。

向量生成方式（Node.js 侧）：
	secret = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801"
	ip     = "::ffff:127.0.0.1"
	slug   = "/posts/vector-check"
	ip_hash   = hex(SHA256("ip:" + secret + ":" + ip))[:16]
	honeypot  = "v_" + hex(SHA256("hp:" + secret + ":" + slug))[:10]
	prefix    = base64url(JSON.stringify({cid, iph: ip_hash, iat: 1730000000000}))
	prefix_sig = base64url(HMAC-SHA256(prefix, secret))
	ticket_body = base64url(JSON.stringify({v:1, iph, slug, iat, exp, jti}))
	ticket_sig  = base64url(HMAC-SHA256(ticket_body, secret))

若其中任何一项变化，说明三端口径已经漂移，必须同步修改 Node 与 Worker 实现。
*/
const (
	vectorSecret   = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801"
	vectorIP       = "::ffff:127.0.0.1"
	vectorSlug     = "/posts/vector-check"
	vectorIPHash   = "20fa49e706f48b01"
	vectorHoneypot = "v_77dc2477f6"
	vectorPrefix   = "eyJjaWQiOiJkR1Z6ZEMxamFHRnNiR1Z1WjJVIiwiaXBoIjoiMjBmYTQ5ZTcwNmY0OGIwMSIsImlhdCI6MTczMDAwMDAwMDAwMH0"
	vectorSig      = "OdtEE6BBCwUhnC5GTRoIcWALl_Wcv5qOfrwVT6tenK0"
	vectorNonce    = int64(12345)
	vectorLeading  = 2

	// 与 vectorPrefix 对应的 JSON 载荷原文
	vectorPayloadJSON = `{"cid":"dGVzdC1jaGFsbGVuZ2U","iph":"20fa49e706f48b01","iat":1730000000000}`
)

func TestCrossLanguageConsistency(t *testing.T) {
	if got := hashVerifyIP(vectorIP, vectorSecret); got != vectorIPHash {
		t.Errorf("IP 哈希口径漂移: got=%s want=%s", got, vectorIPHash)
	}

	if got := honeypotFieldName(vectorSlug, vectorSecret); got != vectorHoneypot {
		t.Errorf("蜜罐字段名口径漂移: got=%s want=%s", got, vectorHoneypot)
	}

	if got := hmacSHA256(vectorPrefix, vectorSecret); got != vectorSig {
		t.Errorf("前缀签名口径漂移: got=%s want=%s", got, vectorSig)
	}

	sum := sha256.Sum256([]byte(vectorPrefix + ":" + strconv.FormatInt(vectorNonce, 10)))
	if got := leadingZeroBits(sum[:]); got != vectorLeading {
		t.Errorf("前导 0 比特数口径漂移: got=%d want=%d", got, vectorLeading)
	}

	if got := b64urlEncode([]byte(vectorPayloadJSON)); got != vectorPrefix {
		t.Errorf("base64url 载荷编码口径漂移: got=%s want=%s", got, vectorPrefix)
	}

	if decoded, err := b64urlDecode(vectorPrefix + "=="); err != nil {
		t.Errorf("应容忍带填充的 base64url 输入: %v", err)
	} else if b64urlEncode(decoded) != vectorPrefix {
		t.Errorf("base64url 往返不一致")
	}
}

// TestTicketSelfConsistency 校验票据的签发与校验在同一实现内闭环，
// 覆盖 IP 绑定、文章绑定与防篡改。
func TestTicketSelfConsistency(t *testing.T) {
	verifySecretOnce.Do(func() {})
	verifySecretVal = vectorSecret

	ticket, err := CreateVerifyTicket(vectorIP, vectorSlug)
	if err != nil {
		t.Fatalf("签发票据失败: %v", err)
	}

	if !VerifyTicket(ticket, vectorIP, vectorSlug) {
		t.Errorf("自己签发的票据无法通过校验")
	}
	if VerifyTicket(ticket, "10.0.0.1", vectorSlug) {
		t.Errorf("票据不应跨 IP 有效")
	}
	if VerifyTicket(ticket, vectorIP, "/posts/other") {
		t.Errorf("票据不应跨文章有效")
	}
	if VerifyTicket(ticket[:len(ticket)-4]+"aaaa", vectorIP, vectorSlug) {
		t.Errorf("被篡改的票据不应通过校验")
	}
	if VerifyTicket("", vectorIP, vectorSlug) {
		t.Errorf("空票据不应通过校验")
	}
	if VerifyTicket("nodot", vectorIP, vectorSlug) {
		t.Errorf("格式错误的票据不应通过校验")
	}
}
