package utils

import (
	"encoding/json"
	"testing"
	"time"
)

/*
跨语言向量补充测试

verify_consistency_test.go 已经钉死了单项算法口径（IP 哈希、蜜罐字段名、HMAC、base64url、
前导 0 比特）。本文件在其基础上补充两类「整体链路」向量：

 1. 固定票据载荷的序列化顺序 + 签名（Node/Worker 必须生成逐字节相同的 body 与 sig）；
 2. 用共享向量密钥走完整的 VerifySolution / VerifyTicket 校验路径，
    证明 Go 端的校验逻辑与 Node 端签发的数据可以直接互认。

固定向量由现有 verify_consistency_test.go 中的 vectorSecret / vectorIP / vectorSlug /
vectorIPHash 常量配合，不重复定义。
*/

const (
	// 与 verify_consistency_test.go 的向量保持同一批数据
	vectorTicketIat = int64(1730000000000)
	vectorTicketExp = int64(1730000300000)
	vectorTicketJti = "dGVzdC1qdGk"

	// 由 Go 端序列化得到的固定票据 body / 签名（Node/Worker 必须一致）
	vectorTicketBody = "eyJ2IjoxLCJpcGgiOiIyMGZhNDllNzA2ZjQ4YjAxIiwic2x1ZyI6Ii9wb3N0cy92ZWN0b3ItY2hlY2siLCJpYXQiOjE3MzAwMDAwMDAwMDAsImV4cCI6MTczMDAwMDMwMDAwMCwianRpIjoiZEdWemRDMXFkR2sifQ"
	vectorTicketSig  = "bb9tHCd20UfHL07hPAlrMFLOj0q1JvmKUHo2ypagv7k"
)

// withVectorSecret 把进程内签名密钥临时切换为跨语言向量密钥，用例结束后恢复
func withVectorSecret(t *testing.T) {
	t.Helper()
	verifySecretOnce.Do(func() {})
	previous := verifySecretVal
	verifySecretVal = vectorSecret
	t.Cleanup(func() { verifySecretVal = previous })
}

// TestCrossLanguageTicketSerialization 钉死票据载荷的字段顺序与签名：
// 字段顺序变化会让 Node/Worker 签发的票据在 Go 端全部失效。
func TestCrossLanguageTicketSerialization(t *testing.T) {
	payload := verifyTicketPayload{
		V:    1,
		Iph:  vectorIPHash,
		Slug: vectorSlug,
		Iat:  vectorTicketIat,
		Exp:  vectorTicketExp,
		Jti:  vectorTicketJti,
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("序列化票据载荷失败: %v", err)
	}
	body := b64urlEncode(raw)
	if body != vectorTicketBody {
		t.Errorf("票据 body 口径漂移:\n got=%s\nwant=%s", body, vectorTicketBody)
	}
	if sig := hmacSHA256(body, vectorSecret); sig != vectorTicketSig {
		t.Errorf("票据签名口径漂移:\n got=%s\nwant=%s", sig, vectorTicketSig)
	}
}

// TestCrossLanguageTicketVerification 用共享向量密钥校验完整票据链路
func TestCrossLanguageTicketVerification(t *testing.T) {
	resetSettings(t)
	withVectorSecret(t)

	ticket := vectorTicketBody + "." + vectorTicketSig
	// 固定向量的 exp 是 2024 年的时间点，早已过期，因此整体校验必须失败，
	// 但仍要确保失败原因不是签名（签名不匹配说明口径已经漂移）。
	if VerifyTicket(ticket, vectorIP, vectorSlug) {
		t.Errorf("已过期的固定向量票据不应通过校验")
	}
	if !constantTimeEqual(hmacSHA256(vectorTicketBody, vectorSecret), vectorTicketSig) {
		t.Errorf("固定票据向量的签名不匹配，说明 HMAC 口径漂移")
	}

	// 用同一密钥与同一序列化口径签发一张在有效期内的票据，链路必须闭环
	now := time.Now().UnixMilli()
	live := makeTicket(t, vectorSecret, verifyTicketPayload{
		V: 1, Iph: hashVerifyIP(vectorIP, vectorSecret), Slug: vectorSlug,
		Iat: now, Exp: now + 60_000, Jti: vectorTicketJti,
	})
	if !VerifyTicket(live, vectorIP, vectorSlug) {
		t.Errorf("用向量密钥签发的票据应通过校验")
	}
	if VerifyTicket(live, "10.0.0.1", vectorSlug) {
		t.Errorf("票据不应跨 IP 有效")
	}
	if VerifyTicket(live, vectorIP, "/posts/other") {
		t.Errorf("票据不应跨文章有效")
	}
}

// TestCrossLanguageChallengeVerification 用固定前缀向量走完整的答案校验路径：
// 前四步（签名 → 载荷 → 时效 → IP 绑定）必须全部通过，最终只因工作量不足被拒绝。
func TestCrossLanguageChallengeVerification(t *testing.T) {
	resetSettings(t)
	withVectorSecret(t)
	setTestDifficulty(t, "8")

	// 1. 固定向量（iat 为 2024 年）应只因过期被拒绝
	if ok, reason := VerifySolution(vectorPrefix, vectorSig, vectorNonce, 500, vectorIP); ok || reason != "challenge expired" {
		t.Errorf("固定向量应因过期被拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 2. 相同载荷、相同序列化口径，但签发时间改为当前：应一路走到工作量校验
	prefix, sig := makeSignedPrefix(t, vectorSecret, "dGVzdC1jaGFsbGVuZ2U", vectorIP, time.Now().UnixMilli())
	if prefix == vectorPrefix {
		t.Fatalf("前置条件：iat 变化后前缀应不同")
	}
	if !constantTimeEqual(hashVerifyIP(vectorIP, vectorSecret), vectorIPHash) {
		t.Fatalf("IP 哈希向量漂移")
	}
	if ok, reason := VerifySolution(prefix, sig, vectorNonce, 500, vectorIP); ok || reason != "insufficient work" {
		t.Errorf("签名/载荷/时效/IP/时序校验应全部通过，仅因工作量不足被拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 3. 跨 IP 必须被拒绝（用同一前缀）
	if ok, reason := VerifySolution(prefix, sig, vectorNonce, 500, "10.0.0.1"); ok || reason != "ip mismatch" {
		t.Errorf("跨 IP 应以 ip mismatch 拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 4. 用向量密钥解出真实答案后应通过校验
	vectorDifficulty := 8
	nonce := solveNonce(t, prefix, vectorDifficulty)
	if ok, reason := VerifySolution(prefix, sig, nonce, 500, vectorIP); !ok {
		t.Errorf("用向量密钥求解后应通过校验，reason=%q", reason)
	}
}
