package utils

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

/*
HashWX 工作量证明（第一层验证）— Go 实现

算法来自 tevador/hashwx v1.0.0（LGPL-3.0，见 vendor/hashwx/README.md）。
口径与 Node.js（nodejs/src/utils/hashwx.ts）逐字节一致：

	target = U64_MAX / d
	seed(i, block) = SHA256(C(32字节) ‖ u8le(i) ‖ u64le(block))
	找到 nonce 使 hash(seed(i, nonce / n), nonce) <= target
	block = nonce / n（整数除法）

服务端只用「解释模式」（HASHWX_INTERPRETED）：每次校验只执行一次哈希，
省掉生成内层模块的开销。

关于并发：Node 是单线程，一个常驻上下文不会被交叉使用；Go 的 HTTP handler 是并发的，
而「写 seed 缓冲区 → hashwx_make → hashwx_exec」这组操作共享同一块线性内存，
必须先加锁才能保证两次校验不互相污染。这里用一个互斥锁把该序列串行化，
语义上等价于 Node 的单线程模型（单次校验约 100–150µs，锁竞争可忽略）。
*/

// WASM 资产位置说明：本文件用 //go:embed 嵌入二进制，而 go:embed 只能引用
// 包目录（含子目录）下的文件；同时 Go 会把**模块根**的 vendor/ 目录当作
// vendor 模式开关（缺少 vendor/modules.txt 时直接报 "inconsistent vendoring"），
// 因此资产放在包内子目录 vendor/hashwx/ 下。
//
//go:embed vendor/hashwx/hashwx.wasm
var hashwxWasm []byte

// ---------- 常量 ----------

const (
	// HashwxSeedSize 种子长度
	HashwxSeedSize = 32
	// HashwxChallengeSize 挑战长度
	HashwxChallengeSize = 32

	// HashwxDefaultNoncesPerHash 每个生成函数覆盖的 nonce 数
	HashwxDefaultNoncesPerHash = 65536

	// HashwxDefaultDifficulty 总期望哈希次数（按 count 均分到各子挑战）
	HashwxDefaultDifficulty = 1_000_000

	// HashwxDefaultChallengeCount 子挑战个数
	HashwxDefaultChallengeCount = 4

	// HashwxMaxDifficulty 难度上限
	HashwxMaxDifficulty = 1_000_000_000
	// HashwxMaxNoncesPerHash noncesPerHash 上限
	HashwxMaxNoncesPerHash = 1_048_576
	// HashwxMaxChallengeCount 子挑战个数上限
	HashwxMaxChallengeCount = 64

	// hashwxInterpreted 与 Node 一致：只用解释模式
	hashwxInterpreted = 0
)

// hashwxMaxNonce u64 最大值
const hashwxMaxNonce = math.MaxUint64

// ---------- WASM 装载 ----------

type hashwxInstance struct {
	runtime wazero.Runtime
	module  api.Module

	alloc api.Function
	seed  api.Function
	make_ api.Function
	exec  api.Function
	free  api.Function

	ctx     int32
	seedPtr uint32

	// mu 保护「写 seed → make → exec」这一整段共享线性内存的操作
	mu sync.Mutex
}

var (
	hashwxOnce sync.Once
	hashwxInst *hashwxInstance
	hashwxErr  error
)

// getHashwxInstance 惰性装载 WASM 并分配一个常驻上下文。
func getHashwxInstance() (*hashwxInstance, error) {
	hashwxOnce.Do(func() {
		hashwxInst, hashwxErr = newHashwxInstance()
	})
	return hashwxInst, hashwxErr
}

func newHashwxInstance() (*hashwxInstance, error) {
	ctx := context.Background()
	runtime := wazero.NewRuntime(ctx)

	module, err := runtime.InstantiateWithConfig(ctx, hashwxWasm, wazero.NewModuleConfig().WithName("hashwx"))
	if err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("实例化 hashwx 模块失败: %w", err)
	}

	// 与 Node 一致：若存在 _initialize（reactor 模块）必须先调用
	if init := module.ExportedFunction("_initialize"); init != nil {
		if _, err := init.Call(ctx); err != nil {
			_ = runtime.Close(ctx)
			return nil, fmt.Errorf("调用 hashwx _initialize 失败: %w", err)
		}
	}

	lookup := func(name string) (api.Function, error) {
		fn := module.ExportedFunction(name)
		if fn == nil {
			return nil, fmt.Errorf("hashwx 模块缺少导出符号 %s", name)
		}
		return fn, nil
	}

	inst := &hashwxInstance{runtime: runtime, module: module}
	for _, target := range []struct {
		name  string
		field *api.Function
	}{
		{"hashwx_alloc", &inst.alloc},
		{"hashwx_seed", &inst.seed},
		{"hashwx_make", &inst.make_},
		{"hashwx_exec", &inst.exec},
		{"hashwx_free", &inst.free},
	} {
		fn, err := lookup(target.name)
		if err != nil {
			_ = runtime.Close(ctx)
			return nil, err
		}
		*target.field = fn
	}

	allocated, err := inst.alloc.Call(ctx, hashwxInterpreted)
	if err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("调用 hashwx_alloc 失败: %w", err)
	}
	inst.ctx = int32(uint32(allocated[0]))
	if inst.ctx <= 0 {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("hashwx_alloc 失败: %d", inst.ctx)
	}

	seedPtr, err := inst.seed.Call(ctx, uint64(uint32(inst.ctx)))
	if err != nil {
		_ = runtime.Close(ctx)
		return nil, fmt.Errorf("调用 hashwx_seed 失败: %w", err)
	}
	inst.seedPtr = uint32(seedPtr[0])

	return inst, nil
}

