package utils

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

/*
跨语言固定向量验收测试（协议 v2）

fixture 由 nodejs/scripts/gen-verify-vectors.ts 生成，Go / Node / Worker / 前端的测试
读同一份文件（doc/vectors/verify-v2.json）。这里做两件事：

 1. 用与实现无关的**本地副本**复算 fixture 里的每一个值（钉住口径本身）；
 2. 断言被测实现的实际输出与本地复算一致（钉住实现没有漂移）。

任何一端改了冒号分隔符、base64url 填充、字段顺序或派生标签，都会被这里抓住。
*/

// vectorsPath 从测试文件出发定位共享向量目录（doc/vectors/）。
//
// 测试的工作目录是该包的源码目录（go test 的约定），
// 因此 go/internal/pkg/utils 与 go/internal/handler/http 都上溯四级到仓库根。
func vectorsPath(name string) string {
	return filepath.Join("..", "..", "..", "..", "doc", "vectors", name)
}

// verifyVectorFixture doc/vectors/verify-v2.json 的结构化视图
type verifyVectorFixture struct {
	Secret     string `json:"secret"`
	IP         string `json:"ip"`
	Slug       string `json:"slug"`
	Iat        int64  `json:"iat"`
	Exp        int64  `json:"exp"`
	Jti        string `json:"jti"`
	Cid        string `json:"cid"`
	Difficulty int    `json:"difficulty"`

	IPHash   string `json:"ipHash"`
	Honeypot string `json:"honeypot"`

	ChallengePayloadJSON string `json:"challengePayloadJson"`
	Prefix               string `json:"prefix"`
	Sig                  string `json:"sig"`

	Hashwx struct {
		C     string `json:"c"`
		D     int    `json:"d"`
		N     int    `json:"n"`
		Count int    `json:"count"`
	} `json:"hashwx"`

	Instrumentation struct {
		Seed string  `json:"seed"`
		Ops  []int32 `json:"ops"`
		Regs []int32 `json:"regs"`
	} `json:"instrumentation"`

	TicketPayloadJSON string `json:"ticketPayloadJson"`
	TicketBody        string `json:"ticketBody"`
	TicketSig         string `json:"ticketSig"`
}

var (
	verifyFixtureOnce sync.Once
	verifyFixture     verifyVectorFixture
	verifyFixtureErr  error
)

// loadVerifyFixture 读取（并缓存）doc/vectors/verify-v2.json
func loadVerifyFixture(t *testing.T) verifyVectorFixture {
	t.Helper()
	verifyFixtureOnce.Do(func() {
		raw, err := os.ReadFile(vectorsPath("verify-v2.json"))
		if err != nil {
			verifyFixtureErr = err
			return
		}
		verifyFixtureErr = json.Unmarshal(raw, &verifyFixture)
	})
	if verifyFixtureErr != nil {
		t.Fatalf("读取 doc/vectors/verify-v2.json 失败: %v", verifyFixtureErr)
	}
	return verifyFixture
}

// ---------- 与实现无关的本地副本 ----------

func b64urlLocal(input []byte) string {
	return base64.RawURLEncoding.EncodeToString(input)
}

func hmacLocal(data, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return b64urlLocal(mac.Sum(nil))
}

