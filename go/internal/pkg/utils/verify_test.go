package utils

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math/bits"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

// sha256Bytes 返回 SHA-256 摘要字节，供测试自行计算工作量证明
func sha256Bytes(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// countLeadingZeroBits 是 leadingZeroBits 的测试侧独立实现，
// 用于在测试里自行计算工作量证明答案（避免与生产实现共享同一处可能的错误）。
func countLeadingZeroBits(sum []byte) int {
	total := 0
	for _, b := range sum {
		if b == 0 {
			total += 8
			continue
		}
		total += bits.LeadingZeros8(b)
		break
	}
	return total
}

// solveNonce 求出一个满足指定前导 0 比特数要求的 nonce，限定次数内找不到则终止用例
func solveNonce(t *testing.T, prefix string, difficulty int) int64 {
	t.Helper()
	for nonce := int64(0); nonce < 5_000_000; nonce++ {
		if countLeadingZeroBits(sha256Bytes(fmt.Sprintf("%s:%d", prefix, nonce))) >= difficulty {
			return nonce
		}
	}
	t.Fatalf("无法在限定次数内解出难度 %d 的挑战", difficulty)
	return -1
}

// findInsufficientNonce 找出一个工作量不达标的 nonce
func findInsufficientNonce(t *testing.T, prefix string, difficulty int) int64 {
	t.Helper()
	for nonce := int64(0); nonce < 1_000_000; nonce++ {
		if countLeadingZeroBits(sha256Bytes(fmt.Sprintf("%s:%d", prefix, nonce))) < difficulty {
			return nonce
		}
	}
	t.Fatalf("无法找到工作量不达标的 nonce（难度 %d 过低？）", difficulty)
	return -1
}

// makeChallengePrefix 按生产口径构造挑战前缀
func makeChallengePrefix(t *testing.T, cid, iph string, iat int64) string {
	t.Helper()
	raw, err := json.Marshal(verifyChallengePayload{Cid: cid, Iph: iph, Iat: iat})
	if err != nil {
		t.Fatalf("序列化挑战载荷失败: %v", err)
	}
	return b64urlEncode(raw)
}

// makeSignedPrefix 构造前缀并给出正确签名
func makeSignedPrefix(t *testing.T, secret, cid, ip string, iat int64) (prefix, sig string) {
	t.Helper()
	prefix = makeChallengePrefix(t, cid, hashVerifyIP(ip, secret), iat)
	return prefix, hmacSHA256(prefix, secret)
}

// makeTicket 按生产口径签发票据（可自定义版本/有效期等字段，便于构造异常票据）
func makeTicket(t *testing.T, secret string, payload verifyTicketPayload) string {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("序列化票据载荷失败: %v", err)
	}
	body := b64urlEncode(raw)
	return body + "." + hmacSHA256(body, secret)
}

func setTestDifficulty(t *testing.T, value string) {
	t.Helper()
	setSetting(t, "comment_verify_difficulty", value)
}

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

func TestGetVerifyDifficulty(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *string
		want  int
	}{
		{"未配置时使用默认难度 18", nil, defaultVerifyDifficulty},
		{"空串使用默认难度", strPtr(""), defaultVerifyDifficulty},
		{"合法取值", strPtr("20"), 20},
		{"下界 8", strPtr("8"), 8},
		{"低于下界被夹到 8", strPtr("7"), minVerifyDifficulty},
		{"0 被夹到 8", strPtr("0"), minVerifyDifficulty},
		{"负数被夹到 8", strPtr("-5"), minVerifyDifficulty},
		{"上界 26", strPtr("26"), 26},
		{"高于上界被夹到 26", strPtr("27"), maxVerifyDifficulty},
		{"超大值被夹到 26", strPtr("999999"), maxVerifyDifficulty},
		{"非数字回退默认", strPtr("abc"), defaultVerifyDifficulty},
		{"带尾随字符回退默认", strPtr("18abc"), defaultVerifyDifficulty},
		{"带空格回退默认", strPtr(" 18"), defaultVerifyDifficulty},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			if tc.value != nil {
				setTestDifficulty(t, *tc.value)
			}
			if got := GetVerifyDifficulty(); got != tc.want {
				t.Errorf("期望 %d，实际 %d", tc.want, got)
			}
		})
	}
}

