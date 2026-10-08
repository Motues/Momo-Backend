package http

import (
	"crypto/sha256"
	"fmt"
	"math/bits"
	"strconv"
	"strings"
	"testing"
)

type verifyChallengePayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Enabled     bool   `json:"enabled"`
		PostSlug    string `json:"post_slug"`
		ChallengeID string `json:"challenge_id"`
		Prefix      string `json:"prefix"`
		Difficulty  int    `json:"difficulty"`
		ExpiresIn   int    `json:"expires_in"`
		Sig         string `json:"sig"`
	} `json:"data"`
}

type verifySolutionPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Reason  string `json:"reason"`
	Data    struct {
		Enabled   bool   `json:"enabled"`
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	} `json:"data"`
}

// solveChallenge 在测试侧独立实现工作量证明：找到满足前导 0 比特数的 nonce
func solveChallenge(t *testing.T, prefix string, difficulty int) int64 {
	t.Helper()
	for nonce := int64(0); nonce < 5_000_000; nonce++ {
		if leadingZeroBitsOf(prefix, nonce) >= difficulty {
			return nonce
		}
	}
	t.Fatalf("无法在限定次数内解出难度 %d 的挑战", difficulty)
	return -1
}

// insufficientNonce 找出一个工作量不达标的 nonce
func insufficientNonce(t *testing.T, prefix string, difficulty int) int64 {
	t.Helper()
	for nonce := int64(0); nonce < 1_000_000; nonce++ {
		if leadingZeroBitsOf(prefix, nonce) < difficulty {
			return nonce
		}
	}
	t.Fatalf("找不到工作量不达标的 nonce（难度 %d）", difficulty)
	return -1
}

func leadingZeroBitsOf(prefix string, nonce int64) int {
	sum := sha256.Sum256([]byte(prefix + ":" + strconv.FormatInt(nonce, 10)))
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

// solutionBody 构造校验答案请求体
func solutionBody(slug, prefix, sig string, nonce, elapsed int64) string {
	return fmt.Sprintf(`{"post_slug":%q,"prefix":%q,"sig":%q,"nonce":%d,"elapsed_ms":%d}`,
		slug, prefix, sig, nonce, elapsed)
}

// enableVerify 开启无感验证并设置难度
func enableVerify(t *testing.T, difficulty string) {
	t.Helper()
	setSetting(t, "comment_verify_enabled", "true")
	setSetting(t, "comment_verify_difficulty", difficulty)
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
			if payload.Message != "Verification disabled" {
				t.Errorf("message 期望 Verification disabled，实际 %q", payload.Message)
			}
			if payload.Data.Prefix != "" || payload.Data.Sig != "" {
				t.Errorf("关闭状态下不应签发挑战: %+v", payload.Data)
			}
		})
	}
}