func sha256HexLocal(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

// withVectorSecret 把进程内签名密钥临时切换为跨语言向量密钥，用例结束后恢复
func withVectorSecret(t *testing.T, secret string) {
	t.Helper()
	verifySecretOnce.Do(func() {})
	previous := verifySecretVal
	verifySecretVal = secret
	t.Cleanup(func() { verifySecretVal = previous })
}

// ---------- fixture 结构与其他 fixture 的自洽性 ----------

func TestVerifyVectorFixtureShape(t *testing.T) {
	fixture := loadVerifyFixture(t)

	for name, value := range map[string]string{
		"secret":               fixture.Secret,
		"ip":                   fixture.IP,
		"slug":                 fixture.Slug,
		"cid":                  fixture.Cid,
		"ipHash":               fixture.IPHash,
		"honeypot":             fixture.Honeypot,
		"prefix":               fixture.Prefix,
		"sig":                  fixture.Sig,
		"challengePayloadJson": fixture.ChallengePayloadJSON,
		"hashwx.c":             fixture.Hashwx.C,
		"instrumentation.seed": fixture.Instrumentation.Seed,
		"ticketBody":           fixture.TicketBody,
		"ticketSig":            fixture.TicketSig,
	} {
		if value == "" {
			t.Errorf("fixture 缺少 %s", name)
		}
	}

	if fixture.Hashwx.D != 250 || fixture.Hashwx.N != 65536 || fixture.Hashwx.Count != 4 {
		t.Errorf("fixture 的 hashwx 参数应为 d=250 n=65536 count=4，实际 %+v", fixture.Hashwx)
	}
	if fixture.Difficulty != 1000 {
		t.Errorf("fixture 的 difficulty 应为 1000，实际 %d", fixture.Difficulty)
	}

	// 两份 fixture 必须互相印证：verify-v2.json 的 cid 与 instrumentation-v2.json 的第一个向量同源
	instrFixture := loadInstrumentationFixture(t)
	var sameCid bool
	for _, vector := range instrFixture.Vectors {
		if vector.Cid != fixture.Cid {
			continue
		}
		sameCid = true
		if vector.Seed != fixture.Instrumentation.Seed {
			t.Errorf("两份 fixture 的 instr 种子不一致: %s != %s", vector.Seed, fixture.Instrumentation.Seed)
		}
		if !int32SliceEqual(vector.Ops, fixture.Instrumentation.Ops) {
			t.Errorf("两份 fixture 的 instr 程序不一致")
		}
		if !int32SliceEqual(vector.Regs, fixture.Instrumentation.Regs) {
			t.Errorf("两份 fixture 的 instr 寄存器期望值不一致")
		}
	}
	if !sameCid {
		t.Errorf("instrumentation-v2.json 里缺少 cid=%s 的向量", fixture.Cid)
	}
}

// ---------- 派生公式 ----------

func TestVerifyVectorIPHashAndHoneypot(t *testing.T) {
	fixture := loadVerifyFixture(t)

	if got := sha256HexLocal("ip:" + fixture.Secret + ":" + fixture.IP)[:16]; got != fixture.IPHash {
		t.Errorf("IP 哈希公式漂移: got=%s want=%s", got, fixture.IPHash)
	}
	if got := "v_" + sha256HexLocal("hp:" + fixture.Secret + ":" + fixture.Slug)[:10]; got != fixture.Honeypot {
		t.Errorf("蜜罐字段名公式漂移: got=%s want=%s", got, fixture.Honeypot)
	}

	// 被测实现必须给出同一个值
	if got := hashVerifyIP(fixture.IP, fixture.Secret); got != fixture.IPHash {
		t.Errorf("hashVerifyIP 口径漂移: got=%s want=%s", got, fixture.IPHash)
	}
	if got := honeypotFieldName(fixture.Slug, fixture.Secret); got != fixture.Honeypot {
		t.Errorf("honeypotFieldName 口径漂移: got=%s want=%s", got, fixture.Honeypot)
	}
}

// TestVerifyVectorChallengePayload 钉死挑战载荷的字段顺序与签名：
// 字段顺序变化会让 Node/Worker 签发的挑战在 Go 端全部失效。
func TestVerifyVectorChallengePayload(t *testing.T) {
	fixture := loadVerifyFixture(t)

	iat := fixture.Iat
	raw, err := json.Marshal(verifyChallengePayload{
		V:    VerifyProtocolVersion,
		Cid:  fixture.Cid,
		Iph:  fixture.IPHash,
		Slug: fixture.Slug,
		Iat:  &iat,
	})
	if err != nil {
		t.Fatalf("序列化挑战载荷失败: %v", err)
	}
	if string(raw) != fixture.ChallengePayloadJSON {
		t.Errorf("挑战载荷字段顺序/内容漂移:\n got=%s\nwant=%s", raw, fixture.ChallengePayloadJSON)
	}
	if got := b64urlEncode(raw); got != fixture.Prefix {
		t.Errorf("挑战前缀编码漂移:\n got=%s\nwant=%s", got, fixture.Prefix)
	}
	if got := hmacSHA256(fixture.Prefix, fixture.Secret); got != fixture.Sig {
		t.Errorf("挑战签名口径漂移:\n got=%s\nwant=%s", got, fixture.Sig)
	}
	// 本地副本与实现交叉校验
	if got := hmacLocal(fixture.Prefix, fixture.Secret); got != fixture.Sig {
		t.Errorf("本地 HMAC 副本与 fixture 不一致: %s", got)
	}
	if got := b64urlLocal([]byte(fixture.ChallengePayloadJSON)); got != fixture.Prefix {
		t.Errorf("本地 base64url 副本与 fixture 不一致: %s", got)
	}
}

// TestVerifyVectorHashwxChallenge 钉死 HashWX 挑战的派生标签与公式
func TestVerifyVectorHashwxChallenge(t *testing.T) {
	fixture := loadVerifyFixture(t)

	if got := sha256HexLocal("hashwx:C:" + fixture.Secret + ":" + fixture.Cid); got != fixture.Hashwx.C {
		t.Errorf("HashWX 挑战派生漂移:\n got=%s\nwant=%s", got, fixture.Hashwx.C)
	}
	if got := hex.EncodeToString(deriveHashwxChallenge(fixture.Cid, fixture.Secret)); got != fixture.Hashwx.C {
		t.Errorf("deriveHashwxChallenge 实现漂移:\n got=%s\nwant=%s", got, fixture.Hashwx.C)
	}

	// fixture 的 difficulty 经「按 count 均分」应得到 fixture 的 d
	withVectorSecret(t, fixture.Secret)
	resetSettings(t)
	setSetting(t, settingVerifyDifficulty, strconv.Itoa(fixture.Difficulty))
	if got := GetVerifyDifficulty(); got != fixture.Difficulty {
		t.Fatalf("难度读取口径漂移: got=%d want=%d", got, fixture.Difficulty)
	}
	spec, err := buildHashwxSpec(fixture.Cid, fixture.Secret)
	if err != nil {
		t.Fatalf("buildHashwxSpec 失败: %v", err)
	}
	if spec.C != fixture.Hashwx.C || spec.D != fixture.Hashwx.D ||
		spec.N != fixture.Hashwx.N || spec.Count != fixture.Hashwx.Count {
		t.Errorf("HashWX spec 与 fixture 不一致:\n got=%+v\nwant=%+v", spec, fixture.Hashwx)
	}
}

// TestVerifyVectorTicketPayload 钉死票据载荷的字段顺序与签名
func TestVerifyVectorTicketPayload(t *testing.T) {
	fixture := loadVerifyFixture(t)

	raw, err := json.Marshal(verifyTicketPayload{
		V:    VerifyProtocolVersion,
		Iph:  fixture.IPHash,
		Slug: fixture.Slug,
		Iat:  fixture.Iat,
		Exp:  fixture.Exp,
		Jti:  fixture.Jti,
	})
	if err != nil {
		t.Fatalf("序列化票据载荷失败: %v", err)
	}
	if string(raw) != fixture.TicketPayloadJSON {
		t.Errorf("票据载荷字段顺序/内容漂移:\n got=%s\nwant=%s", raw, fixture.TicketPayloadJSON)
	}
	if got := b64urlEncode(raw); got != fixture.TicketBody {
		t.Errorf("票据 body 口径漂移:\n got=%s\nwant=%s", got, fixture.TicketBody)
	}
	if got := hmacSHA256(fixture.TicketBody, fixture.Secret); got != fixture.TicketSig {
		t.Errorf("票据签名口径漂移:\n got=%s\nwant=%s", got, fixture.TicketSig)
	}
	if got := hmacLocal(fixture.TicketBody, fixture.Secret); got != fixture.TicketSig {
		t.Errorf("本地 HMAC 副本与 fixture 不一致: %s", got)
	}

	// 固定向量的 exp 早已过期，整体校验必须失败；但失败原因不能是签名不匹配
	withVectorSecret(t, fixture.Secret)
	resetSettings(t)
	ticket := fixture.TicketBody + "." + fixture.TicketSig
	if VerifyTicket(ticket, fixture.IP, fixture.Slug) {
		t.Errorf("已过期的固定向量票据不应通过校验")
	}
	if !constantTimeEqual(hmacSHA256(fixture.TicketBody, fixture.Secret), fixture.TicketSig) {
		t.Errorf("固定票据向量的签名不匹配，说明 HMAC 口径漂移")
	}

	// 用同一密钥与同一序列化口径签发一张在有效期内的票据，链路必须闭环
	now := time.Now().UnixMilli()
	live := makeTicket(t, fixture.Secret, verifyTicketPayload{
		V: VerifyProtocolVersion, Iph: hashVerifyIP(fixture.IP, fixture.Secret), Slug: fixture.Slug,
		Iat: now, Exp: now + 60_000, Jti: fixture.Jti,
	})
	if !VerifyTicket(live, fixture.IP, fixture.Slug) {
		t.Errorf("用向量密钥签发的票据应通过校验")
	}
	if VerifyTicket(live, "10.0.0.1", fixture.Slug) {
		t.Errorf("票据不应跨 IP 有效")
	}
	if VerifyTicket(live, fixture.IP, "/posts/other") {
		t.Errorf("票据不应跨文章有效")
	}
}

// TestVerifyVectorChallengeVerification 用固定前缀向量走完整的答案校验路径：
// 前几步（签名 → 载荷 → 协议版本 → 时效）必须全部通过，最终只因过期被拒绝。
func TestVerifyVectorChallengeVerification(t *testing.T) {
	fixture := loadVerifyFixture(t)
	withVectorSecret(t, fixture.Secret)
	resetSettings(t)
	// 与 fixture 的难度保持一致（d=250），否则解题要按默认的 1e6 次哈希跑上几分钟
	setSetting(t, settingVerifyDifficulty, strconv.Itoa(fixture.Difficulty))

	nonces := []any{"0", "0", "0", "0"}

	// 1. 固定向量（iat 为 2024 年）应只因过期被拒绝
	if ok, reason := VerifySolution(VerifySolutionInput{
		Prefix: fixture.Prefix, Sig: fixture.Sig, Nonces: mustJSON(t, nonces),
		ElapsedMs: mustJSON(t, 500), IP: fixture.IP, PostSlug: fixture.Slug,
	}); ok || reason != "challenge expired" {
		t.Errorf("固定向量应因过期被拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 2. 相同载荷、相同序列化口径，但签发时间改为当前：越过了时效与 IP 绑定，
	//    最终必须停在算力校验上（nonces 全是 0，几乎必然不达标）
	livePrefix, liveSig := makeSignedPrefix(t, fixture.Secret, fixture.Cid, fixture.IP, fixture.Slug, time.Now().UnixMilli())
	if livePrefix == fixture.Prefix {
		t.Fatalf("前置条件：iat 变化后前缀应不同")
	}
	if !constantTimeEqual(hashVerifyIP(fixture.IP, fixture.Secret), fixture.IPHash) {
		t.Fatalf("IP 哈希向量漂移")
	}
	if ok, reason := VerifySolution(VerifySolutionInput{
		Prefix: livePrefix, Sig: liveSig, Nonces: mustJSON(t, nonces),
		ElapsedMs: mustJSON(t, 500), IP: fixture.IP, PostSlug: fixture.Slug,
	}); ok || reason != "insufficient work" {
		t.Errorf("签名/载荷/时效/IP/时序校验应全部通过，仅因工作量不足被拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 3. 跨 IP 必须被拒绝（用同一前缀）
	if ok, reason := VerifySolution(VerifySolutionInput{
		Prefix: livePrefix, Sig: liveSig, Nonces: mustJSON(t, nonces),
		ElapsedMs: mustJSON(t, 500), IP: "10.0.0.1", PostSlug: fixture.Slug,
	}); ok || reason != "ip mismatch" {
		t.Errorf("跨 IP 应以 ip mismatch 拒绝，实际 ok=%v reason=%q", ok, reason)
	}

	// 4. 用向量密钥解出真实答案后应通过校验，并能签发出可用的票据
	liveNonces := solveNoncesForPrefix(t, livePrefix)
	ok, reason := VerifySolution(VerifySolutionInput{
		Prefix: livePrefix, Sig: liveSig, Nonces: mustJSON(t, liveNonces),
		ElapsedMs: mustJSON(t, 500), IP: fixture.IP, PostSlug: fixture.Slug,
	})
	if !ok {
		t.Fatalf("用向量密钥求解后应通过校验，reason=%q", reason)
	}

	ticket, err := CreateVerifyTicket(fixture.IP, fixture.Slug)
	if err != nil {
		t.Fatalf("签发票据失败: %v", err)
	}
	if !VerifyTicket(ticket, fixture.IP, fixture.Slug) {
		t.Errorf("自己签发的票据应通过校验")
	}
}

// TestVerifyVectorChallengeSignatureIsCheckedFirst 不能因为 payload 结构变化
// 而把「签名错误」误报成别的 reason
func TestVerifyVectorChallengeSignatureIsCheckedFirst(t *testing.T) {
	fixture := loadVerifyFixture(t)
	withVectorSecret(t, fixture.Secret)
	resetSettings(t)

	if ok, reason := VerifySolution(VerifySolutionInput{
		Prefix: fixture.Prefix, Sig: fixture.Sig + "x",
		Nonces: mustJSON(t, []any{"0", "0", "0", "0"}), ElapsedMs: mustJSON(t, 500),
		IP: fixture.IP, PostSlug: fixture.Slug,
	}); ok || reason != "bad signature" {
		t.Errorf("篡改签名应以 bad signature 拒绝，实际 ok=%v reason=%q", ok, reason)
	}
}

// ---------- 小工具 ----------

func int32SliceEqual(a, b []int32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化测试载荷失败: %v", err)
	}
	return raw
}

// solveNoncesForPrefix 从挑战前缀里取回 cid，按服务端口径重建 spec 并求解
func solveNoncesForPrefix(t *testing.T, prefix string) []any {
	t.Helper()
	raw, err := b64urlDecode(prefix)
	if err != nil {
		t.Fatalf("解码前缀失败: %v", err)
	}
	var payload verifyChallengePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("解析前缀载荷失败: %v", err)
	}
	spec, err := buildHashwxSpec(payload.Cid, getVerifySecret())
	if err != nil {
		t.Fatalf("重建 spec 失败: %v", err)
	}
	return hashwxSolve(t, spec)
}