func TestIsVerifyEnabled(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *string
		want  bool
	}{
		{"未配置时默认关闭", nil, false},
		{"空值关闭", strPtr(""), false},
		{"true 开启", strPtr("true"), true},
		{"false 关闭", strPtr("false"), false},
		{"True 不识别（严格匹配）", strPtr("True"), false},
		{"1 不识别（严格匹配）", strPtr("1"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			if tc.value != nil {
				setSetting(t, settingVerifyEnabled, *tc.value)
			}
			if got := IsVerifyEnabled(); got != tc.want {
				t.Errorf("期望 %v，实际 %v", tc.want, got)
			}
		})
	}
}

func TestTicketTTLSeconds(t *testing.T) {
	if TicketTTLSeconds != 300 {
		t.Errorf("票据有效期应为 300 秒，实际 %d", TicketTTLSeconds)
	}
	if int(challengeTTL/time.Second) != 600 {
		t.Errorf("挑战有效期应为 600 秒，实际 %d", int(challengeTTL/time.Second))
	}
}

func TestGetPublicVerifyConfig(t *testing.T) {
	resetSettings(t)

	enabled, honeypot := GetPublicVerifyConfig("/posts/a")
	if enabled != "false" || honeypot != "" {
		t.Errorf("关闭状态应返回 (false, \"\")，实际 (%q, %q)", enabled, honeypot)
	}
	requireSetting(t, settingVerifySecret, "") // 关闭时不应生成/写入密钥

	setSetting(t, settingVerifyEnabled, "true")
	enabled, honeypot = GetPublicVerifyConfig("/posts/a")
	if enabled != "true" {
		t.Errorf("开启状态应返回 true，实际 %q", enabled)
	}
	if honeypot != honeypotFieldName("/posts/a", getVerifySecret()) {
		t.Errorf("蜜罐字段名应与内部算法一致，实际 %q", honeypot)
	}
	if !strings.HasPrefix(honeypot, "v_") || len(honeypot) != 12 {
		t.Errorf("蜜罐字段名应形如 v_ + 10 位十六进制，实际 %q", honeypot)
	}
}

func TestHoneypotFieldName(t *testing.T) {
	secret := "test-secret"

	a := honeypotFieldName("/posts/a", secret)
	if a != honeypotFieldName("/posts/a", secret) {
		t.Errorf("同一 slug 的蜜罐字段名必须稳定")
	}
	if a == honeypotFieldName("/posts/b", secret) {
		t.Errorf("不同 slug 的蜜罐字段名应不同")
	}
	if a == honeypotFieldName("/posts/a", secret+"x") {
		t.Errorf("不同密钥的蜜罐字段名应不同")
	}
	if !strings.HasPrefix(a, "v_") {
		t.Errorf("蜜罐字段名应以 v_ 开头，实际 %q", a)
	}
}

// ---------------------------------------------------------------------------
// 挑战签发
// ---------------------------------------------------------------------------

