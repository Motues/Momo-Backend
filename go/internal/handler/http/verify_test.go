package http

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
)

/*
/api/verify/* 的协议 v2 端到端测试

这一层是黑盒（从 gin 路由进、从 JSON 出），因此只断言「响应结构 + 判定结果」；
跨语言签名的逐字节口径由 utils 包的 doc/vectors/verify-v2.json 验收测试负责。
*/

type verifyPowResponse struct {
	Algo  string `json:"algo"`
	C     string `json:"c"`
	D     int    `json:"d"`
	N     int    `json:"n"`
	Count int    `json:"count"`
}

type verifyInstrResponse struct {
	Ops   []int32 `json:"ops"`
	Fonts int     `json:"fonts"`
}

type verifyChallengePayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Enabled     bool                 `json:"enabled"`
		Version     int                  `json:"version"`
		PostSlug    string               `json:"post_slug"`
		ChallengeID string               `json:"challenge_id"`
		Prefix      string               `json:"prefix"`
		Sig         string               `json:"sig"`
		ExpiresIn   int                  `json:"expires_in"`
		Pow         verifyPowResponse    `json:"pow"`
		Instr       *verifyInstrResponse `json:"instr"`
	} `json:"data"`
}

type verifySolutionPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Reason  string `json:"reason"`
	Data    struct {
		Enabled   bool   `json:"enabled"`
		Version   int    `json:"version"`
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	} `json:"data"`
}

// verifySolutionRequest 提交答案请求体（协议 v2）
type verifySolutionRequest struct {
	PostSlug  string           `json:"post_slug"`
	Prefix    string           `json:"prefix"`
	Sig       string           `json:"sig"`
	Nonces    []string         `json:"nonces"`
	ElapsedMs int64            `json:"elapsed_ms"`
	Hp        string           `json:"hp,omitempty"`
	Instr     *instrAnswerBody `json:"instr,omitempty"`
}

// instrAnswerBody 第二层答案：客户端用真实 DOM 执行程序后回传的寄存器与环境向量
type instrAnswerBody struct {
	Regs []int32        `json:"regs"`
	Env  map[string]any `json:"env"`
	Lw   float64        `json:"lw"`
	Lh   float64        `json:"lh"`
	Tm   []float64      `json:"tm"`
}

// solvePow 在测试侧独立求解 HashWX 子挑战（与前端一样逐个子挑战遍历 nonce）
func solvePow(t *testing.T, pow verifyPowResponse) []string {
	t.Helper()
	challenge := utils.ParseHashwxChallenge(pow.C)
	if challenge == nil {
		t.Fatalf("pow.c 不是合法的 32 字节 hex: %q", pow.C)
	}
	target, err := utils.HashwxTarget(pow.D)
	if err != nil {
		t.Fatalf("pow.d 非法: %v", err)
	}
	n := uint64(pow.N)

	nonces := make([]string, 0, pow.Count)
	for i := 0; i < pow.Count; i++ {
		var nonce uint64
		for {
			seed, err := utils.HashwxBlockSeed(challenge, i, nonce/n)
			if err != nil {
				t.Fatalf("种子派生失败: %v", err)
			}
			hash, err := utils.HashwxHash(seed, nonce)
			if err != nil {
				t.Fatalf("HashwxHash 失败: %v", err)
			}
			if hash <= target {
				break
			}
			nonce++
			if nonce > 20_000_000 {
				t.Fatalf("子挑战 %d 求解超限", i)
			}
		}
		nonces = append(nonces, strconv.FormatUint(nonce, 10))
	}
	return nonces
}

// insufficientPow 找出一组必然不达标的 nonce
func insufficientPow(t *testing.T, pow verifyPowResponse) []string {
	t.Helper()
	challenge := utils.ParseHashwxChallenge(pow.C)
	target, err := utils.HashwxTarget(pow.D)
	if err != nil {
		t.Fatalf("pow.d 非法: %v", err)
	}
	n := uint64(pow.N)

	nonces := make([]string, 0, pow.Count)
	for i := 0; i < pow.Count; i++ {
		var nonce uint64
		for {
			seed, err := utils.HashwxBlockSeed(challenge, i, nonce/n)
			if err != nil {
				t.Fatalf("种子派生失败: %v", err)
			}
			hash, err := utils.HashwxHash(seed, nonce)
			if err != nil {
				t.Fatalf("HashwxHash 失败: %v", err)
			}
			if hash > target {
				break
			}
			nonce++
			if nonce > 5_000_000 {
				t.Fatalf("找不到不达标的 nonce")
			}
		}
		nonces = append(nonces, strconv.FormatUint(nonce, 10))
	}
	return nonces
}

// solutionBody 构造校验答案请求体
func solutionBody(t *testing.T, req verifySolutionRequest) string {
	t.Helper()
	if req.Nonces == nil {
		req.Nonces = []string{}
	}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("序列化答案请求失败: %v", err)
	}
	return string(raw)
}

// enableVerify 开启无感验证并设置总难度（默认 1000 => d=250，保证测试解题够快）
func enableVerify(t *testing.T, difficulty string) {
	t.Helper()
	setSetting(t, "comment_verify_enabled", "true")
	setSetting(t, "comment_verify_difficulty", difficulty)
}

