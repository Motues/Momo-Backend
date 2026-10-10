package utils

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"strconv"
	"testing"
)

/*
hashwx —— 官方已知答案测试（KAT）与派生口径

四个 KAT 向量来自 tevador/hashwx v1.0.0 的 src/tests.c，是「vendor 进来的 wasm
确实实现了官方算法」的唯一凭据（本仓库没有 Emscripten 工具链，无法独立重建二进制），
这组用例必须保持存在且不可放宽。

C 源码里 `uint8_t seed[32] = "..."` 会把剩余字节补 0。
*/

// hashwxSeedOf 把文本按 C 的初始化语义补 NUL 到 32 字节
func hashwxSeedOf(text string) []byte {
	out := make([]byte, HashwxSeedSize)
	copy(out, []byte(text))
	return out
}

var hashwxKatVectors = []struct {
	name     string
	seed     []byte
	nonce    uint64
	expected uint64
}{
	{"seed1 / counter=0", hashwxSeedOf("This is a test seed for hashwx"), 0, 0x973684176f8ee362},
	{"seed1 / counter=123456", hashwxSeedOf("This is a test seed for hashwx"), 123456, 0x401983bb07d69b07},
	{"seed2 / counter=123456", hashwxSeedOf("Lorem ipsum dolor sit amet"), 123456, 0x4af38d834a9a8d3d},
	{"seed2 / counter=987654321123456789", hashwxSeedOf("Lorem ipsum dolor sit amet"), 987654321123456789, 0x6a8a5514432e17a3},
}

func TestHashwxOfficialKAT(t *testing.T) {
	for _, tc := range hashwxKatVectors {
		t.Run(tc.name, func(t *testing.T) {
			got, err := HashwxHash(tc.seed, tc.nonce)
			if err != nil {
				t.Fatalf("HashwxHash 失败: %v", err)
			}
			if got != tc.expected {
				t.Errorf("官方 KAT 不匹配: got=0x%016x want=0x%016x", got, tc.expected)
			}
		})
	}

	t.Run("种子长度不合法时报错", func(t *testing.T) {
		if _, err := HashwxHash(make([]byte, 31), 0); err == nil {
			t.Errorf("31 字节种子应报错")
		}
	})
}

// ---------- 函数种子派生口径 ----------

// vectorChallengeC 固定挑战 00 01 02 ... 1f
func vectorChallengeC() []byte {
	out := make([]byte, HashwxChallengeSize)
	for i := range out {
		out[i] = byte(i)
	}
	return out
}

// blockSeedLocal 与被测实现同算法的本地副本：SHA256(C ‖ u8le(index) ‖ u64le(block))
func blockSeedLocal(t *testing.T, challenge []byte, index int, block uint64) string {
	t.Helper()
	buf := make([]byte, HashwxChallengeSize+1+8)
	copy(buf, challenge)
	buf[HashwxChallengeSize] = byte(index & 0xff)
	binary.LittleEndian.PutUint64(buf[HashwxChallengeSize+1:], block)
	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:])
}