func TestCreateVerifyChallenge(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "16")

	challenge, err := CreateVerifyChallenge("1.2.3.4")
	if err != nil {
		t.Fatalf("签发挑战失败: %v", err)
	}

	if challenge.ChallengeID == "" || challenge.Prefix == "" || challenge.Sig == "" {
		t.Fatalf("挑战字段不应为空: %+v", challenge)
	}
	if challenge.Difficulty != 16 {
		t.Errorf("难度应来自设置（16），实际 %d", challenge.Difficulty)
	}
	if challenge.ExpiresIn != 600 {
		t.Errorf("挑战有效期应为 600 秒，实际 %d", challenge.ExpiresIn)
	}
	if challenge.Sig != hmacSHA256(challenge.Prefix, getVerifySecret()) {
		t.Errorf("挑战签名与密钥不匹配")
	}

	raw, err := b64urlDecode(challenge.Prefix)
	if err != nil {
		t.Fatalf("前缀必须是合法的 base64url: %v", err)
	}
	var payload verifyChallengePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("前缀必须是合法的 JSON 载荷: %v", err)
	}
	if payload.Cid != challenge.ChallengeID {
		t.Errorf("ChallengeID 应与载荷 cid 一致，%q != %q", challenge.ChallengeID, payload.Cid)
	}
	if payload.Iph != hashVerifyIP("1.2.3.4", getVerifySecret()) {
		t.Errorf("载荷中的 IP 哈希与请求 IP 不匹配")
	}
	if age := time.Now().UnixMilli() - payload.Iat; age < -1000 || age > 5000 {
		t.Errorf("签发时间应接近当前时间，偏差 %d 毫秒", age)
	}

	// 不同 IP / 不同次签发应产生不同挑战
	other, err := CreateVerifyChallenge("1.2.3.4")
	if err != nil {
		t.Fatalf("二次签发挑战失败: %v", err)
	}
	if other.ChallengeID == challenge.ChallengeID {
		t.Errorf("两次签发的 challenge_id 不应相同")
	}
	if other.Prefix == challenge.Prefix {
		t.Errorf("两次签发的 prefix 不应相同")
	}

	third, err := CreateVerifyChallenge("5.6.7.8")
	if err != nil {
		t.Fatalf("异 IP 签发挑战失败: %v", err)
	}
	if third.ChallengeID == challenge.ChallengeID {
		t.Errorf("不同 IP 的 challenge_id 不应相同")
	}
}

// ---------------------------------------------------------------------------
// 答案校验
// ---------------------------------------------------------------------------

func TestVerifySolutionHappyPath(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	prefix, sig := makeSignedPrefix(t, secret, "cid-happy", ip, time.Now().UnixMilli())
	nonce := solveNonce(t, prefix, 8)

	ok, reason := VerifySolution(prefix, sig, nonce, 500, ip)
	if !ok {
		t.Fatalf("正确解答应通过校验，reason=%q", reason)
	}
	if reason != "" {
		t.Errorf("通过时 reason 应为空串，实际 %q", reason)
	}
}

func TestVerifySolutionMissingInput(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	prefix, sig := makeSignedPrefix(t, secret, "cid-missing", "1.2.3.4", time.Now().UnixMilli())

	for _, tc := range []struct {
		name   string
		prefix string
		sig    string
	}{
		{"前缀与签名都为空", "", ""},
		{"前缀为空", "", sig},
		{"签名为空", prefix, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := VerifySolution(tc.prefix, tc.sig, 1, 500, "1.2.3.4")
			if ok {
				t.Errorf("缺少必要输入时不应通过")
			}
			if reason != "missing challenge" {
				t.Errorf("拒绝原因应为 missing challenge，实际 %q", reason)
			}
		})
	}
}

func TestVerifySolutionBadSignature(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	prefix, sig := makeSignedPrefix(t, secret, "cid-sig", ip, time.Now().UnixMilli())
	nonce := solveNonce(t, prefix, 8)

	for _, tc := range []struct {
		name string
		sig  string
	}{
		{"签名被篡改", sig[:len(sig)-2] + "aa"},
		{"签名被截断", sig[:len(sig)-1]},
		{"用错误密钥签名", hmacSHA256(prefix, secret+"x")},
		{"空签名以外的随机串", strings.Repeat("A", len(sig))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := VerifySolution(prefix, tc.sig, nonce, 500, ip)
			if ok {
				t.Errorf("签名校验失败时不应通过")
			}
			if reason != "bad signature" {
				t.Errorf("拒绝原因应为 bad signature，实际 %q", reason)
			}
		})
	}
}

func TestVerifySolutionMalformedPayload(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")
	secret := getVerifySecret()

	for _, tc := range []struct {
		name  string
		body  string
		ip    string
		nonce int64
	}{
		{"不是 JSON", "not-json", "1.2.3.4", 0},
		{"是合法 JSON 但缺少 cid", `{"iph":"abc","iat":1700000000000}`, "1.2.3.4", 0},
		{"是合法 JSON 但缺少 iph", `{"cid":"c","iat":1700000000000}`, "1.2.3.4", 0},
		{"空 JSON 对象", `{}`, "1.2.3.4", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix := b64urlEncode([]byte(tc.body))
			sig := hmacSHA256(prefix, secret) // 签名正确，问题只出在载荷
			ok, reason := VerifySolution(prefix, sig, tc.nonce, 500, tc.ip)
			if ok {
				t.Errorf("载荷非法时不应通过")
			}
			if reason != "malformed payload" {
				t.Errorf("拒绝原因应为 malformed payload，实际 %q", reason)
			}
		})
	}
}