// requestChallenge 签发一个真实挑战
func requestChallenge(t *testing.T, slug, addr string) verifyChallengePayload {
	t.Helper()
	var challenge verifyChallengePayload
	decodeInto(t, callFromIP(t, "POST", "/api/verify/challenge",
		fmt.Sprintf(`{"post_slug":%q}`, slug), addr), &challenge)
	if !challenge.Data.Enabled {
		t.Fatalf("挑战未签发: %+v", challenge.Data)
	}
	return challenge
}

// ---------------------------------------------------------------------------
// POST /api/verify/challenge
// ---------------------------------------------------------------------------

func TestVerifyChallengeWhenDisabled(t *testing.T) {
	resetState(t)

	for _, body := range []string{"", `{"post_slug":"/p"}`, `{invalid json`, `{"post_slug":123}`} {
		t.Run("body="+body, func(t *testing.T) {
			w := callJSON(t, "POST", "/api/verify/challenge", body)
			requireStatus(t, w, 200)

			var payload verifyChallengePayload
			decodeInto(t, w, &payload)
			if payload.Data.Enabled {
				t.Errorf("关闭状态下 enabled 应为 false")
			}
			if payload.Data.Version != 2 {
				t.Errorf("关闭状态下也应下发 version=2，实际 %d", payload.Data.Version)
			}
			if payload.Message != "Verification disabled" {
				t.Errorf("message 期望 Verification disabled，实际 %q", payload.Message)
			}
			if payload.Data.Prefix != "" || payload.Data.Sig != "" || payload.Data.Pow.Algo != "" {
				t.Errorf("关闭状态下不应签发挑战: %+v", payload.Data)
			}
			if payload.Data.Instr != nil {
				t.Errorf("关闭状态下不应下发第二层程序")
			}
		})
	}
}

func TestVerifyChallengeWhenEnabled(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	w := callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/posts/hello"}`)
	requireStatus(t, w, 200)

	var payload verifyChallengePayload
	decodeInto(t, w, &payload)

	if !payload.Data.Enabled {
		t.Fatalf("开启状态下 enabled 应为 true")
	}
	if payload.Data.Version != 2 {
		t.Errorf("version 期望 2，实际 %d", payload.Data.Version)
	}
	if payload.Message != "Challenge issued" {
		t.Errorf("message 期望 Challenge issued，实际 %q", payload.Message)
	}
	if payload.Data.Prefix == "" || payload.Data.Sig == "" || payload.Data.ChallengeID == "" {
		t.Fatalf("挑战字段不应为空: %+v", payload.Data)
	}
	if payload.Data.ExpiresIn != 600 {
		t.Errorf("expires_in 期望 600，实际 %d", payload.Data.ExpiresIn)
	}
	if payload.Data.PostSlug != "/posts/hello" {
		t.Errorf("post_slug 应回显，实际 %q", payload.Data.PostSlug)
	}
	if strings.ContainsAny(payload.Data.Prefix, "=+/") {
		t.Errorf("prefix 应为无填充 base64url，实际 %q", payload.Data.Prefix)
	}
	if strings.ContainsAny(payload.Data.Sig, "=+/") {
		t.Errorf("sig 应为无填充 base64url，实际 %q", payload.Data.Sig)
	}

	// 协议 v2 的挑战参数
	if payload.Data.Pow.Algo != "hashwx" {
		t.Errorf("pow.algo 期望 hashwx，实际 %q", payload.Data.Pow.Algo)
	}
	if payload.Data.Pow.D != 250 {
		t.Errorf("总难度 1000 按 count=4 均分应得到 d=250，实际 %d", payload.Data.Pow.D)
	}
	if payload.Data.Pow.N != 65536 {
		t.Errorf("pow.n 期望 65536，实际 %d", payload.Data.Pow.N)
	}
	if payload.Data.Pow.Count != 4 {
		t.Errorf("pow.count 期望 4，实际 %d", payload.Data.Pow.Count)
	}
	if utils.ParseHashwxChallenge(payload.Data.Pow.C) == nil {
		t.Errorf("pow.c 必须是合法的 32 字节 hex，实际 %q", payload.Data.Pow.C)
	}
	if payload.Data.Instr != nil {
		t.Errorf("未开启第二层时 instr 字段必须整个缺席")
	}

	// 挑战载荷必须是 v2 且带 cid / iph / slug / iat
	raw, err := b64urlDecodeForTest(payload.Data.Prefix)
	if err != nil {
		t.Fatalf("prefix 不是合法 base64url: %v", err)
	}
	if !strings.HasPrefix(string(raw), `{"v":2,"cid":`) {
		t.Errorf("prefix 载荷字段顺序必须是 v/cid/iph/slug/iat，实际 %s", raw)
	}
	if !strings.Contains(string(raw), `,"slug":"/posts/hello","iat":`) {
		t.Errorf("prefix 载荷必须把文章签进去（字段顺序 v/cid/iph/slug/iat），实际 %s", raw)
	}
	if !strings.Contains(string(raw), payload.Data.ChallengeID) {
		t.Errorf("prefix 载荷应包含 challenge_id")
	}

	// 两次签发应得到不同挑战
	var second verifyChallengePayload
	decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/posts/hello"}`), &second)
	if second.Data.ChallengeID == payload.Data.ChallengeID {
		t.Errorf("两次签发的 challenge_id 不应相同")
	}
	if second.Data.Pow.C == payload.Data.Pow.C {
		t.Errorf("两次签发的 pow.c 不应相同")
	}

	// 认证记录：两次签发都要落库，challenge_id 与响应一致，
	// difficulty 是**当时的总期望哈希次数**（不是响应里 pow.d 的单子挑战难度）
	records := listVerifyRows(t)
	if len(records) != 2 {
		t.Fatalf("两次签发应写入 2 条认证记录，实际 %d 条: %+v", len(records), records)
	}
	seenChallengeIDs := make(map[string]bool, len(records))
	for _, rec := range records {
		if rec.Event != model.VerifyEventChallenge {
			t.Errorf("签发事件的 event 应为 %q，实际 %q", model.VerifyEventChallenge, rec.Event)
			continue
		}
		seenChallengeIDs[rec.ChallengeID.String] = true
		if !rec.Difficulty.Valid || rec.Difficulty.Int64 != int64(utils.GetVerifyDifficulty()) {
			t.Errorf("difficulty 应为总期望哈希次数 %d，实际 %v", utils.GetVerifyDifficulty(), rec.Difficulty)
		}
		if !rec.PostSlug.Valid || rec.PostSlug.String != "/posts/hello" {
			t.Errorf("post_slug 应为 /posts/hello，实际 %v", rec.PostSlug)
		}
		// 签发事件没有失败原因，也没有客户端耗时
		if rec.Reason.Valid {
			t.Errorf("签发事件的 reason 应为 NULL，实际 %q", rec.Reason.String)
		}
		if rec.ElapsedMs.Valid {
			t.Errorf("签发事件的 elapsed_ms 应为 NULL，实际 %d", rec.ElapsedMs.Int64)
		}
	}
	for _, id := range []string{payload.Data.ChallengeID, second.Data.ChallengeID} {
		if !seenChallengeIDs[id] {
			t.Errorf("认证记录里缺少 challenge_id=%q 的签发事件", id)
		}
	}
}

