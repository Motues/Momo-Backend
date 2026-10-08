package utils

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/bits"
	"strings"
	"sync"
	"time"
)

/*
评论区「无感验证」（Turnstile 风格）— Go 实现

与 Node.js / Worker 版本保持接口与算法完全一致：
  - 零数据库结构改动（复用 Settings 表存放自动生成的签名密钥）
  - 无状态票据：HMAC 签名 + IP 绑定 + 有效期
  - 工作量证明：浏览器静默计算

跨语言一致性约定：
  - base64url 使用无填充（RawURLEncoding）
  - 哈希/签名的输入串与 JSON 字段名必须与 Node 版本逐字节相同
*/

const (
	settingVerifyEnabled    = "comment_verify_enabled"
	settingVerifyDifficulty = "comment_verify_difficulty"
	settingVerifySecret     = "comment_verify_secret"

	defaultVerifyDifficulty = 18
	minVerifyDifficulty     = 8
	maxVerifyDifficulty     = 26

	challengeTTL     = 10 * time.Minute
	ticketTTL        = 5 * time.Minute
	minSolveDuration = 300 * time.Millisecond
	maxSolveDuration = 10 * time.Minute
)

// TicketTTLSeconds 票据有效期（秒），供接口返回值使用
const TicketTTLSeconds = int(ticketTTL / time.Second)

var (
	verifySecretOnce sync.Once
	verifySecretVal  string

	usedNoncesMu sync.Mutex
	usedNonces   = make(map[string]int64)
)

// ---------- 编解码辅助 ----------

// b64urlEncode 无填充 base64url 编码，与 JS 端的 base64url 输出一致
func b64urlEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// b64urlDecode 容忍带填充/不带填充的 base64url 输入
func b64urlDecode(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	return base64.RawURLEncoding.DecodeString(s)
}

// hmacSHA256 b64url(HMAC-SHA256(data, secret))
func hmacSHA256(data, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return b64urlEncode(mac.Sum(nil))
}

// constantTimeEqual 常数时间比较两个字符串
func constantTimeEqual(a, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}