func TestVerifySolutionExpiry(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	now := time.Now().UnixMilli()

	for _, tc := range []struct {
		name       string
		iat        int64
		wantOK     bool
		wantReason string
	}{
		{"恰好过期（超出 10 分钟）", now - int64(challengeTTL/time.Millisecond) - 1, false, "challenge expired"},
		{"过期 1 小时", now - 60*60*1000, false, "challenge expired"},
		{"未来 61 秒（超容忍窗口）", now + 61*1000, false, "challenge from the future"},
		{"未来 1 小时", now + 60*60*1000, false, "challenge from the future"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix, sig := makeSignedPrefix(t, secret, "cid-exp-"+tc.name, ip, tc.iat)
			nonce := solveNonce(t, prefix, 8)
			ok, reason := VerifySolution(prefix, sig, nonce, 500, ip)
			if ok != tc.wantOK {
				t.Fatalf("期望 ok=%v，实际 %v（reason=%q）", tc.wantOK, ok, reason)
			}
			if reason != tc.wantReason {
				t.Errorf("拒绝原因应为 %q，实际 %q", tc.wantReason, reason)
			}
		})
	}

	// 未来 30 秒在容忍窗口内，不应因为时间原因被拒绝
	prefix, sig := makeSignedPrefix(t, secret, "cid-exp-tolerated", ip, now+30*1000)
	nonce := solveNonce(t, prefix, 8)
	if ok, reason := VerifySolution(prefix, sig, nonce, 500, ip); !ok {
		t.Errorf("未来 30 秒的挑战应在容忍窗口内通过，reason=%q", reason)
	}
}

func TestVerifySolutionIPBinding(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	prefix, sig := makeSignedPrefix(t, secret, "cid-ip", "1.2.3.4", time.Now().UnixMilli())
	nonce := solveNonce(t, prefix, 8)

	for _, tc := range []struct {
		name string
		ip   string
	}{
		{"其他 IPv4", "1.2.3.5"},
		{"同网段其他地址", "1.2.3.255"},
		{"IPv6", "2001:db8::1"},
		{"空 IP", ""},
		{"IP 不归一化（IPv4-mapped）", "::ffff:1.2.3.4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := VerifySolution(prefix, sig, nonce, 500, tc.ip)
			if ok {
				t.Errorf("IP 不匹配时不应通过（%s）", tc.ip)
			}
			if reason != "ip mismatch" {
				t.Errorf("拒绝原因应为 ip mismatch，实际 %q", reason)
			}
		})
	}

	if ok, reason := VerifySolution(prefix, sig, nonce, 500, "1.2.3.4"); !ok {
		t.Errorf("原 IP 应通过，reason=%q", reason)
	}
}

func TestVerifySolutionTiming(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	minMs := int64(minSolveDuration / time.Millisecond) // 300
	maxMs := int64(maxSolveDuration / time.Millisecond) // 600000

	for _, tc := range []struct {
		name       string
		elapsed    int64
		wantOK     bool
		wantReason string
	}{
		{"0 毫秒（脚本瞬间完成）", 0, false, "implausible timing"},
		{"负数", -1, false, "implausible timing"},
		{"低于下限 1 毫秒", minMs - 1, false, "implausible timing"},
		{"恰好等于下限", minMs, true, ""},
		{"恰好等于上限", maxMs, true, ""},
		{"超出上限 1 毫秒", maxMs + 1, false, "implausible timing"},
		{"远超上限", maxMs * 10, false, "implausible timing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix, sig := makeSignedPrefix(t, secret, "cid-time-"+tc.name, ip, time.Now().UnixMilli())
			nonce := solveNonce(t, prefix, 8)
			ok, reason := VerifySolution(prefix, sig, nonce, tc.elapsed, ip)
			if ok != tc.wantOK {
				t.Fatalf("elapsed=%d 期望 ok=%v，实际 %v（reason=%q）", tc.elapsed, tc.wantOK, ok, reason)
			}
			if reason != tc.wantReason {
				t.Errorf("拒绝原因应为 %q，实际 %q", tc.wantReason, reason)
			}
		})
	}
}