// TestVerifyRecordWrittenForChallengeFailAndPass 钉住认证记录的落库内容：
// 三端（Node / Go / Worker）在「什么时候写、写什么」上必须一致，
// 否则后台的认证统计会随实现漂移。
func TestVerifyRecordWrittenForChallengeFailAndPass(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	wantDifficulty := int64(utils.GetVerifyDifficulty())
	ip := nextIP()
	addr := ip + ":1234"
	const slug = "/posts/recorded"

	// 1) 签发挑战 => 一条 event='challenge'，challenge_id 与响应一致
	challenge := requestChallenge(t, slug, addr)
	rows := listVerifyRows(t)
	if len(rows) != 1 {
		t.Fatalf("签发挑战后应有 1 条记录，实际 %d 条: %+v", len(rows), rows)
	}
	challengeRow := rows[0]
	if challengeRow.Event != model.VerifyEventChallenge {
		t.Errorf("event 期望 %q，实际 %q", model.VerifyEventChallenge, challengeRow.Event)
	}
	if !challengeRow.ChallengeID.Valid || challengeRow.ChallengeID.String != challenge.Data.ChallengeID {
		t.Errorf("challenge_id 期望 %q，实际 %v", challenge.Data.ChallengeID, challengeRow.ChallengeID)
	}
	if !challengeRow.Difficulty.Valid || challengeRow.Difficulty.Int64 != wantDifficulty {
		t.Errorf("difficulty 期望 %d（总期望哈希次数），实际 %v", wantDifficulty, challengeRow.Difficulty)
	}
	if !challengeRow.PostSlug.Valid || challengeRow.PostSlug.String != slug {
		t.Errorf("post_slug 期望 %q，实际 %v", slug, challengeRow.PostSlug)
	}
	if !challengeRow.IPAddress.Valid || challengeRow.IPAddress.String != ip {
		t.Errorf("ip_address 期望 %q，实际 %v", ip, challengeRow.IPAddress)
	}

	// 2) 提交错误答案 => 一条 event='fail'，reason 与服务端返回的一致
	failResp := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
		PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig + "x",
		Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 321,
	}), addr)
	requireStatus(t, failResp, 403)

	var failPayload verifySolutionPayload
	decodeInto(t, failResp, &failPayload)
	if failPayload.Reason == "" {
		t.Fatalf("失败响应应带 reason: %s", failResp.Body.String())
	}

	rows = listVerifyRows(t)
	if len(rows) != 2 {
		t.Fatalf("失败后应有 2 条记录，实际 %d 条: %+v", len(rows), rows)
	}
	failRow := rows[1]
	if failRow.Event != model.VerifyEventFail {
		t.Errorf("event 期望 %q，实际 %q", model.VerifyEventFail, failRow.Event)
	}
	if !failRow.Reason.Valid || failRow.Reason.String != failPayload.Reason {
		t.Errorf("reason 期望 %q（与服务端返回一致），实际 %v", failPayload.Reason, failRow.Reason)
	}
	if !failRow.ChallengeID.Valid || failRow.ChallengeID.String != challenge.Data.ChallengeID {
		t.Errorf("fail 记录的 challenge_id 期望 %q，实际 %v", challenge.Data.ChallengeID, failRow.ChallengeID)
	}
	if !failRow.ElapsedMs.Valid || failRow.ElapsedMs.Int64 != 321 {
		t.Errorf("fail 的 elapsed_ms 期望 321，实际 %v", failRow.ElapsedMs)
	}

	// 3) 成功通过 => 一条 event='pass'，elapsed_ms 等于请求体里的值
	second := requestChallenge(t, slug, addr)
	passResp := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
		PostSlug: slug, Prefix: second.Data.Prefix, Sig: second.Data.Sig,
		Nonces: solvePow(t, second.Data.Pow), ElapsedMs: 742,
	}), addr)
	requireStatus(t, passResp, 200)

	rows = listVerifyRows(t)
	if len(rows) != 4 {
		t.Fatalf("通过后应有 4 条记录，实际 %d 条: %+v", len(rows), rows)
	}
	passRow := rows[len(rows)-1]
	if passRow.Event != model.VerifyEventPass {
		t.Errorf("event 期望 %q，实际 %q", model.VerifyEventPass, passRow.Event)
	}
	if !passRow.ElapsedMs.Valid || passRow.ElapsedMs.Int64 != 742 {
		t.Errorf("pass 的 elapsed_ms 应等于请求体里的 742，实际 %v", passRow.ElapsedMs)
	}
	if passRow.Reason.Valid {
		t.Errorf("通过事件的 reason 应为 NULL，实际 %q", passRow.Reason.String)
	}
	if !passRow.ChallengeID.Valid || passRow.ChallengeID.String != second.Data.ChallengeID {
		t.Errorf("pass 记录的 challenge_id 期望 %q，实际 %v", second.Data.ChallengeID, passRow.ChallengeID)
	}
	if !passRow.Difficulty.Valid || passRow.Difficulty.Int64 != wantDifficulty {
		t.Errorf("pass 的 difficulty 期望 %d，实际 %v", wantDifficulty, passRow.Difficulty)
	}
}