func TestHashwxBlockSeedFormula(t *testing.T) {
	challenge := vectorChallengeC()

	t.Run("C 的 hex 编码", func(t *testing.T) {
		want := "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
		if got := hex.EncodeToString(challenge); got != want {
			t.Fatalf("向量挑战编码漂移: %s", got)
		}
	})

	for _, tc := range []struct {
		name  string
		index int
		block uint64
		want  string
	}{
		{"i=0 / block=0", 0, 0, "e601ef8605dccfe5d026eda2937496fa094ecd4e8911175fc8c8f84bbef0777f"},
		{"i=3 / block=1234567", 3, 1234567, "4f0f41e64098a0481b2f23212cc4d14148e611b3186e7f9492491e0e27929f4a"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seed, err := HashwxBlockSeed(challenge, tc.index, tc.block)
			if err != nil {
				t.Fatalf("HashwxBlockSeed 失败: %v", err)
			}
			if got := hex.EncodeToString(seed); got != tc.want {
				t.Errorf("种子派生口径漂移:\n got=%s\nwant=%s", got, tc.want)
			}
		})
	}

	t.Run("与本地实现一致（多组参数）", func(t *testing.T) {
		for _, index := range []int{0, 1, 3, 17, 255} {
			for _, block := range []uint64{0, 1, 65535, 65536, 1234567, 18446744073709551615} {
				seed, err := HashwxBlockSeed(challenge, index, block)
				if err != nil {
					t.Fatalf("HashwxBlockSeed 失败: %v", err)
				}
				if got, want := hex.EncodeToString(seed), blockSeedLocal(t, challenge, index, block); got != want {
					t.Errorf("index=%d block=%d 派生不一致:\n got=%s\nwant=%s", index, block, got, want)
				}
			}
		}
	})

	t.Run("与 doc/vectors/verify-v2.json 的 hashwx 向量一致", func(t *testing.T) {
		fixture := loadVerifyFixture(t)

		spec, err := MintHashwxSpec(HashwxMintOptions{
			Challenge:     deriveHashwxChallenge(fixture.Cid, fixture.Secret),
			Difficulty:    fixture.Difficulty,
			NoncesPerHash: HashwxDefaultNoncesPerHash,
			Count:         HashwxDefaultChallengeCount,
		})
		if err != nil {
			t.Fatalf("MintHashwxSpec 失败: %v", err)
		}
		if spec.C != fixture.Hashwx.C {
			t.Errorf("挑战派生漂移:\n got=%s\nwant=%s", spec.C, fixture.Hashwx.C)
		}
		if spec.D != fixture.Hashwx.D || spec.N != fixture.Hashwx.N || spec.Count != fixture.Hashwx.Count {
			t.Errorf("spec 参数漂移:\n got=%+v\nwant=%+v", spec, fixture.Hashwx)
		}

		// 种子派生必须与 fixture 的自洽：sha256(C ‖ u8le(i) ‖ u64le(block))
		challenge := ParseHashwxChallenge(fixture.Hashwx.C)
		if challenge == nil {
			t.Fatalf("fixture 的 hashwx.c 不是合法 hex")
		}
		seed, err := HashwxBlockSeed(challenge, 0, 0)
		if err != nil {
			t.Fatalf("HashwxBlockSeed 失败: %v", err)
		}
		if got, want := hex.EncodeToString(seed), blockSeedLocal(t, challenge, 0, 0); got != want {
			t.Errorf("种子派生与本地副本不一致: got=%s want=%s", got, want)
		}
	})

	t.Run("index 与 block 都会改变结果", func(t *testing.T) {
		base, _ := HashwxBlockSeed(challenge, 0, 0)
		byIndex, _ := HashwxBlockSeed(challenge, 1, 0)
		byBlock, _ := HashwxBlockSeed(challenge, 0, 1)
		if string(base) == string(byIndex) {
			t.Errorf("index 应参与派生")
		}
		if string(base) == string(byBlock) {
			t.Errorf("block 应参与派生")
		}
	})

	t.Run("挑战长度不合法时报错", func(t *testing.T) {
		if _, err := HashwxBlockSeed(make([]byte, 31), 0, 0); err == nil {
			t.Errorf("31 字节挑战应报错")
		}
	})
}

// ---------- 目标阈值 ----------

func TestHashwxTarget(t *testing.T) {
	t.Run("d=1 时 target 为 u64 最大值", func(t *testing.T) {
		target, err := HashwxTarget(1)
		if err != nil {
			t.Fatalf("HashwxTarget(1) 失败: %v", err)
		}
		if target != ^uint64(0) {
			t.Errorf("d=1 时 target 应为 u64 最大值，实际 %d", target)
		}
	})

	t.Run("d=2 时 target 为 (2^64-1)/2", func(t *testing.T) {
		target, err := HashwxTarget(2)
		if err != nil {
			t.Fatalf("HashwxTarget(2) 失败: %v", err)
		}
		if want := (^uint64(0)) / 2; target != want {
			t.Errorf("d=2 时 target 期望 %d，实际 %d", want, target)
		}
	})

	t.Run("d 越大 target 越小", func(t *testing.T) {
		small, _ := HashwxTarget(1000)
		large, _ := HashwxTarget(100000)
		if !(small > large) {
			t.Errorf("难度提高后 target 应变小: %d vs %d", small, large)
		}
	})

	t.Run("d 越界时报错", func(t *testing.T) {
		for _, d := range []int{0, -1, HashwxMaxDifficulty + 1} {
			if _, err := HashwxTarget(d); err == nil {
				t.Errorf("难度 %d 应报错", d)
			}
		}
	})
}

