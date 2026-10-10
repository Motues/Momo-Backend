package utils

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

/*
Instrumentation 质询（第二层验证）— Go 实现

与 Node.js（nodejs/src/utils/instrumentation.ts）逐条对照移植，语义必须逐位一致：

 1. **无状态**：程序与期望值都由（密钥, 挑战 id）确定性派生，服务端不保存任何挑战内容。
 2. **可推算的确定性部分**：程序只由整数运算与 DOM 元素树操作组成，且所有 DOM 读取读的都是
    程序自己写进去的值，因此服务端不需要真实 DOM 就能算出期望结果。
 3. **真正的牙齿在探针与环境规则**：布局探针 + 自动化特征规则。

程序生成必须与 Node 逐字节相同（同一个 seed 生成同一个 ops 数组），
doc/vectors/instrumentation-v2.json 是双方共用的固定向量。
*/

// ---------- 常量 ----------

const (
	// InstrRegCount 寄存器个数
	InstrRegCount = 4
	// InstrOpStride 每个操作的整数个数：opcode + 两个参数（不足补 0）
	InstrOpStride = 3
	// InstrMaxOps 操作数上限，避免被塞入超长程序拖慢校验
	InstrMaxOps = 240
	// instrMinOps 指令总数下限（含尾部收尾指令）
	instrMinOps = 40
	// maxInstrDomDepth DOM 树深上限：既避免无界增长，也让尾部收尾指令的数量可预算
	maxInstrDomDepth = 12
)

// 操作码
const (
	OpConst = iota
	OpMov
	OpAnd
	OpOr
	OpXor
	OpNand
	OpAdd
	OpSub
	OpMul
	OpRotl
	OpRotr
	OpShl
	OpShr
	OpNot
	OpDomCreate
	OpDomAppend
	OpDomSetText
	OpDomSetAttr
	OpDomReadText
	OpDomReadAttr
	OpDomWalkUp
	OpDomRemove
	OpProtoJoin
	OpProtoCharcode
)

// InstrMaxOpcode 最大的合法操作码
const InstrMaxOpcode = OpProtoCharcode

// InstrTags 元素标签候选（真实存在的标签，样式无关紧要）
var InstrTags = []string{"div", "span", "p", "section", "b", "i", "em", "u"}

// InstrAttr 程序写入/读取的属性名，客户端与服务端必须一致
const InstrAttr = "data-v"

// InstrFontStacks 布局探针使用的字体栈。
//
// 必须与前端 instrumentation.ts 的列表逐项一致：字宽是量化检测的输入，
// 列表不同会让该检测失去意义。
var InstrFontStacks = []string{
	"monospace",
	"sans-serif",
	"serif",
	"cursive",
	"fantasy",
	"system-ui",
	`"Arial"`,
	`"Helvetica"`,
	`"Times New Roman"`,
	`"Courier New"`,
	`"Georgia"`,
	`"Verdana"`,
	`"Tahoma"`,
	`"Trebuchet MS"`,
	`"Segoe UI"`,
	`"PingFang SC"`,
	`"Microsoft YaHei"`,
}

// InstrProbeText 布局探针探测串
const InstrProbeText = "MomoVerify1234"

// ---------- 种子扩展 ----------

/*
WordStream 用 SHA-256 计数器模式从种子扩展出任意多个 32 位字。

刻意不用有状态的 PRNG：计数器模式没有状态，跨语言复刻时只需要
「同一份 SHA-256 + 同一份大端计数器编码」，没有隐藏的初始化或溢出语义。
*/
type wordStream struct {
	seed    []byte
	buffer  []byte
	counter uint32
	words   [8]uint32
	index   int
}

func newWordStream(seed []byte) *wordStream {
	stream := &wordStream{seed: seed, buffer: make([]byte, len(seed)+4)}
	copy(stream.buffer, seed)
	stream.index = len(stream.words)
	return stream
}

func (s *wordStream) next() uint32 {
	if s.index >= len(s.words) {
		binary.BigEndian.PutUint32(s.buffer[len(s.seed):], s.counter)
		s.counter++
		digest := sha256.Sum256(s.buffer)
		for i := 0; i < 8; i++ {
			s.words[i] = binary.BigEndian.Uint32(digest[i*4:])
		}
		s.index = 0
	}
	value := s.words[s.index]
	s.index++
	return value
}