// writeSeed 把 32 字节种子写入常驻 seed 缓冲区。调用方必须持有 inst.mu。
func (inst *hashwxInstance) writeSeed(seed []byte) error {
	if len(seed) != HashwxSeedSize {
		return fmt.Errorf("seed 必须为 %d 字节", HashwxSeedSize)
	}
	mem := inst.module.Memory()
	if mem == nil {
		return fmt.Errorf("hashwx 模块未导出内存")
	}
	if !mem.Write(inst.seedPtr, seed) {
		return fmt.Errorf("写入 hashwx seed 缓冲区越界")
	}
	return nil
}

// HashwxHash 用一个 32 字节种子生成函数并对单个 nonce 求值。
//
// 每次调用都会重新生成一次函数；不要把它放进「遍历 nonce」的循环里。
func HashwxHash(seed []byte, nonce uint64) (uint64, error) {
	inst, err := getHashwxInstance()
	if err != nil {
		return 0, err
	}
	if len(seed) != HashwxSeedSize {
		return 0, fmt.Errorf("seed 必须为 %d 字节", HashwxSeedSize)
	}

	ctx := context.Background()
	inst.mu.Lock()
	defer inst.mu.Unlock()

	if err := inst.writeSeed(seed); err != nil {
		return 0, err
	}
	if _, err := inst.make_.Call(ctx, uint64(uint32(inst.ctx)), uint64(inst.seedPtr)); err != nil {
		return 0, fmt.Errorf("调用 hashwx_make 失败: %w", err)
	}
	results, err := inst.exec.Call(ctx, uint64(uint32(inst.ctx)), nonce)
	if err != nil {
		return 0, fmt.Errorf("调用 hashwx_exec 失败: %w", err)
	}
	if len(results) == 0 {
		return 0, fmt.Errorf("hashwx_exec 未返回结果")
	}
	// i64 的原始位模式即 BigInt.asUintN(64, result)
	return results[0], nil
}

// ---------- 协议计算 ----------

// HashwxTarget 目标阈值：U64_MAX / d
func HashwxTarget(difficulty int) (uint64, error) {
	if difficulty < 1 || difficulty > HashwxMaxDifficulty {
		return 0, fmt.Errorf("难度必须是 [1, %d] 内的整数", HashwxMaxDifficulty)
	}
	return hashwxMaxNonce / uint64(difficulty), nil
}

// HashwxBlockSeed 第 index 个子挑战、第 block 个哈希函数的种子。
// 口径：SHA256(C ‖ u8le(index) ‖ u64le(block))
func HashwxBlockSeed(challenge []byte, index int, block uint64) ([]byte, error) {
	if len(challenge) != HashwxChallengeSize {
		return nil, fmt.Errorf("挑战必须为 %d 字节", HashwxChallengeSize)
	}
	buf := make([]byte, HashwxChallengeSize+1+8)
	copy(buf, challenge)
	buf[HashwxChallengeSize] = byte(index & 0xff)
	binary.LittleEndian.PutUint64(buf[HashwxChallengeSize+1:], block)
	sum := sha256.Sum256(buf)
	return sum[:], nil
}

// HashwxSpec HashWX 挑战参数
type HashwxSpec struct {
	// C 32 字节挑战，hex 编码下发
	C string `json:"c"`
	// D 每个子挑战的期望哈希次数
	D int `json:"d"`
	// N 每个生成函数覆盖的 nonce 数
	N int `json:"n"`
	// Count 子挑战个数
	Count int `json:"count"`
}

// HashwxMintOptions MintHashwxSpec 的可选参数
type HashwxMintOptions struct {
	Challenge     []byte
	Difficulty    int
	NoncesPerHash int
	Count         int
}