// ---------- 挑战签发 ----------

func TestMintHashwxSpec(t *testing.T) {
	t.Run("默认参数与 Cap 一致（4 个子挑战、n=65536、总难度 1e6）", func(t *testing.T) {
		spec, err := MintHashwxSpec(HashwxMintOptions{})
		if err != nil {
			t.Fatalf("MintHashwxSpec 失败: %v", err)
		}
		if spec.Count != HashwxDefaultChallengeCount {
			t.Errorf("count 期望 %d，实际 %d", HashwxDefaultChallengeCount, spec.Count)
		}
		if spec.N != HashwxDefaultNoncesPerHash {
			t.Errorf("n 期望 %d，实际 %d", HashwxDefaultNoncesPerHash, spec.N)
		}
		if spec.D*spec.Count != HashwxDefaultDifficulty {
			t.Errorf("d*count 期望 %d，实际 %d", HashwxDefaultDifficulty, spec.D*spec.Count)
		}
		if ParseHashwxChallenge(spec.C) == nil {
			t.Errorf("c 必须是合法的 32 字节 hex")
		}
	})

	t.Run("总难度按子挑战数均分", func(t *testing.T) {
		for _, tc := range []struct {
			total int
			count int
			wantD int
		}{
			{1000, 4, 250},
			{1_000_000, 4, 250_000},
			// Math.round(1001/4) = 250（JS 的 round 是 .5 向上）
			{1001, 4, 250},
			{1002, 4, 251},
			{1, 8, 1},
		} {
			spec, err := MintHashwxSpec(HashwxMintOptions{Difficulty: tc.total, Count: tc.count})
			if err != nil {
				t.Fatalf("MintHashwxSpec 失败: %v", err)
			}
			if spec.D != tc.wantD {
				t.Errorf("total=%d count=%d 时 d 期望 %d，实际 %d", tc.total, tc.count, tc.wantD, spec.D)
			}
		}
	})

	t.Run("省略挑战时随机且为 32 字节", func(t *testing.T) {
		a, _ := MintHashwxSpec(HashwxMintOptions{})
		b, _ := MintHashwxSpec(HashwxMintOptions{})
		if a.C == b.C {
			t.Errorf("两次签发的挑战不应相同")
		}
		if len(a.C) != HashwxChallengeSize*2 {
			t.Errorf("挑战 hex 长度应为 %d，实际 %d", HashwxChallengeSize*2, len(a.C))
		}
	})

	t.Run("参数越界时报错", func(t *testing.T) {
		for _, options := range []HashwxMintOptions{
			{Difficulty: HashwxMaxDifficulty + 1},
			{NoncesPerHash: HashwxMaxNoncesPerHash + 1},
			{Count: HashwxMaxChallengeCount + 1},
		} {
			if _, err := MintHashwxSpec(options); err == nil {
				t.Errorf("越界参数应报错: %+v", options)
			}
		}
	})
}