// TestVerifyChallengeDifficultySemantics 钉住 v2 的难度语义（总哈希次数）与 v1 旧值迁移
func TestVerifyChallengeDifficultySemantics(t *testing.T) {
	resetState(t)

	for _, tc := range []struct {
		setting string
		wantD   int
		comment string
	}{
		{"1000", 250, "下限：总次数 1000"},
		{"4000", 1000, "总次数按 count=4 均分"},
		{"1000000", 250000, "默认档"},
		{"999", 250, "低于下限被夹到 1000"},
		{"1", 250, "低于下限被夹到 1000"},
		{"0", 250000, "与 Node 一致：< 1 回退默认（1e6）"},
		{"-5", 250000, "负数回退默认"},
		{"abc", 250000, "非数字回退默认"},
		{"", 250000, "空值回退默认"},
		{"18", 65536, "旧值 18 按 2^18 迁移"},
		{"16", 16384, "旧值 16 按 2^16 迁移"},
		{"20", 262144, "旧值 20 按 2^20 迁移"},
		{"26", 262144, "旧值 26 钳到 2^20"},
		{"1000000000", 250000000, "上界"},
		{"99999999999", 250000000, "超上界被钳到 1e9"},
	} {
		t.Run("difficulty="+tc.setting, func(t *testing.T) {
			enableVerify(t, tc.setting)

			var payload verifyChallengePayload
			decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), &payload)
			if payload.Data.Pow.D != tc.wantD {
				t.Errorf("%s：d 期望 %d，实际 %d", tc.comment, tc.wantD, payload.Data.Pow.D)
			}
			if payload.Data.Pow.Count != 4 {
				t.Errorf("count 应恒为 4，实际 %d", payload.Data.Pow.Count)
			}
		})
	}
}

