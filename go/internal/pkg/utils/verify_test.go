package utils

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

// testPostSlug 测试默认文章：绝大多数用例只关心除「文章绑定」以外的分支，
// 因此统一用同一个 slug 签发与兑换；跨文章用例显式传入别的值。
const testPostSlug = "/posts/a"

// makeChallengePrefix 按生产口径构造挑战前缀（协议 v2：v / cid / iph / slug / iat）
func makeChallengePrefix(t *testing.T, cid, iph, slug string, iat int64) string {
	t.Helper()
	raw, err := json.Marshal(verifyChallengePayload{
		V:    VerifyProtocolVersion,
		Cid:  cid,
		Iph:  iph,
		Slug: slug,
		Iat:  &iat,
	})
	if err != nil {
		t.Fatalf("序列化挑战载荷失败: %v", err)
	}
	return b64urlEncode(raw)
}

// makeSignedPrefix 构造前缀并给出正确签名
func makeSignedPrefix(t *testing.T, secret, cid, ip, slug string, iat int64) (prefix, sig string) {
	t.Helper()
	prefix = makeChallengePrefix(t, cid, hashVerifyIP(ip, secret), slug, iat)
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

// solveNoncesFor 按服务端口径重建 spec 并解出全部子挑战的 nonce
func solveNoncesFor(t *testing.T, cid, secret string) []any {
	t.Helper()
	spec, err := buildHashwxSpec(cid, secret)
	if err != nil {
		t.Fatalf("重建 spec 失败: %v", err)
	}
	return hashwxSolve(t, spec)
}

// badNoncesFor 返回一组必然不达标的 nonce
func badNoncesFor(t *testing.T, cid, secret string) []any {
	t.Helper()
	spec, err := buildHashwxSpec(cid, secret)
	if err != nil {
		t.Fatalf("重建 spec 失败: %v", err)
	}
	challenge := ParseHashwxChallenge(spec.C)
	target, err := HashwxTarget(spec.D)
	if err != nil {
		t.Fatalf("target 计算失败: %v", err)
	}
	nonces := make([]any, 0, spec.Count)
	for i := 0; i < spec.Count; i++ {
		var nonce uint64
		for nonce < 5_000_000 {
			seed, err := HashwxBlockSeed(challenge, i, nonce/uint64(spec.N))
			if err != nil {
				t.Fatalf("种子派生失败: %v", err)
			}
			hash, err := HashwxHash(seed, nonce)
			if err != nil {
				t.Fatalf("HashwxHash 失败: %v", err)
			}
			if hash > target {
				break
			}
			nonce++
		}
		nonces = append(nonces, strconv.FormatUint(nonce, 10))
	}
	return nonces
}

func setTestDifficulty(t *testing.T, value string) {
	t.Helper()
	setSetting(t, settingVerifyDifficulty, value)
}

// verifySolution 便捷调用（把测试入参收敛成 VerifySolutionInput）
func verifySolution(t *testing.T, prefix, sig string, nonces []any, elapsedMs int64, ip string) (bool, string) {
	t.Helper()
	return VerifySolution(VerifySolutionInput{
		Prefix:    prefix,
		Sig:       sig,
		Nonces:    mustJSON(t, nonces),
		ElapsedMs: mustJSON(t, elapsedMs),
		IP:        ip,
		PostSlug:  testPostSlug,
	})
}

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

func TestGetVerifyDifficulty(t *testing.T) {
	// 口径要点（与 Node 的 getDifficulty 逐条一致）：
	//
	//   - 解析不出数字、或解析结果 < 1 时**回退默认强度**（1e6），而不是退到下限。
	//     理由：把损坏的配置（例如被误写成 "0"）退到下限 1000 几乎等于关掉防护；
	//     退回默认强度才是安全的失败方向。
	//   - ≤26 的合法值视为 v1 的「前导 0 比特数」，先按 2^值 迁移，再夹到 [1000, 1e9]。
	//   - parseInt 容忍尾部垃圾（"18abc" → 18、"1.5x" → 1），与 v1 的解析行为一致。
	for _, tc := range []struct {
		name  string
		value *string
		want  int
	}{
		{"未配置时使用默认难度", nil, defaultVerifyDifficulty},
		{"空串使用默认难度", strPtr(""), defaultVerifyDifficulty},
		{"合法总次数", strPtr("1000000"), 1_000_000},
		{"下界 1000", strPtr("1000"), 1000},
		{"低于下界被夹到 1000", strPtr("999"), minTotalWork},
		// 与 Node 一致：非法或 < 1 的值回退默认，而不是夹到下限
		{"0 回退默认（配置损坏时退回默认强度才安全）", strPtr("0"), defaultVerifyDifficulty},
		{"负数回退默认", strPtr("-5"), defaultVerifyDifficulty},
		{"上界 1e9", strPtr("1000000000"), maxVerifyDifficulty},
		{"高于上界被夹到 1e9", strPtr("1000000001"), maxVerifyDifficulty},
		{"超大值被夹到 1e9", strPtr("99999999999999"), maxVerifyDifficulty},
		// 旧值迁移：≤26 视为 v1 的前导 0 比特数，按 2^值 换算后再夹到工作区间的下限
		{"旧值 8 迁移为 2^8（低于下限，夹到 1000）", strPtr("8"), minTotalWork},
		{"旧值 16 迁移为 2^16", strPtr("16"), 65536},
		{"旧值 20 迁移为 2^20", strPtr("20"), 1 << 20},
		{"旧值 21 起钳到 2^20", strPtr("21"), legacyMigrationCap},
		{"旧值 26 钳到 2^20", strPtr("26"), legacyMigrationCap},
		{"27 视为总次数（低于下限被夹到 1000）", strPtr("27"), minTotalWork},
		{"非数字回退默认", strPtr("abc"), defaultVerifyDifficulty},
		{"带尾随字符按 parseInt 语义", strPtr("18abc"), 1 << 18},
		{"小数加垃圾按 parseInt 语义（1.5x → 1 → 2 → 下限）", strPtr("1.5x"), minTotalWork},
		{"带空格按 parseInt 语义", strPtr(" 18"), 1 << 18},
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

func TestSecondLayerDefaultsOff(t *testing.T) {
	resetSettings(t)
	if IsInstrumentationEnabled() {
		t.Errorf("comment_verify_instr_enabled 默认应为 false")
	}
	if ShouldBlockAutomated() {
		t.Errorf("comment_verify_block_automated 默认应为 false")
	}

	setSetting(t, settingVerifyInstrEnabled, "true")
	setSetting(t, settingVerifyBlockAutomated, "true")
	if !IsInstrumentationEnabled() {
		t.Errorf("显式开启后 IsInstrumentationEnabled 应为 true")
	}
	if !ShouldBlockAutomated() {
		t.Errorf("显式开启后 ShouldBlockAutomated 应为 true")
	}
}

func TestTicketTTLSeconds(t *testing.T) {
	if TicketTTLSeconds != 300 {
		t.Errorf("票据有效期应为 300 秒，实际 %d", TicketTTLSeconds)
	}
	if int(challengeTTL/time.Second) != 600 {
		t.Errorf("挑战有效期应为 600 秒，实际 %d", int(challengeTTL/time.Second))
	}
	if int(minSolveDuration/time.Millisecond) != 50 {
		t.Errorf("最小解题耗时下限应为 50ms，实际 %d", int(minSolveDuration/time.Millisecond))
	}
	if VerifyProtocolVersion != 2 {
		t.Errorf("协议版本应为 2，实际 %d", VerifyProtocolVersion)
	}
}

func TestGetPublicVerifyConfig(t *testing.T) {
	resetSettings(t)

	enabled, honeypot, version := GetPublicVerifyConfig("/posts/a")
	if enabled != "false" || honeypot != "" {
		t.Errorf("关闭状态应返回 (false, \"\")，实际 (%q, %q)", enabled, honeypot)
	}
	if version != "2" {
		t.Errorf("关闭状态也应下发协议版本 2，实际 %q", version)
	}
	requireSetting(t, settingVerifySecret, "") // 关闭时不应生成/写入密钥

	setSetting(t, settingVerifyEnabled, "true")
	enabled, honeypot, version = GetPublicVerifyConfig("/posts/a")
	if enabled != "true" {
		t.Errorf("开启状态应返回 true，实际 %q", enabled)
	}
	if version != "2" {
		t.Errorf("开启状态协议版本应为 2，实际 %q", version)
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
	setTestDifficulty(t, "1000") // d = 250

	challenge, err := CreateVerifyChallenge("1.2.3.4", testPostSlug)
	if err != nil {
		t.Fatalf("签发挑战失败: %v", err)
	}

	if challenge.ChallengeID == "" || challenge.Prefix == "" || challenge.Sig == "" {
		t.Fatalf("挑战字段不应为空: %+v", challenge)
	}
	if challenge.Pow.Algo != "hashwx" {
		t.Errorf("pow.algo 应为 hashwx，实际 %q", challenge.Pow.Algo)
	}
	if challenge.Pow.D != 250 {
		t.Errorf("难度 1000 按 count=4 均分应得到 d=250，实际 %d", challenge.Pow.D)
	}
	if challenge.Pow.N != HashwxDefaultNoncesPerHash {
		t.Errorf("pow.n 应为 %d，实际 %d", HashwxDefaultNoncesPerHash, challenge.Pow.N)
	}
	if challenge.Pow.Count != HashwxDefaultChallengeCount {
		t.Errorf("pow.count 应为 %d，实际 %d", HashwxDefaultChallengeCount, challenge.Pow.Count)
	}
	if challenge.ExpiresIn != 600 {
		t.Errorf("挑战有效期应为 600 秒，实际 %d", challenge.ExpiresIn)
	}
	if challenge.Sig != hmacSHA256(challenge.Prefix, getVerifySecret()) {
		t.Errorf("挑战签名与密钥不匹配")
	}
	if challenge.Instr != nil {
		t.Errorf("未开启第二层时不应下发程序")
	}

	// c 必须由（密钥, cid）确定性派生
	wantC := sha256Hex("hashwx:C:" + getVerifySecret() + ":" + challenge.ChallengeID)
	if challenge.Pow.C != wantC {
		t.Errorf("pow.c 派生口径漂移:\n got=%s\nwant=%s", challenge.Pow.C, wantC)
	}
	if ParseHashwxChallenge(challenge.Pow.C) == nil {
		t.Errorf("pow.c 必须是合法的 32 字节 hex")
	}

	// 载荷必须是 v2 且字段顺序固定为 v / cid / iph / slug / iat
	raw, err := b64urlDecode(challenge.Prefix)
	if err != nil {
		t.Fatalf("前缀必须是合法的 base64url: %v", err)
	}
	var payload verifyChallengePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("前缀必须是合法的 JSON 载荷: %v", err)
	}
	if payload.V != VerifyProtocolVersion {
		t.Errorf("载荷版本应为 %d，实际 %d", VerifyProtocolVersion, payload.V)
	}
	if payload.Cid != challenge.ChallengeID {
		t.Errorf("ChallengeID 应与载荷 cid 一致，%q != %q", challenge.ChallengeID, payload.Cid)
	}
	if payload.Iph != hashVerifyIP("1.2.3.4", getVerifySecret()) {
		t.Errorf("载荷中的 IP 哈希与请求 IP 不匹配")
	}
	if payload.Slug != testPostSlug {
		t.Errorf("载荷必须把文章签进去，期望 %q，实际 %q", testPostSlug, payload.Slug)
	}
	if payload.Iat == nil {
		t.Fatalf("载荷必须带 iat")
	}
	if age := time.Now().UnixMilli() - *payload.Iat; age < -1000 || age > 5000 {
		t.Errorf("签发时间应接近当前时间，偏差 %d 毫秒", age)
	}
	if !strings.HasPrefix(string(raw), `{"v":2,"cid":`) {
		t.Errorf("载荷字段顺序必须是 v/cid/iph/slug/iat，实际 %s", raw)
	}
	if !strings.Contains(string(raw), `,"slug":"`+testPostSlug+`","iat":`) {
		t.Errorf("载荷字段顺序必须是 v/cid/iph/slug/iat（slug 在 iph 与 iat 之间），实际 %s", raw)
	}

	// 两次签发应得到不同挑战
	other, err := CreateVerifyChallenge("1.2.3.4", testPostSlug)
	if err != nil {
		t.Fatalf("二次签发挑战失败: %v", err)
	}
	if other.ChallengeID == challenge.ChallengeID {
		t.Errorf("两次签发的 challenge_id 不应相同")
	}
	if other.Prefix == challenge.Prefix {
		t.Errorf("两次签发的 prefix 不应相同")
	}
}

func TestCreateVerifyChallengeWithInstrumentation(t *testing.T) {
	resetSettings(t)
	setSetting(t, settingVerifyInstrEnabled, "true")

	challenge, err := CreateVerifyChallenge("1.2.3.4", testPostSlug)
	if err != nil {
		t.Fatalf("签发挑战失败: %v", err)
	}
	if challenge.Instr == nil {
		t.Fatalf("开启第二层时必须下发程序")
	}
	if challenge.Instr.Fonts != len(InstrFontStacks) || challenge.Instr.Fonts != 17 {
		t.Errorf("fonts 应为字体栈数量（17），实际 %d", challenge.Instr.Fonts)
	}
	expected := CreateInstrumentationChallenge(challenge.ChallengeID, getVerifySecret())
	if !int32SliceEqual(challenge.Instr.Ops, expected.Ops) {
		t.Errorf("下发的程序必须与（密钥, cid）确定性派生的程序一致")
	}
	if _, ok := InterpretProgram(InstrumentationProgram{Ops: challenge.Instr.Ops}); !ok {
		t.Errorf("下发的程序必须可被影子模型解释")
	}
}

func TestCreateVerifyChallengeDifficultyClamp(t *testing.T) {
	for _, tc := range []struct {
		name    string
		setting string
		wantD   int
	}{
		{"总次数 1000", "1000", 250},
		{"总次数 4000", "4000", 1000},
		{"总次数 1e6", "1000000", 250000},
		{"低于下限被夹到 1000", "1", 250},
		{"非数字回退默认 1e6", "abc", 250000},
		{"旧值 18 迁移为 2^18", "18", 65536},
		{"旧值 16 迁移为 2^16", "16", 16384},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSettings(t)
			setSetting(t, settingVerifyEnabled, "true")
			setTestDifficulty(t, tc.setting)

			challenge, err := CreateVerifyChallenge("1.2.3.4", testPostSlug)
			if err != nil {
				t.Fatalf("签发挑战失败: %v", err)
			}
			if challenge.Pow.D != tc.wantD {
				t.Errorf("setting=%q 时 d 期望 %d，实际 %d", tc.setting, tc.wantD, challenge.Pow.D)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 答案校验
// ---------------------------------------------------------------------------

func TestVerifySolutionHappyPath(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	cid := "cid-happy"
	prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
	nonces := solveNoncesFor(t, cid, secret)

	ok, reason := verifySolution(t, prefix, sig, nonces, 500, ip)
	if !ok {
		t.Fatalf("正确解答应通过校验，reason=%q", reason)
	}
	if reason != "" {
		t.Errorf("通过时 reason 应为空串，实际 %q", reason)
	}
}

func TestVerifySolutionMissingInput(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	prefix, sig := makeSignedPrefix(t, secret, "cid-missing", "1.2.3.4", testPostSlug, time.Now().UnixMilli())
	nonces := []any{"0", "0", "0", "0"}

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
			ok, reason := verifySolution(t, tc.prefix, tc.sig, nonces, 500, "1.2.3.4")
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
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	cid := "cid-sig"
	prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
	nonces := solveNoncesFor(t, cid, secret)

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
			ok, reason := verifySolution(t, prefix, tc.sig, nonces, 500, ip)
			if ok {
				t.Errorf("签名校验失败时不应通过")
			}
			if reason != "bad signature" {
				t.Errorf("拒绝原因应为 bad signature，实际 %q", reason)
			}
		})
	}
}

// TestVerifySolutionMalformedPrefix 钉住「载荷根本不是 JSON」与「解析成功但不是对象」
// 的 reason 区分（与 Node 的 JSON.parse 抛错 / typeof 判断逐条对应）。
func TestVerifySolutionMalformedPrefix(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")
	secret := getVerifySecret()

	for _, body := range []string{"not-json", `{"v":2,`} {
		t.Run("body="+body, func(t *testing.T) {
			prefix := b64urlEncode([]byte(body))
			sig := hmacSHA256(prefix, secret) // 签名正确，问题只出在载荷
			ok, reason := verifySolution(t, prefix, sig, []any{"0", "0", "0", "0"}, 500, "1.2.3.4")
			if ok {
				t.Errorf("载荷非法时不应通过")
			}
			if reason != "malformed prefix" {
				t.Errorf("JSON 解析失败应以 malformed prefix 拒绝，实际 %q", reason)
			}
		})
	}
}

func TestVerifySolutionMalformedPayload(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")
	secret := getVerifySecret()

	for _, tc := range []struct {
		name string
		body string
	}{
		// 解析成功但不是对象：null / 数字 / 字符串 / 布尔 都是畸形载荷
		{"null", `null`},
		{"数字", `123`},
		{"字符串", `"nope"`},
		{"布尔", `true`},
		{"是合法 JSON 但缺少 cid", `{"v":2,"iph":"abc","slug":"/p","iat":1700000000000}`},
		{"是合法 JSON 但缺少 iph", `{"v":2,"cid":"c","slug":"/p","iat":1700000000000}`},
		{"缺少 slug（v2 载荷必须带文章绑定）", `{"v":2,"cid":"c","iph":"abc","iat":1700000000000}`},
		{"缺少 iat（不能退化成 1970 年的时间）", `{"v":2,"cid":"c","iph":"abc","slug":"/p"}`},
		{"iat 不是数字", `{"v":2,"cid":"c","iph":"abc","slug":"/p","iat":"1700000000000"}`},
		{"slug 不是字符串", `{"v":2,"cid":"c","iph":"abc","slug":123,"iat":1700000000000}`},
		{"cid 不是字符串", `{"v":2,"cid":123,"iph":"abc","slug":"/p","iat":1700000000000}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix := b64urlEncode([]byte(tc.body))
			sig := hmacSHA256(prefix, secret) // 签名正确，问题只出在载荷
			ok, reason := verifySolution(t, prefix, sig, []any{"0", "0", "0", "0"}, 500, "1.2.3.4")
			if ok {
				t.Errorf("载荷非法时不应通过")
			}
			if reason != "malformed payload" {
				t.Errorf("拒绝原因应为 malformed payload，实际 %q", reason)
			}
		})
	}
}

func TestVerifySolutionProtocolOutdated(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")
	secret := getVerifySecret()
	ip := "1.2.3.4"
	now := time.Now().UnixMilli()

	// v1 客户端签发的载荷：只有 cid / iph / iat，没有 v
	v1Prefix := b64urlEncode([]byte(`{"cid":"cid-v1","iph":"` + hashVerifyIP(ip, secret) +
		`","iat":` + strconv.FormatInt(now, 10) + `}`))
	if ok, reason := verifySolution(t, v1Prefix, hmacSHA256(v1Prefix, secret),
		[]any{"0", "0", "0", "0"}, 500, ip); ok || reason != "PROTOCOL_OUTDATED" {
		t.Errorf("v1 载荷应以 PROTOCOL_OUTDATED 拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// v:1 的载荷同样必须被明确拒绝
	v1Explicit := b64urlEncode([]byte(`{"v":1,"cid":"cid-v1","iph":"` + hashVerifyIP(ip, secret) +
		`","iat":` + strconv.FormatInt(now, 10) + `}`))
	if ok, reason := verifySolution(t, v1Explicit, hmacSHA256(v1Explicit, secret),
		[]any{"0", "0", "0", "0"}, 500, ip); ok || reason != "PROTOCOL_OUTDATED" {
		t.Errorf("v:1 载荷应以 PROTOCOL_OUTDATED 拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 协议版本检查必须早于时效检查（否则过期挑战会给出误导性的 reason）
	stale := time.Now().Add(-time.Hour).UnixMilli()
	staleV1 := b64urlEncode([]byte(`{"v":1,"cid":"cid-v1","iph":"` + hashVerifyIP(ip, secret) +
		`","iat":` + strconv.FormatInt(stale, 10) + `}`))
	if ok, reason := verifySolution(t, staleV1, hmacSHA256(staleV1, secret),
		[]any{"0", "0", "0", "0"}, 500, ip); ok || reason != "PROTOCOL_OUTDATED" {
		t.Errorf("过期的 v1 载荷也必须以 PROTOCOL_OUTDATED 拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 协议版本检查同样必须早于字段形状校验：v1 载荷既没有 v 也没有 slug，
	// 先校验形状会把它误判成 malformed payload。
	// 数组在 JS 里 typeof 也是 "object"，因此与 Node 一致地走到版本检查
	// （`payload.v` 为 undefined !== 2），而不是报 malformed payload。
	for _, tc := range []struct {
		name string
		body string
	}{
		{"空数组", `[]`},
		{"空 JSON 对象", `{}`},
		{"字段齐全但没有 v", `{"cid":"c","iph":"abc","slug":"/p","iat":1700000000000}`},
		{"v 是字符串", `{"v":"2","cid":"c","iph":"abc","slug":"/p","iat":1700000000000}`},
		{"v 是 null", `{"v":null,"cid":"c","iph":"abc","slug":"/p","iat":1700000000000}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix := b64urlEncode([]byte(tc.body))
			if ok, reason := verifySolution(t, prefix, hmacSHA256(prefix, secret),
				[]any{"0", "0", "0", "0"}, 500, ip); ok || reason != "PROTOCOL_OUTDATED" {
				t.Errorf("非 v2 载荷应以 PROTOCOL_OUTDATED 拒绝，实际 ok=%v reason=%q", ok, reason)
			}
		})
	}
}

// TestVerifySolutionPostSlugBinding 回归用例（安全修复）：
// 挑战被签名绑定到签发它的文章，一次工作量证明不能在同一 IP 上换成别的文章的票据。
func TestVerifySolutionPostSlugBinding(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	cid := "cid-slug-binding"
	const slugA = "/posts/a"
	const slugB = "/posts/b"

	prefix, sig := makeSignedPrefix(t, secret, cid, ip, slugA, time.Now().UnixMilli())
	nonces := solveNoncesFor(t, cid, secret)

	redeemAs := func(slug string) (bool, string) {
		t.Helper()
		return VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), IP: ip, PostSlug: slug,
		})
	}

	// 1. 为文章 A 签发的挑战，用文章 B 兑换必须被拒，且 reason 是专属的 slug mismatch
	if ok, reason := redeemAs(slugB); ok || reason != "slug mismatch" {
		t.Errorf("跨文章兑换应以 slug mismatch 拒绝，实际 ok=%v reason=%q", ok, reason)
	}
	// 2. 空文章名同样不行（不能把「没传 post_slug」当成通配）
	if ok, reason := redeemAs(""); ok || reason != "slug mismatch" {
		t.Errorf("空 slug 应以 slug mismatch 拒绝，实际 ok=%v reason=%q", ok, reason)
	}
	// 3. 文章绑定检查在防重放之前：上面两次失败都没有消耗挑战，原文章仍可兑换
	if ok, reason := redeemAs(slugA); !ok {
		t.Fatalf("原文章 A 的兑换应成功（前面的失败不应消耗挑战），实际 reason=%q", reason)
	}
	// 4. 挑战已用之后，绑定检查依然先于防重放
	if ok, reason := redeemAs(slugB); ok || reason != "slug mismatch" {
		t.Errorf("已用挑战的文章绑定检查仍应先于防重放，实际 ok=%v reason=%q", ok, reason)
	}
	if ok, reason := redeemAs(slugA); ok || reason != "challenge already used" {
		t.Errorf("同一挑战二次兑换应以 challenge already used 拒绝，实际 ok=%v reason=%q", ok, reason)
	}
}

func TestVerifySolutionExpiry(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	now := time.Now().UnixMilli()

	for _, tc := range []struct {
		name       string
		iat        int64
		wantReason string
	}{
		{"恰好过期（超出 10 分钟）", now - int64(challengeTTL/time.Millisecond) - 1, "challenge expired"},
		{"过期 1 小时", now - 60*60*1000, "challenge expired"},
		{"未来 61 秒（超容忍窗口）", now + 61*1000, "challenge from the future"},
		{"未来 1 小时", now + 60*60*1000, "challenge from the future"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix, sig := makeSignedPrefix(t, secret, "cid-exp-"+tc.name, ip, testPostSlug, tc.iat)
			ok, reason := verifySolution(t, prefix, sig, []any{"0", "0", "0", "0"}, 500, ip)
			if ok {
				t.Fatalf("过期/未来挑战不应通过")
			}
			if reason != tc.wantReason {
				t.Errorf("拒绝原因应为 %q，实际 %q", tc.wantReason, reason)
			}
		})
	}

	// 未来 30 秒在容忍窗口内，不应因为时间原因被拒绝
	prefix, sig := makeSignedPrefix(t, secret, "cid-exp-tolerated", ip, testPostSlug, now+30*1000)
	nonces := solveNoncesFor(t, "cid-exp-tolerated", secret)
	if ok, reason := verifySolution(t, prefix, sig, nonces, 500, ip); !ok {
		t.Errorf("未来 30 秒的挑战应在容忍窗口内通过，reason=%q", reason)
	}
}

func TestVerifySolutionIPBinding(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	cid := "cid-ip"
	prefix, sig := makeSignedPrefix(t, secret, cid, "1.2.3.4", testPostSlug, time.Now().UnixMilli())
	nonces := solveNoncesFor(t, cid, secret)

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
			ok, reason := verifySolution(t, prefix, sig, nonces, 500, tc.ip)
			if ok {
				t.Errorf("IP 不匹配时不应通过（%s）", tc.ip)
			}
			if reason != "ip mismatch" {
				t.Errorf("拒绝原因应为 ip mismatch，实际 %q", reason)
			}
		})
	}
}

func TestVerifySolutionTiming(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	minMs := int64(minSolveDuration / time.Millisecond) // 50
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
			cid := "cid-time-" + tc.name
			prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
			nonces := solveNoncesFor(t, cid, secret)
			ok, reason := verifySolution(t, prefix, sig, nonces, tc.elapsed, ip)
			if ok != tc.wantOK {
				t.Fatalf("elapsed=%d 期望 ok=%v，实际 %v（reason=%q）", tc.elapsed, tc.wantOK, ok, reason)
			}
			if reason != tc.wantReason {
				t.Errorf("拒绝原因应为 %q，实际 %q", tc.wantReason, reason)
			}
		})
	}

	t.Run("缺少 elapsed_ms 视为不可信时序", func(t *testing.T) {
		prefix, sig := makeSignedPrefix(t, secret, "cid-time-missing", ip, testPostSlug, time.Now().UnixMilli())
		nonces := solveNoncesFor(t, "cid-time-missing", secret)
		ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces), IP: ip, PostSlug: testPostSlug,
		})
		if ok || reason != "implausible timing" {
			t.Errorf("缺少 elapsed_ms 应以 implausible timing 拒绝，实际 ok=%v reason=%q", ok, reason)
		}
	})

	// Node 侧是 Number(data?.elapsed_ms)，因此数字字符串同样合法；
	// 这里钉住这个宽松度，避免前端把数字序列化成字符串后全部被判成时序不可信。
	t.Run("elapsed_ms 允许数字字符串与空串（Number() 语义）", func(t *testing.T) {
		for _, tc := range []struct {
			raw    string
			wantOK bool
		}{
			{`"500"`, true},
			{`"1e3"`, true},
			{`"50"`, true},
			{`""`, false},    // Number("") === 0 → 低于下限
			{`"abc"`, false}, // NaN
			{`null`, false},  // Number(null) === 0 → 低于下限
			{`true`, false},  // Number(true) === 1 → 低于下限
		} {
			cid := "cid-elapsed-" + tc.raw
			prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
			nonces := solveNoncesFor(t, cid, secret)
			ok, reason := VerifySolution(VerifySolutionInput{
				Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
				ElapsedMs: json.RawMessage(tc.raw), PostSlug: testPostSlug, IP: ip,
			})
			if ok != tc.wantOK {
				t.Errorf("elapsed_ms=%s 期望 ok=%v，实际 ok=%v（reason=%q）", tc.raw, tc.wantOK, ok, reason)
			}
		}
	})
}

func TestVerifySolutionNonceHandling(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"

	t.Run("nonces 数量不匹配", func(t *testing.T) {
		prefix, sig := makeSignedPrefix(t, secret, "cid-count", ip, testPostSlug, time.Now().UnixMilli())
		for _, nonces := range [][]any{
			{"1", "2", "3"},
			{},
			nil,
			{"1", "2", "3", "4", "5"},
		} {
			ok, reason := verifySolution(t, prefix, sig, nonces, 500, ip)
			if ok || reason != "solution count mismatch" {
				t.Errorf("数量不匹配（%d 个）应以 solution count mismatch 拒绝，实际 ok=%v reason=%q", len(nonces), ok, reason)
			}
		}
	})

	t.Run("nonces 不是数组", func(t *testing.T) {
		prefix, sig := makeSignedPrefix(t, secret, "cid-notarray", ip, testPostSlug, time.Now().UnixMilli())
		for _, raw := range []string{`"nope"`, `123`, `{}`, `null`} {
			ok, reason := VerifySolution(VerifySolutionInput{
				Prefix: prefix, Sig: sig, Nonces: json.RawMessage(raw), PostSlug: testPostSlug,
				ElapsedMs: mustJSON(t, 500), IP: ip,
			})
			if ok || reason != "solution count mismatch" {
				t.Errorf("nonces=%s 应以 solution count mismatch 拒绝，实际 ok=%v reason=%q", raw, ok, reason)
			}
		}
	})

	t.Run("非法 nonce", func(t *testing.T) {
		prefix, sig := makeSignedPrefix(t, secret, "cid-badnonce", ip, testPostSlug, time.Now().UnixMilli())
		for _, bad := range []any{"0x10", float64(-1), nil, "not-a-number", "99999999999999999999"} {
			ok, reason := verifySolution(t, prefix, sig, []any{bad, "0", "0", "0"}, 500, ip)
			if ok || reason != "bad nonce" {
				t.Errorf("非法 nonce %v 应以 bad nonce 拒绝，实际 ok=%v reason=%q", bad, ok, reason)
			}
		}
	})

	t.Run("工作量不足", func(t *testing.T) {
		cid := "cid-work"
		prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
		ok, reason := verifySolution(t, prefix, sig, badNoncesFor(t, cid, secret), 500, ip)
		if ok || reason != "insufficient work" {
			t.Errorf("工作量不足应以 insufficient work 拒绝，实际 ok=%v reason=%q", ok, reason)
		}
	})

	t.Run("全 0 答案按实际工作量判定", func(t *testing.T) {
		cid := "cid-zero"
		prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
		ok, reason := verifySolution(t, prefix, sig, []any{"0", "0", "0", "0"}, 500, ip)
		if ok && reason != "" {
			t.Errorf("通过时 reason 应为空，实际 %q", reason)
		}
		if !ok && reason != "insufficient work" {
			t.Errorf("不通过时应为 insufficient work，实际 %q", reason)
		}
	})
}

func TestVerifySolutionChallengeIsSingleUse(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	cid := "cid-single-use"
	prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())

	// 算力不足的提交不应消耗挑战（挑战只在算力校验通过后才标记为已用）
	if ok, reason := verifySolution(t, prefix, sig, badNoncesFor(t, cid, secret), 500, ip); ok || reason != "insufficient work" {
		t.Fatalf("第一次（算力不足）应以 insufficient work 拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	nonces := solveNoncesFor(t, cid, secret)
	if ok, reason := verifySolution(t, prefix, sig, nonces, 500, ip); !ok {
		t.Fatalf("算力不足的失败不应消耗挑战，实际 reason=%q", reason)
	}

	// 兑换成功后同一 prefix 不能再提交
	if ok, reason := verifySolution(t, prefix, sig, nonces, 500, ip); ok || reason != "challenge already used" {
		t.Errorf("重复提交应以 challenge already used 拒绝，实际 ok=%v reason=%q", ok, reason)
	}
	// 即使答案是错的，也应先报「已使用」
	if ok, reason := verifySolution(t, prefix, sig, badNoncesFor(t, cid, secret), 500, ip); ok || reason != "challenge already used" {
		t.Errorf("已用挑战应以 challenge already used 优先拒绝，实际 ok=%v reason=%q", ok, reason)
	}
}

// TestVerifySolutionConcurrentSingleUse 并发提交同一挑战时只能有一个成功：
// 「查重 → 算力校验 → 标记已用」必须在同一段临界区内完成，
// 否则两个请求会都通过查重，各自换到一张票据。
func TestVerifySolutionConcurrentSingleUse(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"
	cid := "cid-concurrent"
	prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
	nonces := mustJSON(t, solveNoncesFor(t, cid, secret))
	elapsed := mustJSON(t, 500)

	const workers = 8
	start := make(chan struct{})
	oks := make([]bool, workers)
	reasons := make([]string, workers)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start // 尽量让所有 goroutine 同时冲进校验逻辑
			ok, reason := VerifySolution(VerifySolutionInput{
				Prefix: prefix, Sig: sig, Nonces: nonces, ElapsedMs: elapsed, IP: ip, PostSlug: testPostSlug,
			})
			oks[index] = ok
			reasons[index] = reason
		}(i)
	}
	close(start)
	wg.Wait()

	successes := 0
	for i := 0; i < workers; i++ {
		if oks[i] {
			successes++
			continue
		}
		if reasons[i] != "challenge already used" {
			t.Errorf("第 %d 个并发请求的拒绝原因应为 challenge already used，实际 %q", i, reasons[i])
		}
	}
	if successes != 1 {
		t.Errorf("同一挑战并发提交应只有 1 次成功，实际 %d 次（reasons=%v）", successes, reasons)
	}
}

func TestVerifySolutionUsesDifferentSecret(t *testing.T) {
	resetSettings(t)
	setTestDifficulty(t, "1000")

	// 用与生产密钥不同的密钥签名，必须被拒绝
	ip := "1.2.3.4"
	prefix := makeChallengePrefix(t, "cid-secret", hashVerifyIP(ip, "other-secret"), testPostSlug, time.Now().UnixMilli())
	sig := hmacSHA256(prefix, "other-secret")

	if ok, reason := verifySolution(t, prefix, sig, []any{"0", "0", "0", "0"}, 500, ip); ok || reason != "bad signature" {
		t.Errorf("异密钥签名应以 bad signature 拒绝，实际 ok=%v reason=%q", ok, reason)
	}
}

// ---------------------------------------------------------------------------
// 第二层（Instrumentation）
// ---------------------------------------------------------------------------

func TestVerifySolutionWithInstrumentation(t *testing.T) {
	resetSettings(t)
	setSetting(t, settingVerifyInstrEnabled, "true")
	setTestDifficulty(t, "1000")

	secret := getVerifySecret()
	ip := "1.2.3.4"

	newCase := func(t *testing.T, cid string) (string, string, []any, map[string]any) {
		t.Helper()
		prefix, sig := makeSignedPrefix(t, secret, cid, ip, testPostSlug, time.Now().UnixMilli())
		return prefix, sig, solveNoncesFor(t, cid, secret), goodInstrumentationAnswer(t, cid, secret)
	}

	t.Run("缺少 instr 时拒绝", func(t *testing.T) {
		prefix, sig, nonces, _ := newCase(t, "cid-instr-missing")
		ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), PostSlug: testPostSlug, IP: ip,
		})
		if ok || reason != "malformed registers" {
			t.Errorf("缺少 instr 应以 malformed registers 拒绝，实际 ok=%v reason=%q", ok, reason)
		}
	})

	t.Run("合法答案通过", func(t *testing.T) {
		prefix, sig, nonces, answer := newCase(t, "cid-instr-ok")
		ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), PostSlug: testPostSlug, IP: ip, Instr: answer,
		})
		if !ok {
			t.Errorf("合法答案应通过，reason=%q", reason)
		}
	})

	t.Run("寄存器不匹配时拒绝", func(t *testing.T) {
		prefix, sig, nonces, answer := newCase(t, "cid-instr-mismatch")
		regs := answer["regs"].([]any)
		regs[2] = float64(int(regs[2].(float64)) + 1)
		ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), PostSlug: testPostSlug, IP: ip, Instr: answer,
		})
		if ok || reason != "program result mismatch" {
			t.Errorf("寄存器不匹配应以 program result mismatch 拒绝，实际 ok=%v reason=%q", ok, reason)
		}
	})

	t.Run("block_automated 开启时命中规则即拒绝", func(t *testing.T) {
		resetSettings(t)
		setSetting(t, settingVerifyInstrEnabled, "true")
		setSetting(t, settingVerifyBlockAutomated, "true")
		setTestDifficulty(t, "1000")
		prefix, sig, nonces, answer := newCase(t, "cid-instr-blocked")
		env := answer["env"].(map[string]any)
		env["cd"] = float64(1)
		ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), PostSlug: testPostSlug, IP: ip, Instr: answer,
		})
		if ok || reason != "automated browser detected: webdriver_true" {
			t.Errorf("应命中自动化规则并拒绝，实际 ok=%v reason=%q", ok, reason)
		}
	})

	t.Run("block_automated 关闭时只记录不拒绝", func(t *testing.T) {
		resetSettings(t)
		setSetting(t, settingVerifyInstrEnabled, "true")
		setTestDifficulty(t, "1000")
		prefix, sig, nonces, answer := newCase(t, "cid-instr-record")
		env := answer["env"].(map[string]any)
		env["cd"] = float64(1)
		ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), PostSlug: testPostSlug, IP: ip, Instr: answer,
		})
		if !ok {
			t.Errorf("block_automated 关闭时不应拒绝，reason=%q", reason)
		}
	})

	t.Run("第二层失败也会烧掉挑战", func(t *testing.T) {
		resetSettings(t)
		setSetting(t, settingVerifyInstrEnabled, "true")
		setTestDifficulty(t, "1000")
		prefix, sig, nonces, _ := newCase(t, "cid-instr-consume")
		// 第一次：算力通过，但第二层答案缺失 => 挑战必须已被标记为已用
		if ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), PostSlug: testPostSlug, IP: ip,
		}); ok || reason != "malformed registers" {
			t.Fatalf("第一次应以 malformed registers 拒绝，实际 ok=%v reason=%q", ok, reason)
		}
		// 之后即使补上正确的第二层答案，也不能再用同一挑战（否则可以反复刷环境向量）
		_, _, _, answer := newCase(t, "cid-instr-consume")
		if ok, reason := VerifySolution(VerifySolutionInput{
			Prefix: prefix, Sig: sig, Nonces: mustJSON(t, nonces),
			ElapsedMs: mustJSON(t, 500), PostSlug: testPostSlug, IP: ip, Instr: answer,
		}); ok || reason != "challenge already used" {
			t.Errorf("第二层失败后挑战应已被消耗，实际 ok=%v reason=%q", ok, reason)
		}
	})
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
	if payload.V != VerifyProtocolVersion {
		t.Errorf("票据版本应为 %d，实际 %d", VerifyProtocolVersion, payload.V)
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
	if !strings.HasPrefix(string(raw), `{"v":2,"iph":`) {
		t.Errorf("票据字段顺序必须是 v/iph/slug/iat/exp/jti，实际 %s", raw)
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
		V: VerifyProtocolVersion, Iph: hashVerifyIP(ip, secret), Slug: slug,
		Iat: now, Exp: now + int64(ticketTTL/time.Millisecond), Jti: "jti",
	}

	for _, tc := range []struct {
		name    string
		mutate  func(p *verifyTicketPayload)
		wantOK  bool
		comment string
	}{
		{"正常票据", func(p *verifyTicketPayload) {}, true, ""},
		{"版本号不为 2", func(p *verifyTicketPayload) { p.V = 1 }, false, "v1 票据一律拒绝"},
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
		V: VerifyProtocolVersion, Iph: hashVerifyIP(ip, secret), Slug: slug,
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
		V: VerifyProtocolVersion, Iph: hashVerifyIP(ip, "attacker-secret"), Slug: slug,
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

// TestSha256Reference 保证测试侧使用的 sha256Hex 与标准库一致
func TestSha256Reference(t *testing.T) {
	sum := sha256.Sum256([]byte("momo"))
	if sha256Hex("momo") != hex.EncodeToString(sum[:]) {
		t.Errorf("sha256Hex 与标准库不一致")
	}
}