func TestParseHashwxChallengeAndNonce(t *testing.T) {
	validHex := "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

	t.Run("挑战 hex 解析", func(t *testing.T) {
		if got := ParseHashwxChallenge(validHex); got == nil || hex.EncodeToString(got) != validHex {
			t.Errorf("合法 hex 应可解析")
		}
		if got := ParseHashwxChallenge(validHex + "ff"); got != nil {
			t.Errorf("长度不符的 hex 应被拒绝")
		}
		for _, bad := range []string{"", "zzzz", validHex[:len(validHex)-2]} {
			if got := ParseHashwxChallenge(bad); got != nil {
				t.Errorf("非法 hex %q 应被拒绝", bad)
			}
		}
	})

	t.Run("nonce 解析：数字与十进制字符串等价", func(t *testing.T) {
		for _, tc := range []struct {
			value any
			want  uint64
		}{
			{float64(123), 123},
			{"123", 123},
			{"0", 0},
			{float64(0), 0},
			{uint64(18446744073709551615), 18446744073709551615},
			{"18446744073709551615", 18446744073709551615},
		} {
			got, ok := ParseHashwxNonce(tc.value)
			if !ok || got != tc.want {
				t.Errorf("ParseHashwxNonce(%v) 期望 (%d,true)，实际 (%d,%v)", tc.value, tc.want, got, ok)
			}
		}
	})

	t.Run("nonce 解析：拒绝越界与畸形输入", func(t *testing.T) {
		for _, value := range []any{
			float64(-1), float64(1.5), "", "0x10",
			"123456789012345678901", // 21 位
			"99999999999999999999",  // 20 位但超过 u64
			nil, true, float64(1) * (1 << 60),
		} {
			if got, ok := ParseHashwxNonce(value); ok {
				t.Errorf("非法 nonce %v 应被拒绝，实际得到 %d", value, got)
			}
		}
	})
}

// ---------- 校验与解题往返 ----------

// hashwxSolve 逐个子挑战求解，难度保持很小以避免用例变慢
func hashwxSolve(t *testing.T, spec HashwxSpec) []any {
	t.Helper()
	challenge := ParseHashwxChallenge(spec.C)
	if challenge == nil {
		t.Fatalf("挑战解析失败")
	}
	target, err := HashwxTarget(spec.D)
	if err != nil {
		t.Fatalf("target 计算失败: %v", err)
	}
	n := uint64(spec.N)

	nonces := make([]any, 0, spec.Count)
	for i := 0; i < spec.Count; i++ {
		var nonce uint64
		for {
			seed, err := HashwxBlockSeed(challenge, i, nonce/n)
			if err != nil {
				t.Fatalf("种子派生失败: %v", err)
			}
			hash, err := HashwxHash(seed, nonce)
			if err != nil {
				t.Fatalf("HashwxHash 失败: %v", err)
			}
			if hash <= target {
				break
			}
			nonce++
			if nonce > 5_000_000 {
				t.Fatalf("子挑战 %d 求解超限", i)
			}
		}
		nonces = append(nonces, strconv.FormatUint(nonce, 10))
	}
	return nonces
}

func randomHashwxChallenge(t *testing.T) string {
	t.Helper()
	spec, err := MintHashwxSpec(HashwxMintOptions{Difficulty: 100})
	if err != nil {
		t.Fatalf("生成随机挑战失败: %v", err)
	}
	return spec.C
}