func TestVerifySolutionNonce(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	ip := "1.2.3.4"

	t.Run("负数 nonce 直接拒绝", func(t *testing.T) {
		prefix, sig := makeSignedPrefix(t, secret, "cid-neg", ip, time.Now().UnixMilli())
		ok, reason := VerifySolution(prefix, sig, -1, 500, ip)
		if ok || reason != "bad nonce" {
			t.Errorf("负数 nonce 应以 bad nonce 拒绝，实际 ok=%v reason=%q", ok, reason)
		}
	})

	t.Run("工作量不足拒绝", func(t *testing.T) {
		prefix, sig := makeSignedPrefix(t, secret, "cid-work", ip, time.Now().UnixMilli())
		nonce := findInsufficientNonce(t, prefix, 8)
		ok, reason := VerifySolution(prefix, sig, nonce, 500, ip)
		if ok || reason != "insufficient work" {
			t.Errorf("工作量不足应以 insufficient work 拒绝，实际 ok=%v reason=%q", ok, reason)
		}
	})

	t.Run("nonce 为 0 时按实际工作量判定", func(t *testing.T) {
		prefix, sig := makeSignedPrefix(t, secret, "cid-zero", ip, time.Now().UnixMilli())
		ok, reason := VerifySolution(prefix, sig, 0, 500, ip)
		wantOK := countLeadingZeroBits(sha256Bytes(prefix+":0")) >= 8
		if ok != wantOK {
			t.Errorf("nonce=0 时 ok 应与工作量判定一致，期望 %v 实际 %v（reason=%q）", wantOK, ok, reason)
		}
	})
}

func TestVerifySolutionReplay(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	prefix, sig := makeSignedPrefix(t, secret, "cid-replay", ip, time.Now().UnixMilli())
	nonce := solveNonce(t, prefix, 8)

	if ok, reason := VerifySolution(prefix, sig, nonce, 500, ip); !ok {
		t.Fatalf("首次提交应通过，reason=%q", reason)
	}
	ok, reason := VerifySolution(prefix, sig, nonce, 500, ip)
	if ok {
		t.Errorf("同一个挑战 + 同一个 nonce 不应被重复接受（防重放）")
	}
	if reason != "replayed nonce" {
		t.Errorf("拒绝原因应为 replayed nonce，实际 %q", reason)
	}

	// 换一个 nonce 仍可通过（同一挑战允许重算）
	other := solveNonce(t, prefix, 8)
	if other == nonce {
		// 理论上不会发生，稳妥起见再找一个
		other = nonce + 1
	}
	if ok, reason := VerifySolution(prefix, sig, other, 500, ip); !ok && reason == "replayed nonce" {
		t.Errorf("不同 nonce 不应被判为重放，reason=%q", reason)
	}
}

func TestVerifySolutionDifficultyFromSettings(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	prefix, sig := makeSignedPrefix(t, secret, "cid-diff", ip, time.Now().UnixMilli())
	nonce8 := solveNonce(t, prefix, 8)

	if ok, reason := VerifySolution(prefix, sig, nonce8, 500, ip); !ok {
		t.Fatalf("难度 8 时应通过，reason=%q", reason)
	}

	// 提高难度后，同一挑战重新签发并解答：8 位的答案必须被判为工作量不足
	setTestDifficulty(t, "12")
	prefix2, sig2 := makeSignedPrefix(t, secret, "cid-diff2", ip, time.Now().UnixMilli())
	if ok, reason := VerifySolution(prefix2, sig2, findInsufficientNonce(t, prefix2, 12), 500, ip); ok || reason != "insufficient work" {
		t.Errorf("难度 12 时 8 位答案应被拒绝，实际 ok=%v reason=%q", ok, reason)
	}
	if ok, reason := VerifySolution(prefix2, sig2, solveNonce(t, prefix2, 12), 500, ip); !ok {
		t.Errorf("难度 12 时满足条件的答案应通过，reason=%q", reason)
	}
}