func TestVerifyChallengeWhenEnabled(t *testing.T) {
	resetState(t)
	enableVerify(t, "8")

	w := callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/posts/hello"}`)
	requireStatus(t, w, 200)

	var payload verifyChallengePayload
	decodeInto(t, w, &payload)

	if !payload.Data.Enabled {
		t.Fatalf("开启状态下 enabled 应为 true")
	}
	if payload.Message != "Challenge issued" {
		t.Errorf("message 期望 Challenge issued，实际 %q", payload.Message)
	}
	if payload.Data.Prefix == "" || payload.Data.Sig == "" || payload.Data.ChallengeID == "" {
		t.Fatalf("挑战字段不应为空: %+v", payload.Data)
	}
	if payload.Data.Difficulty != 8 {
		t.Errorf("difficulty 期望 8，实际 %d", payload.Data.Difficulty)
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

	// 两次签发应得到不同挑战
	var second verifyChallengePayload
	decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/posts/hello"}`), &second)
	if second.Data.ChallengeID == payload.Data.ChallengeID {
		t.Errorf("两次签发的 challenge_id 不应相同")
	}
}

func TestVerifyChallengeDifficultyClamp(t *testing.T) {
	resetState(t)

	for _, tc := range []struct {
		setting string
		want    int
	}{
		{"8", 8},
		{"12", 12},
		{"26", 26},
		{"1", 8},
		{"0", 8},
		{"-5", 8},
		{"27", 26},
		{"999", 26},
		{"abc", 18},
		{"", 18},
	} {
		t.Run("difficulty="+tc.setting, func(t *testing.T) {
			setSetting(t, "comment_verify_enabled", "true")
			setSetting(t, "comment_verify_difficulty", tc.setting)

			var payload verifyChallengePayload
			decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`), &payload)
			if payload.Data.Difficulty != tc.want {
				t.Errorf("difficulty 期望 %d，实际 %d", tc.want, payload.Data.Difficulty)
			}
		})
	}
}

func TestVerifyChallengeClampsSlug(t *testing.T) {
	resetState(t)
	enableVerify(t, "8")

	longSlug := "/" + strings.Repeat("s", 300)
	w := callJSON(t, "POST", "/api/verify/challenge", fmt.Sprintf(`{"post_slug":%q}`, longSlug))
	requireStatus(t, w, 200)

	var payload verifyChallengePayload
	decodeInto(t, w, &payload)
	if len(payload.Data.PostSlug) != 200 {
		t.Errorf("超长 slug 应被截断为 200 字节，实际 %d", len(payload.Data.PostSlug))
	}

	// 首尾空白会被去掉
	var trimmed verifyChallengePayload
	decodeInto(t, callJSON(t, "POST", "/api/verify/challenge", `{"post_slug":"  /p  "}`), &trimmed)
	if trimmed.Data.PostSlug != "/p" {
		t.Errorf("slug 应去除首尾空白，实际 %q", trimmed.Data.PostSlug)
	}

	// 多字节 slug 被按字节截断，接口仍应正常返回
	multi := strings.Repeat("汉", 100)
	w = callJSON(t, "POST", "/api/verify/challenge", fmt.Sprintf(`{"post_slug":%q}`, multi))
	requireStatus(t, w, 200)
}

// ---------------------------------------------------------------------------
// POST /api/verify/solution
// ---------------------------------------------------------------------------

func TestVerifySolutionWhenDisabled(t *testing.T) {
	resetState(t)

	w := callJSON(t, "POST", "/api/verify/solution", `{"post_slug":"/p","prefix":"x","sig":"y","nonce":1,"elapsed_ms":500}`)
	requireStatus(t, w, 200)

	var payload verifySolutionPayload
	decodeInto(t, w, &payload)
	if payload.Data.Enabled {
		t.Errorf("关闭状态下 enabled 应为 false")
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
	enableVerify(t, "8")

	ip := nextIP()
	addr := ip + ":1234"
	slug := "/posts/hello"

	var challenge verifyChallengePayload
	decodeInto(t, callFromIP(t, "POST", "/api/verify/challenge", fmt.Sprintf(`{"post_slug":%q}`, slug), addr), &challenge)
	if !challenge.Data.Enabled {
		t.Fatalf("挑战未签发: %+v", challenge.Data)
	}

	nonce := solveChallenge(t, challenge.Data.Prefix, challenge.Data.Difficulty)
	w := callFromIP(t, "POST", "/api/verify/solution",
		solutionBody(slug, challenge.Data.Prefix, challenge.Data.Sig, nonce, 500), addr)
	requireStatus(t, w, 200)

	var solution verifySolutionPayload
	decodeInto(t, w, &solution)
	if solution.Message != "Verification passed" {
		t.Errorf("message 期望 Verification passed，实际 %q", solution.Message)
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

	// 票据可用于提交评论
	body := fmt.Sprintf(`{"post_slug":%q,"author":"a","email":"a@b.com","content":"内容","verify_ticket":%q}`,
		slug, solution.Data.Ticket)
	commentResp := callFromIP(t, "POST", "/api/comments", body, addr)
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
	enableVerify(t, "8")

	ip := nextIP()
	addr := ip + ":1234"
	slug := "/p"

	// 取一个真实挑战作为基准
	var challenge verifyChallengePayload
	decodeInto(t, callFromIP(t, "POST", "/api/verify/challenge", fmt.Sprintf(`{"post_slug":%q}`, slug), addr), &challenge)
	nonce := solveChallenge(t, challenge.Data.Prefix, challenge.Data.Difficulty)

	t.Run("请求体非法返回 400", func(t *testing.T) {
		for _, body := range []string{"", "{", "[]"} {
			w := callFromIP(t, "POST", "/api/verify/solution", body, nextRemoteAddr())
			requireStatus(t, w, 400)
			requireBodyCode(t, w, 400)
		}
	})

	t.Run("蜜罐字段被填写", func(t *testing.T) {
		body := fmt.Sprintf(`{"post_slug":%q,"prefix":%q,"sig":%q,"nonce":%d,"elapsed_ms":500,"hp":"bot"}`,
			slug, challenge.Data.Prefix, challenge.Data.Sig, nonce)
		w := callFromIP(t, "POST", "/api/verify/solution", body, addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "honeypot" {
			t.Errorf("reason 期望 honeypot，实际 %q", payload.Reason)
		}
	})

	t.Run("签名错误", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution",
			solutionBody(slug, challenge.Data.Prefix, challenge.Data.Sig+"x", nonce, 500), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "bad signature" {
			t.Errorf("reason 期望 bad signature，实际 %q", payload.Reason)
		}
	})

	t.Run("缺少挑战字段", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(slug, "", "", nonce, 500), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "missing challenge" {
			t.Errorf("reason 期望 missing challenge，实际 %q", payload.Reason)
		}
	})

	t.Run("IP 不匹配", func(t *testing.T) {
		// 用 A 的挑战、从 B 提交
		w := callFromIP(t, "POST", "/api/verify/solution",
			solutionBody(slug, challenge.Data.Prefix, challenge.Data.Sig, nonce, 500), nextRemoteAddr())
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "ip mismatch" {
			t.Errorf("reason 期望 ip mismatch，实际 %q", payload.Reason)
		}
	})

	t.Run("解题耗时不合理", func(t *testing.T) {
		for _, elapsed := range []int64{0, 100, 299, 600001} {
			w := callFromIP(t, "POST", "/api/verify/solution",
				solutionBody(slug, challenge.Data.Prefix, challenge.Data.Sig, nonce, elapsed), addr)
			requireStatus(t, w, 403)

			var payload verifySolutionPayload
			decodeInto(t, w, &payload)
			if payload.Reason != "implausible timing" {
				t.Errorf("elapsed=%d 时 reason 期望 implausible timing，实际 %q", elapsed, payload.Reason)
			}
		}
	})

	t.Run("工作量不足", func(t *testing.T) {
		badNonce := insufficientNonce(t, challenge.Data.Prefix, challenge.Data.Difficulty)
		w := callFromIP(t, "POST", "/api/verify/solution",
			solutionBody(slug, challenge.Data.Prefix, challenge.Data.Sig, badNonce, 500), addr)
		requireStatus(t, w, 403)

		var payload verifySolutionPayload
		decodeInto(t, w, &payload)
		if payload.Reason != "insufficient work" {
			t.Errorf("reason 期望 insufficient work，实际 %q", payload.Reason)
		}
	})

	t.Run("非法的 base64url 前缀", func(t *testing.T) {
		w := callFromIP(t, "POST", "/api/verify/solution", solutionBody(slug, "!!!", "sig", 1, 500), addr)
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
	enableVerify(t, "8")

	ip := nextIP()
	addr := ip + ":1234"
	slug := "/p"

	var challenge verifyChallengePayload
	decodeInto(t, callFromIP(t, "POST", "/api/verify/challenge", fmt.Sprintf(`{"post_slug":%q}`, slug), addr), &challenge)
	nonce := solveChallenge(t, challenge.Data.Prefix, challenge.Data.Difficulty)

	body := solutionBody(slug, challenge.Data.Prefix, challenge.Data.Sig, nonce, 500)

	w := callFromIP(t, "POST", "/api/verify/solution", body, addr)
	requireStatus(t, w, 200)

	w = callFromIP(t, "POST", "/api/verify/solution", body, addr)
	requireStatus(t, w, 403)

	var payload verifySolutionPayload
	decodeInto(t, w, &payload)
	if payload.Reason != "replayed nonce" {
		t.Errorf("reason 期望 replayed nonce，实际 %q", payload.Reason)
	}
}

func TestVerifySolutionTicketBindsSlug(t *testing.T) {
	resetState(t)
	enableVerify(t, "8")

	ip := nextIP()
	addr := ip + ":1234"

	var challenge verifyChallengePayload
	decodeInto(t, callFromIP(t, "POST", "/api/verify/challenge", `{"post_slug":"/p"}`, addr), &challenge)
	nonce := solveChallenge(t, challenge.Data.Prefix, challenge.Data.Difficulty)

	var solution verifySolutionPayload
	decodeInto(t, callFromIP(t, "POST", "/api/verify/solution",
		solutionBody("/p", challenge.Data.Prefix, challenge.Data.Sig, nonce, 500), addr), &solution)
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