// sha256Hex 十六进制 SHA-256
func sha256Hex(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

// ---------- 密钥 ----------

// getVerifySecret 获取签名密钥，首次调用时自动生成并持久化到 Settings 表
func getVerifySecret() string {
	verifySecretOnce.Do(func() {
		if existing := GetSetting(settingVerifySecret); existing != "" {
			verifySecretVal = existing
			return
		}
		random := make([]byte, 32)
		if _, err := rand.Read(random); err != nil {
			// 极端情况下退化为时间派生，仍然可用但不理想
			verifySecretVal = sha256Hex(fmt.Sprintf("fallback:%d", time.Now().UnixNano()))
			return
		}
		generated := hex.EncodeToString(random)
		if err := SetSetting(settingVerifySecret, generated); err != nil {
			// 持久化失败不影响本次运行
			verifySecretVal = generated
			return
		}
		verifySecretVal = generated
	})
	return verifySecretVal
}

// ---------- 对外配置 ----------

// IsVerifyEnabled 是否开启人机验证
func IsVerifyEnabled() bool {
	return GetSetting(settingVerifyEnabled) == "true"
}

// GetVerifyDifficulty 读取难度（前导 0 比特数），做上下限保护
func GetVerifyDifficulty() int {
	raw := GetSetting(settingVerifyDifficulty)
	if raw == "" {
		return defaultVerifyDifficulty
	}
	var parsed int
	if _, err := fmt.Sscanf(raw, "%d", &parsed); err != nil {
		return defaultVerifyDifficulty
	}
	if parsed < minVerifyDifficulty {
		return minVerifyDifficulty
	}
	if parsed > maxVerifyDifficulty {
		return maxVerifyDifficulty
	}
	return parsed
}

// hashVerifyIP IP 加盐哈希，避免明文留存 IP。
// 算法：hex(SHA256("ip:" + secret + ":" + ip)) 取前 16 位
func hashVerifyIP(ip, secret string) string {
	return sha256Hex("ip:" + secret + ":" + ip)[:16]
}

// honeypotFieldName 按文章派生的蜜罐字段名
func honeypotFieldName(postSlug, secret string) string {
	return "v_" + sha256Hex("hp:"+secret+":"+postSlug)[:10]
}

// GetPublicVerifyConfig 供评论列表接口下发给前端的信息
func GetPublicVerifyConfig(postSlug string) (enabled string, honeypot string) {
	// 关闭时直接返回，不做任何密钥生成/写库，保证「默认关闭」零副作用
	if !IsVerifyEnabled() {
		return "false", ""
	}
	return "true", honeypotFieldName(postSlug, getVerifySecret())
}

// ---------- 挑战 ----------

type verifyChallengePayload struct {
	Cid string `json:"cid"`
	Iph string `json:"iph"`
	Iat int64  `json:"iat"`
}

// VerifyChallenge 下发给前端的挑战
type VerifyChallenge struct {
	ChallengeID string `json:"challenge_id"`
	Prefix      string `json:"prefix"`
	Difficulty  int    `json:"difficulty"`
	ExpiresIn   int    `json:"expires_in"`
	Sig         string `json:"sig"`
}

// CreateVerifyChallenge 签发挑战
func CreateVerifyChallenge(ip string) (*VerifyChallenge, error) {
	secret := getVerifySecret()

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}

	payload := verifyChallengePayload{
		Cid: b64urlEncode(random),
		Iph: hashVerifyIP(ip, secret),
		Iat: time.Now().UnixMilli(),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	prefix := b64urlEncode(raw)
	return &VerifyChallenge{
		ChallengeID: payload.Cid,
		Prefix:      prefix,
		Difficulty:  GetVerifyDifficulty(),
		ExpiresIn:   int(challengeTTL / time.Second),
		Sig:         hmacSHA256(prefix, secret),
	}, nil
}

// leadingZeroBits 统计字节数组的前导 0 比特数
func leadingZeroBits(sum []byte) int {
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

func pruneUsedNonces(now int64) {
	cutoff := now - int64(challengeTTL/time.Millisecond)
	for key, ts := range usedNonces {
		if ts < cutoff {
			delete(usedNonces, key)
		}
	}
}

// VerifySolution 校验挑战答案（签名 + 时效 + IP 绑定 + 时序 + 工作量 + 防重放）
// 返回 ok=false 时 reason 为拒绝原因（不对外暴露细节）
func VerifySolution(prefix, sig string, nonce int64, elapsedMs int64, ip string) (bool, string) {
	secret := getVerifySecret()
	now := time.Now().UnixMilli()

	if prefix == "" || sig == "" {
		return false, "missing challenge"
	}

	if !constantTimeEqual(hmacSHA256(prefix, secret), sig) {
		return false, "bad signature"
	}

	raw, err := b64urlDecode(prefix)
	if err != nil {
		return false, "malformed prefix"
	}
	var payload verifyChallengePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false, "malformed payload"
	}
	if payload.Cid == "" || payload.Iph == "" {
		return false, "malformed payload"
	}

	age := now - payload.Iat
	if age > int64(challengeTTL/time.Millisecond) {
		return false, "challenge expired"
	}
	if age < -60*1000 {
		return false, "challenge from the future"
	}

	if !constantTimeEqual(hashVerifyIP(ip, secret), payload.Iph) {
		return false, "ip mismatch"
	}

	if elapsedMs < int64(minSolveDuration/time.Millisecond) || elapsedMs > int64(maxSolveDuration/time.Millisecond) {
		return false, "implausible timing"
	}

	if nonce < 0 {
		return false, "bad nonce"
	}

	difficulty := GetVerifyDifficulty()
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", prefix, nonce)))
	if leadingZeroBits(sum[:]) < difficulty {
		return false, "insufficient work"
	}

	usedNoncesMu.Lock()
	defer usedNoncesMu.Unlock()
	pruneUsedNonces(now)
	replayKey := payload.Cid + ":" + fmt.Sprintf("%d", nonce)
	if _, exists := usedNonces[replayKey]; exists {
		return false, "replayed nonce"
	}
	usedNonces[replayKey] = now

	return true, ""
}

// ---------- 票据 ----------

type verifyTicketPayload struct {
	V    int    `json:"v"`
	Iph  string `json:"iph"`
	Slug string `json:"slug"`
	Iat  int64  `json:"iat"`
	Exp  int64  `json:"exp"`
	Jti  string `json:"jti"`
}

// CreateVerifyTicket 签发通过验证的票据
func CreateVerifyTicket(ip, postSlug string) (string, error) {
	secret := getVerifySecret()

	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}

	now := time.Now().UnixMilli()
	payload := verifyTicketPayload{
		V:    1,
		Iph:  hashVerifyIP(ip, secret),
		Slug: postSlug,
		Iat:  now,
		Exp:  now + int64(ticketTTL/time.Millisecond),
		Jti:  b64urlEncode(random),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	body := b64urlEncode(raw)
	return body + "." + hmacSHA256(body, secret), nil
}

// VerifyTicket 校验票据（供提交评论时调用）
func VerifyTicket(ticket, ip, postSlug string) bool {
	if ticket == "" {
		return false
	}

	secret := getVerifySecret()
	dot := strings.LastIndex(ticket, ".")
	if dot <= 0 {
		return false
	}

	body := ticket[:dot]
	sig := ticket[dot+1:]
	if !constantTimeEqual(hmacSHA256(body, secret), sig) {
		return false
	}

	raw, err := b64urlDecode(body)
	if err != nil {
		return false
	}
	var payload verifyTicketPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}

	if payload.V != 1 {
		return false
	}
	if payload.Exp == 0 || time.Now().UnixMilli() > payload.Exp {
		return false
	}
	if payload.Slug != postSlug {
		return false
	}
	if !constantTimeEqual(hashVerifyIP(ip, secret), payload.Iph) {
		return false
	}

	return true
}