// TestVerifyChallengeSanitizesSlug post_slug 的净化口径与 Node 的
// `checkContent(...).slice(0, 200)` 一致：只做 XSS 清洗 + 按字节截断，
// 不额外 trim（Node 也不 trim），否则同一篇文章在两次请求里会被净化成不同字符串。
func TestVerifyChallengeSanitizesSlug(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	longSlug := "/" + strings.Repeat("s", 300)
	w := callJSON(t, "POST", "/api/verify/challenge", fmt.Sprintf(`{"post_slug":%q}`, longSlug))
	requireStatus(t, w, 200)

	var payload verifyChallengePayload
	decodeInto(t, w, &payload)
	if len(payload.Data.PostSlug) != 200 {
		t.Errorf("超长 slug 应被截断为 200 字节，实际 %d", len(payload.Data.PostSlug))
	}
	// 截断后的 slug 必须与签进载荷的一致
	raw, err := b64urlDecodeForTest(payload.Data.Prefix)
	if err != nil {
		t.Fatalf("prefix 不是合法 base64url: %v", err)
	}
	if !strings.Contains(string(raw), `,"slug":"`+payload.Data.PostSlug+`","iat":`) {
		t.Errorf("签进载荷的 slug 必须与响应里的 post_slug 一致，实际 %s", raw)
	}

	// 与 Node 一致：不 trim（首尾空白原样保留），因为提交答案时用的是同一个净化函数
	var spaced verifyChallengePayload
	decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"  /p  "}`), &spaced)
	if spaced.Data.PostSlug != "  /p  " {
		t.Errorf("slug 不应被 trim（与 Node 的 checkContent 一致），实际 %q", spaced.Data.PostSlug)
	}

	// XSS 清洗必须生效（这也是与 Node 共用的净化规则）
	var cleaned verifyChallengePayload
	decodeInto(t, callJSON(t, "POST", "/api/verify/challenge",
		`{"post_slug":"/posts/<script>alert(1)</script>a"}`), &cleaned)
	if cleaned.Data.PostSlug != "/posts/a" {
		t.Errorf("slug 中的 script 块应被净化掉，实际 %q", cleaned.Data.PostSlug)
	}

	// 多字节 slug 被按字节截断，接口仍应正常返回
	multi := strings.Repeat("汉", 100)
	w = callJSON(t, "POST", "/api/verify/challenge", fmt.Sprintf(`{"post_slug":%q}`, multi))
	requireStatus(t, w, 200)
}

func TestVerifyChallengeWithInstrumentation(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")
	setSetting(t, "comment_verify_instr_enabled", "true")

	var payload verifyChallengePayload
	decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), &payload)

	if payload.Data.Instr == nil {
		t.Fatalf("开启第二层时必须下发 instr")
	}
	if payload.Data.Instr.Fonts != 17 {
		t.Errorf("fonts 应为字体栈数量 17，实际 %d", payload.Data.Instr.Fonts)
	}
	if len(payload.Data.Instr.Ops) == 0 || len(payload.Data.Instr.Ops)%3 != 0 {
		t.Fatalf("ops 必须是非空的 3 的倍数，实际 %d 个", len(payload.Data.Instr.Ops))
	}
	if len(payload.Data.Instr.Ops) > (utils.InstrMaxOps+12)*3 {
		t.Errorf("ops 长度超出上限: %d", len(payload.Data.Instr.Ops))
	}
	// 下发的程序必须能被影子模型解释（同一条程序客户端要真的在 DOM 上跑一遍）
	if _, ok := utils.InterpretProgram(utils.InstrumentationProgram{Ops: payload.Data.Instr.Ops}); !ok {
		t.Errorf("下发的程序无法被影子模型解释（这是实现缺陷）")
	}

	// 关闭第二层后 instr 必须整个缺席
	setSetting(t, "comment_verify_instr_enabled", "false")
	var withoutInstr verifyChallengePayload
	decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), &withoutInstr)
	if withoutInstr.Data.Instr != nil {
		t.Errorf("关闭第二层后不应下发 instr")
	}
}

// ---------------------------------------------------------------------------
// POST /api/verify/solution
// ---------------------------------------------------------------------------

func TestVerifySolutionWhenDisabled(t *testing.T) {
	resetState(t)

	w := callJSON(t, "POST", "/api/verify/solution",
		`{"post_slug":"/p","prefix":"x","sig":"y","nonces":["1"],"elapsed_ms":500}`)
	requireStatus(t, w, 200)

	var payload verifySolutionPayload
	decodeInto(t, w, &payload)
	if payload.Data.Enabled {
		t.Errorf("关闭状态下 enabled 应为 false")
	}
	if payload.Data.Version != 2 {
		t.Errorf("关闭状态下也应下发 version=2，实际 %d", payload.Data.Version)
	}
	if payload.Message != "Verification disabled" {
		t.Errorf("message 期望 Verification disabled，实际 %q", payload.Message)
	}
	if payload.Data.Ticket != "" {
		t.Errorf("关闭状态下不应签发票据")
	}
}

func TestVerifySolutionRoundTripAndTicketUsage(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	ip := nextIP()
	addr := ip + ":1234"
	slug := "/posts/hello"

	challenge := requestChallenge(t, slug, addr)
	nonces := solvePow(t, challenge.Data.Pow)

	w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
		PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
		Nonces: nonces, ElapsedMs: 500,
	}), addr)
	requireStatus(t, w, 200)

	var solution verifySolutionPayload
	decodeInto(t, w, &solution)
	if solution.Message != "Verification passed" {
		t.Errorf("message 期望 Verification passed，实际 %q", solution.Message)
	}
	if solution.Data.Version != 2 {
		t.Errorf("version 期望 2，实际 %d", solution.Data.Version)
	}
	if solution.Data.Ticket == "" {
		t.Fatalf("应签发票据，实际 %+v", solution.Data)
	}
	if solution.Data.ExpiresIn != 300 {
		t.Errorf("票据有效期期望 300 秒，实际 %d", solution.Data.ExpiresIn)
	}
	if strings.Count(solution.Data.Ticket, ".") != 1 {
		t.Errorf("票据格式应为 body.sig，实际 %q", solution.Data.Ticket)
	}
	// 票据载荷必须是 v2
	body, _, _ := strings.Cut(solution.Data.Ticket, ".")
	ticketJSON, err := b64urlDecodeForTest(body)
	if err != nil {
		t.Fatalf("票据 body 不是合法 base64url: %v", err)
	}
	if !strings.HasPrefix(string(ticketJSON), `{"v":2,"iph":`) {
		t.Errorf("票据载荷字段顺序必须是 v/iph/slug/iat/exp/jti，实际 %s", ticketJSON)
	}

	// 票据可用于提交评论
	commentBody := fmt.Sprintf(`{"post_slug":%q,"author":"a","email":"a@b.com","content":"内容","verify_ticket":%q}`,
		slug, solution.Data.Ticket)
	commentResp := callFromIP(t, "POST", "/api/comments", commentBody, addr)
	requireStatus(t, commentResp, 200)
	if countComments(t) != 1 {
		t.Errorf("票据有效时应写入评论，实际 %d 条", countComments(t))
	}
	if got := latestComment(t).Status; got != "approved" {
		t.Errorf("默认应通过审核，实际 %q", got)
	}
}

func TestVerifySolutionRejections(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	ip := nextIP()
	addr := ip + ":1234"
	slug := "/p"

	challenge := requestChallenge(t, slug, addr)
	nonces := solvePow(t, challenge.Data.Pow)

	t.Run("请求体非法返回 400", func(t *testing.T) {
		for _, body := range []string{"", "{", "[]"} {
			w := callFromIP(t, "POST", "/api/verify/solution", body, nextRemoteAddr())
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
		}
	})

	t.Run("蜜罐字段被填写", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: nonces, ElapsedMs: 500, Hp: "bot",
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "honeypot" {
			t.Errorf("reason 期望 honeypot，实际 %q", payload.Reason)
		}
	})

	t.Run("签名错误", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig + "x",
			Nonces: nonces, ElapsedMs: 500,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "bad signature" {
			t.Errorf("reason 期望 bad signature，实际 %q", payload.Reason)
		}
	})

	t.Run("缺少挑战字段", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Nonces: nonces, ElapsedMs: 500,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "missing challenge" {
			t.Errorf("reason 期望 missing challenge，实际 %q", payload.Reason)
		}
	})

	t.Run("IP 不匹配", func(t *testing.T) {
		// 用 A 的挑战、从 B 提交
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: nonces, ElapsedMs: 500,
		}), nextRemoteAddr())
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "ip mismatch" {
			t.Errorf("reason 期望 ip mismatch，实际 %q", payload.Reason)
		}
	})

	t.Run("解题耗时不合理", func(t *testing.T) {
		// 下限 50ms（v2 由 v1 的 300ms 下调），上限为挑战有效期
		for _, elapsed := range []int64{0, 49, 600001} {
			w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
				PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
				Nonces: nonces, ElapsedMs: elapsed,
			}), addr)
			requireStatus(t, w, 403)

			var payload verifySolutionPayload
			decodeInto(t, w, &payload)
			if payload.Reason != "implausible timing" {
				t.Errorf("elapsed=%d 时 reason 期望 implausible timing，实际 %q", elapsed, payload.Reason)
			}
		}
	})

	t.Run("nonces 数量不匹配", func(t *testing.T) {
		for _, bad := range [][]string{{}, {"1"}, {"1", "2", "3", "4", "5"}} {
			w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
				PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
				Nonces: bad, ElapsedMs: 500,
			}), addr)
			requireStatus(t, w, 403)

			var payload verifySolutionPayload
			decodeInto(t, w, &payload)
			if payload.Reason != "solution count mismatch" {
				t.Errorf("nonces 数量 %d 时 reason 期望 solution count mismatch，实际 %q", len(bad), payload.Reason)
			}
		}
	})

	t.Run("非法的 nonce", func(t *testing.T) {
		bad := append([]string{"0x10"}, nonces[1:]...)
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: bad, ElapsedMs: 500,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "bad nonce" {
			t.Errorf("reason 期望 bad nonce，实际 %q", payload.Reason)
		}
	})

	t.Run("工作量不足", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: insufficientPow(t, challenge.Data.Pow), ElapsedMs: 500,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "insufficient work" {
			t.Errorf("reason 期望 insufficient work，实际 %q", payload.Reason)
		}
	})

	t.Run("非法的 base64url 前缀", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: "!!!", Sig: "sig", Nonces: nonces, ElapsedMs: 500,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "bad signature" {
			t.Errorf("非法前缀应因签名不匹配被拒绝，实际 reason=%q", payload.Reason)
		}
	})
}

func TestVerifySolutionReplayProtection(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	ip := nextIP()
	addr := ip + ":1234"
	slug := "/p"

	challenge := requestChallenge(t, slug, addr)
	body := solutionBody(t, verifySolutionRequest{
		PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
		Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500,
	})

	requireStatus(t, callFromIP(t, "POST", "/api/verify/solution", body, addr), 200)

	// v2：挑战是单次使用的，第二次提交（即使答案正确）必须被拒
	w := callFromIP(t, "POST", "/api/verify/solution", body, addr)
	requireStatus(t, w, 403)

	var payload verifySolutionPayload
	decodeInto(t, w, &payload)
	if payload.Reason != "challenge already used" {
		t.Errorf("reason 期望 challenge already used，实际 %q", payload.Reason)
	}
}

func TestVerifySolutionTicketBindsSlug(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	ip := nextIP()
	addr := ip + ":1234"

	challenge := requestChallenge(t, "/p", addr)

	var solution verifySolutionPayload
	decodeInto(t, callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
		PostSlug: "/p", Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
		Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500,
	}), addr), &solution)
	if solution.Data.Ticket == "" {
		t.Fatalf("应签发票据")
	}

	// 用绑定 /p 的票据提交到其他文章必须失败
	body := fmt.Sprintf(`{"post_slug":"/other","author":"a","email":"a@b.com","content":"内容","verify_ticket":%q}`, solution.Data.Ticket)
	w := callFromIP(t, "POST", "/api/comments", body, addr)
	requireStatus(t, w, 403)

	var reject struct {
		Reason string `json:"reason"`
	}
	decodeInto(t, w, &reject)
	if reject.Reason != "VERIFY_REQUIRED" {
		t.Errorf("reason 期望 VERIFY_REQUIRED，实际 %q", reject.Reason)
	}
	if countComments(t) != 0 {
		t.Errorf("跨文章票据不应写入评论")
	}
}

// TestVerifySolutionChallengeBindsPostSlug 回归用例（安全修复）：
// 挑战被签名绑定到签发它的文章（post_slug 在载荷里），因此
// 「一次工作量证明在同一 IP 上换成任意文章的票据」必须失败。
func TestVerifySolutionChallengeBindsPostSlug(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	ip := nextIP()
	addr := ip + ":1234"
	const slugA = "/posts/a"
	const slugB = "/posts/b"

	challenge := requestChallenge(t, slugA, addr)
	nonces := solvePow(t, challenge.Data.Pow)

	redeemAs := func(t *testing.T, slug string) (int, verifySolutionPayload) {
		t.Helper()
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: nonces, ElapsedMs: 500,
		}), addr)
		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		return w.Code, payload
	}

	// 1. 为文章 A 签发的挑战，用文章 B 兑换必须被拒绝
	if code, payload := redeemAs(t, slugB); code != 403 {
		t.Fatalf("跨文章兑换应返回 403，实际 %d（reason=%q）", code, payload.Reason)
	} else if payload.Reason != "slug mismatch" {
		t.Errorf("reason 期望 slug mismatch，实际 %q", payload.Reason)
	}

	// 2. 空文章名同样不行
	if code, payload := redeemAs(t, ""); code != 403 {
		t.Fatalf("空 slug 应返回 403，实际 %d", code)
	} else if payload.Reason != "slug mismatch" {
		t.Errorf("空 slug 的 reason 期望 slug mismatch，实际 %q", payload.Reason)
	}

	// 3. 原文章 A 兑换成功（前两次失败发生在防重放之前，不应消耗挑战）
	code, solution := redeemAs(t, slugA)
	if code != 200 {
		t.Fatalf("原文章 A 的兑换应返回 200，实际 %d（reason=%q）", code, solution.Reason)
	}
	if solution.Data.Ticket == "" {
		t.Fatalf("应签发票据，实际 %+v", solution.Data)
	}

	// 票据里的 slug 必须是 A（票据本身也绑定文章）
	body, _, _ := strings.Cut(solution.Data.Ticket, ".")
	ticketJSON, err := b64urlDecodeForTest(body)
	if err != nil {
		t.Fatalf("票据 body 不是合法 base64url: %v", err)
	}
	var ticket struct {
		Slug string `json:"slug"`
	}
	if err := json.Unmarshal(ticketJSON, &ticket); err != nil {
		t.Fatalf("票据载荷不是合法 JSON: %v", err)
	}
	if ticket.Slug != slugA {
		t.Errorf("票据里的 slug 期望 %q，实际 %q", slugA, ticket.Slug)
	}
	if !strings.HasPrefix(string(ticketJSON), `{"v":2,"iph":`) ||
		!strings.Contains(string(ticketJSON), `,"slug":"`+slugA+`","iat":`) {
		t.Errorf("票据载荷字段顺序必须是 v/iph/slug/iat/exp/jti，实际 %s", ticketJSON)
	}

	// 4. 用这张票据去提交文章 B 的评论必须被拒（票据也不能跨文章使用）
	commentBody := fmt.Sprintf(
		`{"post_slug":%q,"author":"a","email":"a@b.com","content":"内容","verify_ticket":%q}`,
		slugB, solution.Data.Ticket)
	commentResp := callFromIP(t, "POST", "/api/comments", commentBody, addr)
	requireStatus(t, commentResp, 403)
	if countComments(t) != 0 {
		t.Errorf("跨文章票据不应写入评论")
	}
}

// TestVerifySolutionSanitizesPostSlugConsistently 挑战与答案两处必须共用同一套
// post_slug 净化规则，否则会被净化过的文章名兑换自己的票据时会被误判成 slug mismatch。
func TestVerifySolutionSanitizesPostSlugConsistently(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")

	ip := nextIP()
	addr := ip + ":1234"
	const rawSlug = "/posts/<script>alert(1)</script>end"

	challenge := requestChallenge(t, rawSlug, addr)
	if challenge.Data.PostSlug != "/posts/end" {
		t.Fatalf("前置条件：挑战响应里的 post_slug 应是净化后的值，实际 %q", challenge.Data.PostSlug)
	}

	// 提交的是**原始** slug（前端手里就是原值），净化后与签发时一致，必须成功
	w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
		PostSlug: rawSlug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
		Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500,
	}), addr)
	requireStatus(t, w, 200)

	var solution verifySolutionPayload
	decodeInto(t, w, &solution)
	if solution.Data.Ticket == "" {
		t.Errorf("两处净化规则一致时应能换到票据，实际 %+v", solution.Data)
	}
}

// TestVerifySolutionWithInstrumentation 走完整的第二层链路：
// 客户端侧用影子模型（或真实 DOM）执行服务端下发的程序，把寄存器与环境向量回传。
func TestVerifySolutionWithInstrumentation(t *testing.T) {
	resetState(t)
	enableVerify(t, "1000")
	setSetting(t, "comment_verify_instr_enabled", "true")

	ip := nextIP()
	addr := ip + ":1234"
	slug := "/p"

	// 一个「真实浏览器」的基线环境向量：所有拦截规则都不命中
	goodEnv := func() map[string]any {
		return map[string]any{
			"cd":  float64(0),
			"ua":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36",
			"br":  `"Chromium";v="120"`,
			"ge":  float64(1),
			"dm":  float64(8),
			"tm":  []any{10.5, 10.75, 11.25, 12.5, 13.125, 9.5},
			"lw":  float64(120.5),
			"lh":  float64(32.25),
			"iw":  float64(1200),
			"ih":  float64(800),
			"ow":  float64(1210),
			"oh":  float64(900),
			"sw":  float64(1920),
			"sh":  float64(1080),
			"ex":  float64(0),
			"mob": float64(0),
			"nt":  float64(0),
		}
	}

	answerFor := func(t *testing.T, challenge verifyChallengePayload) *instrAnswerBody {
		t.Helper()
		if challenge.Data.Instr == nil {
			t.Fatalf("开启第二层时必须下发 instr")
		}
		// 客户端侧独立执行程序（这里用影子模型；浏览器用的是真实 DOM，
		// 两者语义必须一致 —— doc/vectors/instrumentation-v2.json 就是为此存在的）
		regs, ok := utils.InterpretProgram(utils.InstrumentationProgram{Ops: challenge.Data.Instr.Ops})
		if !ok {
			t.Fatalf("服务端下发的程序无法被解释")
		}
		env := goodEnv()
		return &instrAnswerBody{
			Regs: []int32{regs[0], regs[1], regs[2], regs[3]},
			Env:  env,
			Lw:   120.5,
			Lh:   32.25,
			Tm:   []float64{10.5, 10.75, 11.25, 12.5, 13.125, 9.5},
		}
	}

	t.Run("缺少 instr 时拒绝", func(t *testing.T) {
		challenge := requestChallenge(t, slug, addr)
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "malformed registers" {
			t.Errorf("reason 期望 malformed registers，实际 %q", payload.Reason)
		}
	})

	t.Run("合法答案通过并换到票据", func(t *testing.T) {
		challenge := requestChallenge(t, slug, addr)
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500,
			Instr: answerFor(t, challenge),
		}), addr)
		requireStatus(t, w, 200)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Data.Ticket == "" {
			t.Errorf("合法答案应签发票据")
		}
	})

	t.Run("寄存器不匹配时拒绝", func(t *testing.T) {
		challenge := requestChallenge(t, slug, addr)
		answer := answerFor(t, challenge)
		answer.Regs[1]++
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500, Instr: answer,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "program result mismatch" {
			t.Errorf("reason 期望 program result mismatch，实际 %q", payload.Reason)
		}
	})

	t.Run("布局探针为 0 时按自动化特征处理", func(t *testing.T) {
		// block_automated 默认关闭：只记录不拦截，因此这里必须仍然通过
		challenge := requestChallenge(t, slug, addr)
		answer := answerFor(t, challenge)
		answer.Lw = 0
		answer.Lh = 0
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500, Instr: answer,
		}), addr)
		requireStatus(t, w, 200)
	})

	t.Run("block_automated 开启后命中规则即拒绝", func(t *testing.T) {
		setSetting(t, "comment_verify_block_automated", "true")
		defer setSetting(t, "comment_verify_block_automated", "false")

		challenge := requestChallenge(t, slug, addr)
		answer := answerFor(t, challenge)
		answer.Lw = 0
		answer.Lh = 0
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: solvePow(t, challenge.Data.Pow), ElapsedMs: 500, Instr: answer,
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "automated browser detected: layout_zero" {
			t.Errorf("reason 期望 automated browser detected: layout_zero，实际 %q", payload.Reason)
		}
	})

	t.Run("第二层失败会烧掉挑战", func(t *testing.T) {
		challenge := requestChallenge(t, slug, addr)
		nonces := solvePow(t, challenge.Data.Pow)

		// 第一次：算力通过但缺少第二层答案
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: nonces, ElapsedMs: 500,
		}), addr)
		requireStatus(t, w, 403)

		// 第二次：补上正确的第二层答案也不能再用（否则可以拿同一算力证明反复刷环境向量）
		w = callFromIP(t, "POST", "/api/verify/solution", solutionBody(t, verifySolutionRequest{
			PostSlug: slug, Prefix: challenge.Data.Prefix, Sig: challenge.Data.Sig,
			Nonces: nonces, ElapsedMs: 500, Instr: answerFor(t, challenge),
		}), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "challenge already used" {
			t.Errorf("reason 期望 challenge already used，实际 %q", payload.Reason)
		}
	})
}

// b64urlDecodeForTest 解 base64url（容忍填充），只用于检查载荷字段顺序
func b64urlDecodeForTest(input string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(input, "="))
}