func TestVerifySolutionUsesDifferentSecret(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "8")

	// 用与生产密钥不同的密钥签名，必须被拒绝
	ip := "1.2.3.4"
	prefix := makeChallengePrefix(t, "cid-secret", hashVerifyIP(ip, "other-secret"), time.Now().UnixMilli())
	sig := hmacSHA256(prefix, "other-secret")

	if ok, reason := VerifySolution(prefix, sig, 0, 500, ip); ok || reason != "bad signature" {
		t.Errorf("异密钥签名应以 bad signature 拒绝，实际 ok=%v reason=%q", ok, reason)
	}
}

// ---------------------------------------------------------------------------
// 票据
// ---------------------------------------------------------------------------

func TestCreateAndVerifyTicket(t *testing.T) {
	resetSettings(t)

	ip := "1.2.3.4"
	slug := "/posts/hello"

	ticket, err := CreateVerifyTicket(ip, slug)
	if err != nil {
		t.Fatalf("签发票据失败: %v", err)
	}
	if strings.Count(ticket, ".") != 1 {
		t.Fatalf("票据格式应为 body.sig，实际 %q", ticket)
	}
	body, sig, _ := strings.Cut(ticket, ".")
	if body == "" || sig == "" {
		t.Fatalf("票据两段都不应为空: %q", ticket)
	}
	if sig != hmacSHA256(body, getVerifySecret()) {
		t.Errorf("票据签名与密钥不匹配")
	}

	raw, err := b64urlDecode(body)
	if err != nil {
		t.Fatalf("票据 body 必须是合法 base64url: %v", err)
	}
	var payload verifyTicketPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("票据载荷必须是合法 JSON: %v", err)
	}
	if payload.V != 1 {
		t.Errorf("票据版本应为 1，实际 %d", payload.V)
	}
	if payload.Slug != slug {
		t.Errorf("票据 slug 应为 %q，实际 %q", slug, payload.Slug)
	}
	if payload.Iph != hashVerifyIP(ip, getVerifySecret()) {
		t.Errorf("票据 IP 哈希不匹配")
	}
	if payload.Jti == "" {
		t.Errorf("票据应包含随机 jti")
	}
	if delta := payload.Exp - payload.Iat; delta != int64(ticketTTL/time.Millisecond) {
		t.Errorf("票据有效期应为 %d 毫秒，实际 %d", int64(ticketTTL/time.Millisecond), delta)
	}

	if !VerifyTicket(ticket, ip, slug) {
		t.Errorf("自己签发的票据应通过校验")
	}
	if VerifyTicket(ticket, "9.9.9.9", slug) {
		t.Errorf("票据不应跨 IP 有效")
	}
	if VerifyTicket(ticket, ip, "/posts/other") {
		t.Errorf("票据不应跨文章有效")
	}
	if VerifyTicket(ticket, ip, "") {
		t.Errorf("空 slug 不应通过")
	}
}

func TestVerifyTicketMalformed(t *testing.T) {
	resetSettings(t)
	secret := getVerifySecret()

	for _, tc := range []struct {
		name   string
		ticket string
	}{
		{"空票据", ""},
		{"没有分隔点", "nodot"},
		{"分隔点在开头", ".abcdef"},
		{"分隔点在结尾", "abcdef."},
		{"body 不是合法 base64url", "!!!." + hmacSHA256("!!!", secret)},
		{"body 合法 base64 但不是 JSON", b64urlEncode([]byte("not-json")) + "." + hmacSHA256(b64urlEncode([]byte("not-json")), secret)},
		{"签名被篡改", "abcdef." + strings.Repeat("A", 43)},
		{"多个分隔点（取最后一个）", "a.b.c"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if VerifyTicket(tc.ticket, "1.2.3.4", "/posts/a") {
				t.Errorf("非法票据 %q 不应通过校验", tc.ticket)
			}
		})
	}
}