// below 返回 [0, max) 区间内的整数
func (s *wordStream) below(max int) int {
	return int(s.next() % uint32(max))
}

// InstrProgramSeed 程序派生种子
func InstrProgramSeed(challengeID, secret string) []byte {
	sum := sha256.Sum256([]byte("instr:prog:" + secret + ":" + challengeID))
	return sum[:]
}

// ---------- 程序生成 ----------

// InstrumentationProgram 扁平的操作码数组，每 3 个整数一个操作
type InstrumentationProgram struct {
	Ops []int32
}

// GenerateProgram 生成随机程序（确定性：同一 seed 必然生成同一程序）
func GenerateProgram(seed []byte) InstrumentationProgram {
	rng := newWordStream(seed)
	// 预算必须按「操作数」而不是「循环次数」计算：一次 DOM 建树会推入
	// CREATE + APPEND + SET_ATTR 共 3 个操作。尾部另需 PROTO_JOIN + PROTO_CHARCODE
	// 以及最多 maxInstrDomDepth 次收尾移除。
	bodyBudget := InstrMaxOps - 2 - maxInstrDomDepth
	bodyTarget := instrMinOps + rng.below(maxInt(1, bodyBudget-instrMinOps+1))

	ops := make([]int32, 0, (InstrMaxOps+maxInstrDomDepth)*InstrOpStride)
	depth := 0

	opCount := func() int { return len(ops) / InstrOpStride }
	push := func(op int, a, b int32) {
		ops = append(ops, int32(op), a, b)
	}
	randomReg := func() int32 { return int32(rng.below(InstrRegCount)) }

	for opCount() < bodyTarget {
		pick := rng.below(100)

		if pick < 78 {
			// 整数运算区
			bucket := pick % 14
			dst := randomReg()
			src := randomReg()
			switch bucket {
			case 0:
				push(OpConst, dst, int32(rng.next()))
			case 1:
				push(OpMov, dst, src)
			case 2:
				push(OpAnd, dst, src)
			case 3:
				push(OpOr, dst, src)
			case 4:
				push(OpXor, dst, src)
			case 5:
				push(OpNand, dst, src)
			case 6:
				push(OpAdd, dst, src)
			case 7:
				push(OpSub, dst, src)
			case 8:
				push(OpMul, dst, src)
			case 9:
				push(OpRotl, dst, int32(1+rng.below(31)))
			case 10:
				push(OpRotr, dst, int32(1+rng.below(31)))
			case 11:
				push(OpShl, dst, int32(1+rng.below(31)))
			case 12:
				push(OpShr, dst, int32(1+rng.below(31)))
			default:
				push(OpNot, dst, 0)
			}
			continue
		}

		// DOM 区
		domPick := rng.below(10)
		wantCreate := depth == 0 || (depth < maxInstrDomDepth && domPick < 3)

		if wantCreate {
			// 建一层要 3 个操作；预算不够时用一个整数操作顶替，避免整体超限
			if opCount()+3 > bodyBudget {
				push(OpNot, randomReg(), 0)
				continue
			}
			push(OpDomCreate, int32(rng.below(len(InstrTags))), 0)
			depth++
			push(OpDomAppend, 0, 0)
			push(OpDomSetAttr, randomReg(), int32(rng.next()))
			continue
		}

		// 到达树深上限时强制回退，防止无界加深
		if depth >= maxInstrDomDepth && domPick < 3 {
			push(OpDomRemove, 0, 0)
			depth--
			continue
		}

		switch domPick {
		case 3, 4:
			push(OpDomSetText, randomReg(), 0)
		case 5, 6:
			push(OpDomReadAttr, randomReg(), 0)
		case 7:
			push(OpDomReadText, randomReg(), 0)
		case 8:
			if depth > 1 {
				push(OpDomWalkUp, randomReg(), int32(1+rng.below(depth)))
			} else {
				push(OpDomSetAttr, randomReg(), int32(rng.next()))
			}
		default:
			push(OpDomRemove, 0, 0)
			depth--
		}
	}

	// 收尾：走一次原型链，并把整棵树拆掉
	// （客户端必须真的清理，否则宿主页面上会留下残留节点）
	push(OpProtoJoin, randomReg(), 0)
	push(OpProtoCharcode, randomReg(), 0)
	for i := 0; i < depth; i++ {
		push(OpDomRemove, 0, 0)
	}

	return InstrumentationProgram{Ops: ops}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ---------- 影子 DOM 模型 + 解释器 ----------

type shadowNode struct {
	text   int32
	attrV  int32
	parent *shadowNode
}

// regAOpcodes 操作码 → 参数 A 是否为寄存器下标。
//
// 集中声明而不是散落在 case 里，避免漏校验：任何越界的寄存器下标都会污染后续运算。
var regAOpcodes = map[int]bool{
	OpConst: true, OpMov: true, OpAnd: true, OpOr: true, OpXor: true, OpNand: true,
	OpAdd: true, OpSub: true, OpMul: true, OpRotl: true, OpRotr: true, OpShl: true,
	OpShr: true, OpNot: true, OpDomSetText: true, OpDomSetAttr: true,
	OpDomReadText: true, OpDomReadAttr: true, OpDomWalkUp: true,
	OpProtoJoin: true, OpProtoCharcode: true,
}

// regBOpcodes 操作码 → 参数 B 是否为寄存器下标
var regBOpcodes = map[int]bool{
	OpMov: true, OpAnd: true, OpOr: true, OpXor: true, OpNand: true,
	OpAdd: true, OpSub: true, OpMul: true,
}

func isInstrReg(value int32) bool {
	return value >= 0 && value < InstrRegCount
}

// InterpretProgram 服务端解释程序并推算期望结果。
//
// 影子模型只保留程序自己写入的值（text / data-v），因此不需要真实 DOM；
// 客户端必须用真实 DOM 走到同样的值。
func InterpretProgram(program InstrumentationProgram) ([InstrRegCount]int32, bool) {
	var regs [InstrRegCount]int32
	ops := program.Ops

	// 空程序视为非法：挑战必须真的包含程序，否则「全 0 寄存器」会变成一条廉价捷径
	if len(ops) == 0 || len(ops)%InstrOpStride != 0 {
		return regs, false
	}
	if len(ops) > (InstrMaxOps+8)*InstrOpStride {
		return regs, false
	}

	var top *shadowNode

	for i := 0; i < len(ops); i += InstrOpStride {
		op := int(ops[i])
		a := ops[i+1]
		b := ops[i+2]
		if op < 0 || op > InstrMaxOpcode {
			return regs, false
		}
		if regAOpcodes[op] && !isInstrReg(a) {
			return regs, false
		}
		if regBOpcodes[op] && !isInstrReg(b) {
			return regs, false
		}

		switch op {
		case OpConst:
			regs[a] = b
		case OpMov:
			regs[a] = regs[b]
		case OpAnd:
			regs[a] = regs[a] & regs[b]
		case OpOr:
			regs[a] = regs[a] | regs[b]
		case OpXor:
			regs[a] = regs[a] ^ regs[b]
		case OpNand:
			regs[a] = ^(regs[a] & regs[b])
		case OpAdd:
			regs[a] = regs[a] + regs[b]
		case OpSub:
			regs[a] = regs[a] - regs[b]
		case OpMul:
			// 32 位截断乘法（等价于 JS 的 Math.imul）
			regs[a] = regs[a] * regs[b]
		case OpRotl:
			regs[a] = int32(bitsRotateLeft32(uint32(regs[a]), uint32(b)&31))
		case OpRotr:
			regs[a] = int32(bitsRotateLeft32(uint32(regs[a]), (32-uint32(b)&31)&31))
		case OpShl:
			regs[a] = int32(uint32(regs[a]) << (uint32(b) & 31))
		case OpShr:
			regs[a] = regs[a] >> (uint32(b) & 31)
		case OpNot:
			regs[a] = ^regs[a]

		case OpDomCreate:
			if a < 0 || int(a) >= len(InstrTags) {
				return regs, false
			}
			top = &shadowNode{parent: top}
		case OpDomAppend:
			// 真实 DOM 里需要把节点挂到父节点下；影子模型只需要维护 parent 关系
		case OpDomSetText:
			if top == nil {
				return regs, false
			}
			top.text = regs[a]
		case OpDomSetAttr:
			if top == nil {
				return regs, false
			}
			top.attrV = regs[a]
		case OpDomReadText:
			if top == nil {
				return regs, false
			}
			regs[a] = top.text
		case OpDomReadAttr:
			if top == nil {
				return regs, false
			}
			regs[a] = top.attrV
		case OpDomWalkUp:
			if top == nil {
				return regs, false
			}
			node := top
			var acc int32
			for k := int32(0); k <= b && node != nil; k++ {
				acc += node.attrV
				node = node.parent
			}
			regs[a] += acc
		case OpDomRemove:
			if top == nil {
				return regs, false
			}
			top = top.parent

		case OpProtoJoin:
			// 等价于 Array.prototype.join.call([r0,r1,r2,r3], "-").length
			joined := strconv.FormatInt(int64(regs[0]), 10) + "-" +
				strconv.FormatInt(int64(regs[1]), 10) + "-" +
				strconv.FormatInt(int64(regs[2]), 10) + "-" +
				strconv.FormatInt(int64(regs[3]), 10)
			regs[a] = int32(len(joined))
		case OpProtoCharcode:
			text := strconv.FormatInt(int64(regs[a]), 10)
			if len(text) > 0 {
				regs[a] = int32(text[0])
			} else {
				regs[a] = -1
			}
		default:
			// 已由 op > InstrMaxOpcode 拦下，这里只是穷尽分支
			return regs, false
		}
	}

	return regs, true
}

// bitsRotateLeft32 复刻 JS 的移位/旋转组合（x << n | x >>> (32-n)），按 32 位语义
func bitsRotateLeft32(value uint32, shift uint32) uint32 {
	shift &= 31
	return value<<shift | value>>((32-shift)&31)
}

// ---------- 环境向量与自动化检测 ----------

// EnvVector 客户端采集、服务端判定的环境向量。字段名刻意取短名，减少传输体积；
// 缺失用 -1 / 空数组表示。
type EnvVector struct {
	// Cd navigator.webdriver：-1 表示 undefined，0 表示 false，1 表示 true
	Cd float64
	// Ua userAgent（截断）
	Ua string
	// Br userAgentData.brands 拼接（截断），不可用时为空串
	Br string
	// Ge 引擎标记：1=Blink，2=Gecko，3=WebKit，0=未知
	Ge float64
	// Dm navigator.deviceMemory，不支持为 -1
	Dm float64
	// Tm 字体度量：若干字体栈下同一探测串的宽度
	Tm []float64
	// Lw/Lh 布局探针结果
	Lw float64
	Lh float64
	// Iw/Ih/Ow/Oh 视口与窗口
	Iw float64
	Ih float64
	Ow float64
	Oh float64
	// Sw/Sh/Ex 屏幕
	Sw float64
	Sh float64
	Ex float64
	// Mob 是否移动端
	Mob float64
	// Nt 原生方法被改写位掩码（canvas / webgl / permissions）
	Nt float64
}

// EnvVerdict 判定结果
type EnvVerdict struct {
	// BlockedBy 命中即判定为自动化浏览器（是否拒绝由调用方按设置决定）
	BlockedBy []string
	// RiskFlags 只记录、不拒绝的风险标记
	RiskFlags []string
}

// windowScreenTolerance 屏幕与窗口尺寸的容差（像素）：考虑小数缩放与浏览器 UI 抖动
const windowScreenTolerance = 4

func isFiniteNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok {
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

// envNumber 取数值字段，缺失或类型不对时退化为 fallback
func envNumber(raw map[string]any, key string, fallback float64) float64 {
	if raw == nil {
		return fallback
	}
	if number, ok := isFiniteNumber(raw[key]); ok {
		return number
	}
	return fallback
}

// envString 取字符串字段，缺失或类型不对时退化为空串
func envString(raw map[string]any, key string) string {
	if raw == nil {
		return ""
	}
	if value, ok := raw[key].(string); ok {
		return value
	}
	return ""
}

// truncateUTF16 按 UTF-16 码元截断，与 JS 的 String.prototype.slice 语义一致
func truncateUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

// NormalizeEnvVector 把外部传入的环境向量收敛成一个可判定的对象。
// 任何字段缺失或类型不对都退化为「未知」，由对应规则自行决定如何处理，
// 绝不让畸形输入把某条检查静默跳过而变成放行。
func NormalizeEnvVector(raw map[string]any) EnvVector {
	metrics := make([]float64, 0, 8)
	if raw != nil {
		if list, ok := raw["tm"].([]any); ok {
			for _, item := range list {
				if number, ok := isFiniteNumber(item); ok {
					metrics = append(metrics, number)
				}
				if len(metrics) >= 64 {
					break
				}
			}
		}
	}

	return EnvVector{
		Cd:  envNumber(raw, "cd", -1),
		Ua:  truncateUTF16(envString(raw, "ua"), 300),
		Br:  truncateUTF16(envString(raw, "br"), 300),
		Ge:  envNumber(raw, "ge", 0),
		Dm:  envNumber(raw, "dm", -1),
		Tm:  metrics,
		Lw:  envNumber(raw, "lw", 0),
		Lh:  envNumber(raw, "lh", 0),
		Iw:  envNumber(raw, "iw", 0),
		Ih:  envNumber(raw, "ih", 0),
		Ow:  envNumber(raw, "ow", 0),
		Oh:  envNumber(raw, "oh", 0),
		Sw:  envNumber(raw, "sw", 0),
		Sh:  envNumber(raw, "sh", 0),
		Ex:  envNumber(raw, "ex", 0),
		Mob: envNumber(raw, "mob", 0),
		Nt:  envNumber(raw, "nt", 0),
	}
}

var headlessTokenRe = regexp.MustCompile(`(?i)headlesschrome`)

/*
EvaluateEnvVector 判定环境向量。

拦截类规则全部指向「自动化层或篡改」，不针对浏览器构建本身：
不使用 Widevine、H.264、userAgentData 品牌等构建身份信号，
因为在同一份二进制上，真实的 ungoogled-chromium 用户与隐身驱动看起来一模一样。
*/
func EvaluateEnvVector(raw map[string]any) EnvVerdict {
	env := NormalizeEnvVector(raw)
	blockedBy := make([]string, 0, 4)
	riskFlags := make([]string, 0, 3)

	isBlink := env.Ge == 1
	isGecko := env.Ge == 2
	isMobile := env.Mob == 1

	// 1. 规范定义的自动化标志。没有任何市售浏览器会把它设为 true。
	if env.Cd == 1 {
		blockedBy = append(blockedBy, "webdriver_true")
	}

	// 2. 隐身脚本常在 Chromium 上直接删掉 navigator.webdriver。
	//    真实 Chrome 永远暴露 false，因此「Blink + undefined」是篡改信号。
	if isBlink && env.Cd == -1 {
		blockedBy = append(blockedBy, "webdriver_stripped")
	}

	// 3. UA 或 brands 里出现 HeadlessChrome：消费级浏览器不会有这个 token。
	if headlessTokenRe.MatchString(env.Ua) || headlessTokenRe.MatchString(env.Br) {
		blockedBy = append(blockedBy, "headless_token")
	}

	// 4. 布局探针必须给出正的几何尺寸：jsdom / happy-dom 之类返回 0。
	if !(env.Lw > 0) || !(env.Lh > 0) {
		blockedBy = append(blockedBy, "layout_zero")
	}

	// 5. Gecko 从未实现过 deviceMemory 或 userAgentData，两者同时出现即伪装。
	if isGecko && (env.Dm >= 0 || len(env.Br) > 0) {
		blockedBy = append(blockedBy, "gecko_contradiction")
	}

	// 6. CDP 的 Emulation.setDeviceMetricsOverride 会把 screen 缩到视口大小，
	//    导致窗口高于屏幕。第二显示器（screen.isExtended）时跳过。
	if env.Ex != 1 && (env.Ow > env.Sw+windowScreenTolerance || env.Oh > env.Sh+windowScreenTolerance) {
		blockedBy = append(blockedBy, "window_exceeds_screen")
	}

	// 7. 字体度量整数量化：Camoufox 之类会把字宽吸附到整像素。
	//    要求「至少 5 条为整数」且「至少 2 个不同的整数值」，
	//    这样只有单一字体的系统不会被误伤。
	integerMetrics := 0
	distinct := make(map[float64]struct{}, 8)
	for _, value := range env.Tm {
		if value == math.Trunc(value) {
			integerMetrics++
			distinct[value] = struct{}{}
		}
	}
	if integerMetrics >= 5 && len(distinct) >= 2 {
		blockedBy = append(blockedBy, "geometry_quantized")
	}

	// 8. 视口与屏幕完全相等且浏览器 UI 存在：移动端全屏是正常的，因此跳过移动端。
	if !isMobile && env.Iw == env.Sw && env.Ih == env.Sh && env.Iw > 0 && env.Ih > 0 {
		blockedBy = append(blockedBy, "viewport_override")
	}

	// 风险标记（永不拒绝）
	if env.Nt != 0 {
		riskFlags = append(riskFlags, "native_tamper")
	}
	if len(env.Tm) < 5 {
		riskFlags = append(riskFlags, "few_font_metrics")
	}
	if env.Ua == "" {
		riskFlags = append(riskFlags, "ua_missing")
	}

	return EnvVerdict{BlockedBy: blockedBy, RiskFlags: riskFlags}
}

// ---------- 质询与校验 ----------

// InstrumentationChallenge 下发给客户端的质询
type InstrumentationChallenge struct {
	// Ops 扁平操作码数组
	Ops []int32 `json:"ops"`
	// Fonts 布局探针要求的字体数量（客户端据此采集 tm）
	Fonts int `json:"fonts"`
}

// CreateInstrumentationChallenge 派生质询（签发与校验共用）
func CreateInstrumentationChallenge(challengeID, secret string) InstrumentationChallenge {
	program := GenerateProgram(InstrProgramSeed(challengeID, secret))
	return InstrumentationChallenge{Ops: program.Ops, Fonts: len(InstrFontStacks)}
}

// InstrumentationResult 校验结果
type InstrumentationResult struct {
	OK        bool
	Reason    string
	BlockedBy []string
	RiskFlags []string
}

// VerifyInstrumentation 校验 Instrumentation 答案。
//
// blockAutomated 为 true 时，命中自动化规则即拒绝；为 false 时只记录风险。
//
// answer 为客户端提交的 instr 对象（未经收敛的原始 JSON 解码结果）。
func VerifyInstrumentation(challengeID, secret string, answer map[string]any, blockAutomated bool) InstrumentationResult {
	challenge := CreateInstrumentationChallenge(challengeID, secret)

	// 1. 寄存器必须与「重新派生 + 独立推算」的结果逐位一致
	expected, ok := InterpretProgram(InstrumentationProgram{Ops: challenge.Ops})
	if !ok {
		return InstrumentationResult{Reason: "program derivation failed", BlockedBy: []string{}, RiskFlags: []string{}}
	}

	var regs []any
	if answer != nil {
		regs, _ = answer["regs"].([]any)
	}
	if len(regs) != InstrRegCount {
		return InstrumentationResult{Reason: "malformed registers", BlockedBy: []string{}, RiskFlags: []string{}}
	}
	for i := 0; i < InstrRegCount; i++ {
		value, ok := isFiniteNumber(regs[i])
		if !ok || value != math.Trunc(value) {
			return InstrumentationResult{Reason: "malformed registers", BlockedBy: []string{}, RiskFlags: []string{}}
		}
		if jsToInt32(value) != expected[i] {
			return InstrumentationResult{Reason: "program result mismatch", BlockedBy: []string{}, RiskFlags: []string{}}
		}
	}

	// 2. 布局探针：客户端单独回传，服务端只做范围判定（不做精确比对，避免字体/DPR 差异误伤）
	var lw, lh float64
	if answer != nil {
		if value, ok := isFiniteNumber(answer["lw"]); ok {
			lw = value
		}
		if value, ok := isFiniteNumber(answer["lh"]); ok {
			lh = value
		}
	}

	// 3. 环境向量判定
	var envRaw map[string]any
	if answer != nil {
		envRaw, _ = answer["env"].(map[string]any)
	}
	verdict := EvaluateEnvVector(envRaw)

	// 把布局探针并入判定结果：与规则 4 共用同一套语义
	blockedBy := make([]string, 0, len(verdict.BlockedBy)+1)
	blockedBy = append(blockedBy, verdict.BlockedBy...)
	if !(lw > 0) || !(lh > 0) {
		if !containsString(blockedBy, "layout_zero") {
			blockedBy = append(blockedBy, "layout_zero")
		}
	}

	if blockAutomated && len(blockedBy) > 0 {
		return InstrumentationResult{
			Reason:    "automated browser detected: " + strings.Join(blockedBy, ","),
			BlockedBy: blockedBy,
			RiskFlags: verdict.RiskFlags,
		}
	}

	return InstrumentationResult{OK: true, BlockedBy: blockedBy, RiskFlags: verdict.RiskFlags}
}

// jsToInt32 复刻 JavaScript 的 ToInt32（|0）
func jsToInt32(value float64) int32 {
	if value == 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	modulo := math.Mod(math.Trunc(value), 4294967296)
	if modulo < 0 {
		modulo += 4294967296
	}
	if modulo >= 2147483648 {
		return int32(int64(modulo) - 4294967296)
	}
	return int32(int64(modulo))
}

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}