// MintHashwxSpec 构造挑战参数。Difficulty 为总期望哈希次数，按 Count 均分。
//
// 注意「约」：这里是 round(total / count)，且每个子挑战至少为 1，
// 因此实际总工作量可能与配置值有偏差。
func MintHashwxSpec(options HashwxMintOptions) (HashwxSpec, error) {
	total := options.Difficulty
	if total == 0 {
		total = HashwxDefaultDifficulty
	}
	n := options.NoncesPerHash
	if n == 0 {
		n = HashwxDefaultNoncesPerHash
	}
	count := options.Count
	if count == 0 {
		count = HashwxDefaultChallengeCount
	}

	challenge := options.Challenge
	if challenge == nil {
		random := make([]byte, HashwxChallengeSize)
		if _, err := rand.Read(random); err != nil {
			return HashwxSpec{}, err
		}
		challenge = random
	}

	if len(challenge) != HashwxChallengeSize {
		return HashwxSpec{}, fmt.Errorf("挑战必须为 %d 字节", HashwxChallengeSize)
	}
	if total < 1 || total > HashwxMaxDifficulty {
		return HashwxSpec{}, fmt.Errorf("difficulty 必须是 [1, %d] 内的整数", HashwxMaxDifficulty)
	}
	if n < 1 || n > HashwxMaxNoncesPerHash {
		return HashwxSpec{}, fmt.Errorf("noncesPerHash 必须是 [1, %d] 内的整数", HashwxMaxNoncesPerHash)
	}
	if count < 1 || count > HashwxMaxChallengeCount {
		return HashwxSpec{}, fmt.Errorf("count 必须是 [1, %d] 内的整数", HashwxMaxChallengeCount)
	}

	return HashwxSpec{
		C: hex.EncodeToString(challenge),
		// 与 Cap 一致：把总难度均分到各子挑战，至少为 1
		D:     max(1, jsRound(float64(total)/float64(count))),
		N:     n,
		Count: count,
	}, nil
}

// jsRound 复刻 JavaScript 的 Math.round（.5 向上取整，而非 Go 的「远离零」）
func jsRound(value float64) int {
	return int(math.Floor(value + 0.5))
}

// ParseHashwxChallenge 解析下发的 hex 挑战；非法返回 nil
func ParseHashwxChallenge(spec string) []byte {
	if len(spec) != HashwxChallengeSize*2 {
		return nil
	}
	decoded, err := hex.DecodeString(spec)
	if err != nil || len(decoded) != HashwxChallengeSize {
		return nil
	}
	return decoded
}

// ParseHashwxNonce 把提交上来的 nonce 解析为 u64；接受数字或十进制字符串
func ParseHashwxNonce(value any) (uint64, bool) {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v != math.Trunc(v) || v < 0 {
			return 0, false
		}
		// Number.isSafeInteger 语义：必须落在 ±2^53-1 内
		const maxSafeInteger = float64(9007199254740991) // 2^53 - 1
		if v > maxSafeInteger {
			return 0, false
		}
		return uint64(v), true
	case uint64:
		return v, true
	case string:
		// 20 位以内才可能落在 u64 范围内（u64 max 为 20 位）
		if len(v) == 0 || len(v) > 20 {
			return 0, false
		}
		for i := 0; i < len(v); i++ {
			if v[i] < '0' || v[i] > '9' {
				return 0, false
			}
		}
		parsed, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// HashwxCheck 校验结果
type HashwxCheck struct {
	OK     bool
	Reason string
}

// VerifyHashwxSolutions 校验 HashWX 答案：对每个子挑战重算一次哈希，全部命中才算通过。
//
// 注意 spec 必须来自**服务端签名过的载荷**，不能取自客户端提交，
// 否则攻击者可以自行降低难度。
func VerifyHashwxSolutions(spec HashwxSpec, nonces []any) HashwxCheck {
	challenge := ParseHashwxChallenge(spec.C)
	if challenge == nil {
		return HashwxCheck{Reason: "malformed challenge"}
	}

	if spec.N < 1 || spec.N > HashwxMaxNoncesPerHash ||
		spec.D < 1 || spec.D > HashwxMaxDifficulty ||
		spec.Count < 1 || spec.Count > HashwxMaxChallengeCount {
		return HashwxCheck{Reason: "malformed spec"}
	}

	if len(nonces) != spec.Count {
		return HashwxCheck{Reason: "solution count mismatch"}
	}

	target, err := HashwxTarget(spec.D)
	if err != nil {
		return HashwxCheck{Reason: "malformed spec"}
	}
	n := uint64(spec.N)

	for i := 0; i < spec.Count; i++ {
		nonce, ok := ParseHashwxNonce(nonces[i])
		if !ok {
			return HashwxCheck{Reason: "bad nonce"}
		}
		seed, err := HashwxBlockSeed(challenge, i, nonce/n)
		if err != nil {
			return HashwxCheck{Reason: "malformed challenge"}
		}
		hash, err := HashwxHash(seed, nonce)
		if err != nil {
			// WASM 装载/执行失败不应被当成「答案错误」，但也不放行
			return HashwxCheck{Reason: "hashwx unavailable"}
		}
		if hash > target {
			return HashwxCheck{Reason: "insufficient work"}
		}
	}

	return HashwxCheck{OK: true}
}

// hashwxParseNoncesJSON 把 JSON 里的 nonces 字段解析成 []any。
// 与 JS 的 `Array.isArray(nonces)` 语义一致：不是数组则返回 nil。
func hashwxParseNoncesJSON(raw []byte) ([]any, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, false
	}
	if trimmed[0] != '[' {
		return nil, false
	}
	// 与 JSON.parse 一致：数字统一落成 float64（不做 UseNumber）
	var values []any
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	if values == nil {
		values = []any{}
	}
	return values, true
}