func TestVerifyTicketPayloadChecks(t *testing.T) {
	resetSettings(t)
	secret := getVerifySecret()
	ip := "1.2.3.4"
	slug := "/posts/a"
	now := time.Now().UnixMilli()

	base := verifyTicketPayload{
		V: 1, Iph: hashVerifyIP(ip, secret), Slug: slug,
		Iat: now, Exp: now + int64(ticketTTL/time.Millisecond), Jti: "jti",
	}

	for _, tc := range []struct {
		name    string
		mutate  func(p *verifyTicketPayload)
		wantOK  bool
		comment string
	}{
		{"正常票据", func(p *verifyTicketPayload) {}, true, ""},
		{"版本号不为 1", func(p *verifyTicketPayload) { p.V = 2 }, false, ""},
		{"版本号为 0", func(p *verifyTicketPayload) { p.V = 0 }, false, ""},
		{"缺少过期时间", func(p *verifyTicketPayload) { p.Exp = 0 }, false, ""},
		{"已过期", func(p *verifyTicketPayload) { p.Exp = now - 1000 }, false, ""},
		{"过期时间为负数", func(p *verifyTicketPayload) { p.Exp = -1 }, false, ""},
		{"slug 不匹配", func(p *verifyTicketPayload) { p.Slug = "/posts/b" }, false, ""},
		{"IP 哈希不匹配", func(p *verifyTicketPayload) { p.Iph = hashVerifyIP("9.9.9.9", secret) }, false, ""},
		{"IP 哈希为空", func(p *verifyTicketPayload) { p.Iph = "" }, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := base
			tc.mutate(&p)
			ticket := makeTicket(t, secret, p)
			if got := VerifyTicket(ticket, ip, slug); got != tc.wantOK {
				t.Errorf("期望 %v，实际 %v（%s）", tc.wantOK, got, tc.comment)
			}
		})
	}
}

func TestVerifyTicketExpiryBoundary(t *testing.T) {
	resetSettings(t)
	secret := getVerifySecret()
	ip := "1.2.3.4"
	slug := "/posts/a"
	now := time.Now().UnixMilli()

	soon := makeTicket(t, secret, verifyTicketPayload{
		V: 1, Iph: hashVerifyIP(ip, secret), Slug: slug,
		Iat: now, Exp: now + 80, Jti: "jti",
	})
	if !VerifyTicket(soon, ip, slug) {
		t.Fatalf("尚未过期的票据应通过校验")
	}

	time.Sleep(200 * time.Millisecond)

	if VerifyTicket(soon, ip, slug) {
		t.Errorf("已过期的票据不应再通过校验")
	}
}

func TestVerifyTicketWrongSecret(t *testing.T) {
	resetSettings(t)
	ip := "1.2.3.4"
	slug := "/posts/a"

	ticket := makeTicket(t, "attacker-secret", verifyTicketPayload{
		V: 1, Iph: hashVerifyIP(ip, "attacker-secret"), Slug: slug,
		Iat: time.Now().UnixMilli(), Exp: time.Now().UnixMilli() + 60000, Jti: "jti",
	})
	if VerifyTicket(ticket, ip, slug) {
		t.Errorf("使用其他密钥签发的票据不应通过校验")
	}
}

// ---------------------------------------------------------------------------
// 编码 / 哈希辅助
// ---------------------------------------------------------------------------

func TestB64UrlEncodeDecode(t *testing.T) {
	for _, tc := range []struct {
		name    string
		input   []byte
		encoded string
	}{
		{"空字节", []byte{}, ""},
		{"hello", []byte("hello"), "aGVsbG8"},
		{"JSON 载荷", []byte(`{"a":1}`), "eyJhIjoxfQ"},
		{"含非 ASCII 字节", []byte{0xfb, 0xff}, "-_8"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := b64urlEncode(tc.input); got != tc.encoded {
				t.Errorf("编码 %v 期望 %q，实际 %q", tc.input, tc.encoded, got)
			}
			decoded, err := b64urlDecode(tc.encoded)
			if err != nil {
				t.Fatalf("解码 %q 失败: %v", tc.encoded, err)
			}
			if string(decoded) != string(tc.input) {
				t.Errorf("解码往返不一致: %v != %v", decoded, tc.input)
			}
		})
	}

	// 容忍带填充的输入
	for _, padded := range []string{"aGVsbG8=", "aGVsbG8==", "aGVsbG8==="} {
		if got, err := b64urlDecode(padded); err != nil || string(got) != "hello" {
			t.Errorf("应容忍带填充的 base64url %q，got=%q err=%v", padded, got, err)
		}
	}

	// 无填充输出：不得出现 = + /
	raw := make([]byte, 96)
	for i := range raw {
		raw[i] = byte(i * 7)
	}
	encoded := b64urlEncode(raw)
	if strings.ContainsAny(encoded, "=+/") {
		t.Errorf("base64url 输出不得包含 = + /，实际 %q", encoded)
	}
	if decoded, err := b64urlDecode(encoded); err != nil || string(decoded) != string(raw) {
		t.Errorf("随机字节往返失败: err=%v", err)
	}

	// 非法输入必须报错
	for _, bad := range []string{"!!!", "a", "aGVsbG8*"} {
		if _, err := b64urlDecode(bad); err == nil {
			t.Errorf("非法 base64url %q 应返回错误", bad)
		}
	}
}