func TestVerifyHashwxSolutions(t *testing.T) {
	// 解释模式约 48 KH/s，d=400 × 4 子挑战 ≈ 1600 次哈希，约 40ms
	spec := HashwxSpec{C: randomHashwxChallenge(t), D: 400, N: HashwxDefaultNoncesPerHash, Count: 4}

	t.Run("正确解通过校验", func(t *testing.T) {
		nonces := hashwxSolve(t, spec)
		if len(nonces) != 4 {
			t.Fatalf("应得到 4 个解，实际 %d", len(nonces))
		}
		if got := VerifyHashwxSolutions(spec, nonces); !got.OK {
			t.Errorf("正确解应通过，reason=%q", got.Reason)
		}
	})

	t.Run("nonce 数量不匹配被拒", func(t *testing.T) {
		nonces := hashwxSolve(t, spec)
		for _, bad := range [][]any{nonces[:3], {}, nil} {
			if got := VerifyHashwxSolutions(spec, bad); got.OK || got.Reason != "solution count mismatch" {
				t.Errorf("数量不匹配应以 solution count mismatch 拒绝，实际 ok=%v reason=%q", got.OK, got.Reason)
			}
		}
	})

	t.Run("畸形挑战与畸形 spec 被拒", func(t *testing.T) {
		nonces := hashwxSolve(t, spec)
		for _, tc := range []struct {
			name string
			spec HashwxSpec
			want string
		}{
			{"挑战不是 hex", HashwxSpec{C: "not-hex", D: spec.D, N: spec.N, Count: spec.Count}, "malformed challenge"},
			{"d 为 0", HashwxSpec{C: spec.C, D: 0, N: spec.N, Count: spec.Count}, "malformed spec"},
			{"n 为 0", HashwxSpec{C: spec.C, D: spec.D, N: 0, Count: spec.Count}, "malformed spec"},
			{"count 为 0", HashwxSpec{C: spec.C, D: spec.D, N: spec.N, Count: 0}, "malformed spec"},
		} {
			if got := VerifyHashwxSolutions(tc.spec, nonces); got.OK || got.Reason != tc.want {
				t.Errorf("%s 应以 %s 拒绝，实际 ok=%v reason=%q", tc.name, tc.want, got.OK, got.Reason)
			}
		}
	})

	t.Run("畸形 nonce 被拒", func(t *testing.T) {
		// 坏值必须放在第 0 位：校验是逐个子挑战短路返回的
		for _, bad := range []any{"0x10", float64(-1), nil, "not-a-number"} {
			nonces := []any{bad, "2", "3", "4"}
			if got := VerifyHashwxSolutions(spec, nonces); got.OK || got.Reason != "bad nonce" {
				t.Errorf("非法 nonce %v 应以 bad nonce 拒绝，实际 ok=%v reason=%q", bad, got.OK, got.Reason)
			}
		}
	})

	t.Run("用错误的子挑战位置校验必然失败（index 参与派生）", func(t *testing.T) {
		nonces := hashwxSolve(t, spec)
		swapped := []any{nonces[1], nonces[0], nonces[2], nonces[3]}
		if got := VerifyHashwxSolutions(spec, swapped); got.OK || got.Reason != "insufficient work" {
			t.Errorf("错位解应以 insufficient work 拒绝，实际 ok=%v reason=%q", got.OK, got.Reason)
		}
	})

	t.Run("单子挑战（count=1）同样可用", func(t *testing.T) {
		single := HashwxSpec{C: randomHashwxChallenge(t), D: 300, N: 65536, Count: 1}
		if got := VerifyHashwxSolutions(single, hashwxSolve(t, single)); !got.OK {
			t.Errorf("单子挑战应可用，reason=%q", got.Reason)
		}
	})

	t.Run("n 取不同值时解题与校验口径自洽", func(t *testing.T) {
		for _, n := range []int{1, 1024, 65536} {
			s := HashwxSpec{C: randomHashwxChallenge(t), D: 200, N: n, Count: 2}
			if got := VerifyHashwxSolutions(s, hashwxSolve(t, s)); !got.OK {
				t.Errorf("n=%d 时口径不自洽，reason=%q", n, got.Reason)
			}
		}
	})

	t.Run("挑战被篡改则解失效", func(t *testing.T) {
		s := HashwxSpec{C: randomHashwxChallenge(t), D: 200, N: 65536, Count: 2}
		nonces := hashwxSolve(t, s)
		tampered := s
		tampered.C = randomHashwxChallenge(t)
		if got := VerifyHashwxSolutions(tampered, nonces); got.OK || got.Reason != "insufficient work" {
			t.Errorf("篡改挑战后应以 insufficient work 拒绝，实际 ok=%v reason=%q", got.OK, got.Reason)
		}
	})
}

// BenchmarkHashwxHash 测量单次「生成函数 + 求值」的开销。
//
// 服务端每次校验只对每个子挑战调用一次（默认 4 次），这个数字用来确认
// 「锁内做一次算力校验」的代价可以接受（见 verify.go 的临界区说明）。
func BenchmarkHashwxHash(b *testing.B) {
	seed := hashwxSeedOf("benchmark seed for hashwx")
	if _, err := HashwxHash(seed, 0); err != nil {
		b.Fatalf("HashwxHash 失败: %v", err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := HashwxHash(seed, uint64(i)); err != nil {
			b.Fatalf("HashwxHash 失败: %v", err)
		}
	}
}