func TestConstantTimeEqual(t *testing.T) {
	for _, tc := range []struct {
		name string
		a    string
		b    string
		want bool
	}{
		{"相同", "abcdef", "abcdef", true},
		{"都为空", "", "", true},
		{"不同", "abcdef", "abcdeg", false},
		{"长度不同", "abcdef", "abcde", false},
		{"空前缀", "", "abc", false},
		{"大小写不同", "ABC", "abc", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := constantTimeEqual(tc.a, tc.b); got != tc.want {
				t.Errorf("constantTimeEqual(%q,%q) 期望 %v，实际 %v", tc.a, tc.b, tc.want, got)
			}
		})
	}
}

func TestSha256Hex(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  string
	}{
		{"空串", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
		{"abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := sha256Hex(tc.input)
			if len(got) != 64 {
				t.Errorf("SHA-256 十六进制串应为 64 字符，实际 %d", len(got))
			}
			if got != tc.want {
				t.Errorf("sha256Hex(%q) 期望 %q，实际 %q", tc.input, tc.want, got)
			}
		})
	}

	t.Run("多字节输入稳定且为小写十六进制", func(t *testing.T) {
		got := sha256Hex("微博评论")
		if got != sha256Hex("微博评论") {
			t.Errorf("同一输入必须得到相同哈希")
		}
		if strings.ToLower(got) != got {
			t.Errorf("哈希应为小写十六进制，实际 %q", got)
		}
		if got == sha256Hex("微博评论 ") {
			t.Errorf("不同输入应得到不同哈希")
		}
	})
}

func TestLeadingZeroBits(t *testing.T) {
	for _, tc := range []struct {
		name string
		sum  []byte
		want int
	}{
		{"首字节全 1", []byte{0xff}, 0},
		{"首字节 0x01", []byte{0x01}, 7},
		{"首字节 0x0f", []byte{0x0f}, 4},
		{"首字节 0x10", []byte{0x10}, 3},
		{"整字节为 0", []byte{0x00, 0xff}, 8},
		{"两个整字节为 0", []byte{0x00, 0x00, 0x10}, 19},
		{"全为 0", []byte{0x00, 0x00}, 16},
		{"空数组", []byte{}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := leadingZeroBits(tc.sum); got != tc.want {
				t.Errorf("leadingZeroBits(%v) 期望 %d，实际 %d", tc.sum, tc.want, got)
			}
			if got := countLeadingZeroBits(tc.sum); got != tc.want {
				t.Errorf("测试侧实现与期望不一致: %d != %d", got, tc.want)
			}
		})
	}
}

func TestHashVerifyIP(t *testing.T) {
	secret := "s3cret"

	got := hashVerifyIP("1.2.3.4", secret)
	if len(got) != 16 {
		t.Errorf("IP 哈希应截取 16 位十六进制，实际 %d 位（%q）", len(got), got)
	}
	if got != hashVerifyIP("1.2.3.4", secret) {
		t.Errorf("同一 IP + 同一密钥必须得到相同哈希")
	}
	if got == hashVerifyIP("1.2.3.5", secret) {
		t.Errorf("不同 IP 应得到不同哈希")
	}
	if got == hashVerifyIP("1.2.3.4", secret+"x") {
		t.Errorf("不同密钥应得到不同哈希")
	}
	if strings.Contains(got, "1.2.3.4") {
		t.Errorf("哈希结果不得包含明文 IP")
	}
}
