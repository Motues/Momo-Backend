package utils

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"sync"
	"testing"
)

/*
Instrumentation 质询的固定向量验收测试

doc/vectors/instrumentation-v2.json 是服务端影子模型与前端真实 DOM 解释器共用的固定向量：
程序由 seed 确定性派生，regs 是影子模型推算的期望值。这里的断言把两件事钉死：

 1. 程序生成器必须与 Node 逐字节相同（同一个 seed → 同一个 ops 数组）；
 2. 影子模型解释器必须复现 fixture 里的 regs（覆盖全部 24 个操作码）。
*/

// instrumentationVectorFixture doc/vectors/instrumentation-v2.json 的结构化视图
type instrumentationVectorFixture struct {
	Secret  string `json:"secret"`
	Vectors []struct {
		Cid  string  `json:"cid"`
		Seed string  `json:"seed"`
		Ops  []int32 `json:"ops"`
		Regs []int32 `json:"regs"`
	} `json:"vectors"`
}

var (
	instrFixtureOnce sync.Once
	instrFixture     instrumentationVectorFixture
	instrFixtureErr  error
)

// loadInstrumentationFixture 读取（并缓存）doc/vectors/instrumentation-v2.json
func loadInstrumentationFixture(t *testing.T) instrumentationVectorFixture {
	t.Helper()
	instrFixtureOnce.Do(func() {
		raw, err := os.ReadFile(vectorsPath("instrumentation-v2.json"))
		if err != nil {
			instrFixtureErr = err
			return
		}
		instrFixtureErr = json.Unmarshal(raw, &instrFixture)
	})
	if instrFixtureErr != nil {
		t.Fatalf("读取 doc/vectors/instrumentation-v2.json 失败: %v", instrFixtureErr)
	}
	return instrFixture
}

// TestInstrumentationProgramGeneration 程序生成必须与 Node 逐字节相同
func TestInstrumentationProgramGeneration(t *testing.T) {
	fixture := loadInstrumentationFixture(t)

	if len(fixture.Vectors) == 0 {
		t.Fatalf("fixture 里没有任何向量")
	}

	for _, vector := range fixture.Vectors {
		t.Run(vector.Cid, func(t *testing.T) {
			// 种子必须由派生标签生成
			wantSeed := sha256HexLocal("instr:prog:" + fixture.Secret + ":" + vector.Cid)
			if wantSeed != vector.Seed {
				t.Errorf("种子派生漂移:\n got=%s\nwant=%s", wantSeed, vector.Seed)
			}
			if got := hex.EncodeToString(InstrProgramSeed(vector.Cid, fixture.Secret)); got != vector.Seed {
				t.Errorf("InstrProgramSeed 实现漂移:\n got=%s\nwant=%s", got, vector.Seed)
			}

			// 用 fixture 的 seed 生成程序
			seed, err := hex.DecodeString(vector.Seed)
			if err != nil {
				t.Fatalf("fixture 种子不是合法 hex: %v", err)
			}
			program := GenerateProgram(seed)
			if !int32SliceEqual(program.Ops, vector.Ops) {
				t.Errorf("程序生成漂移（seed=%s）：\n got=%v\nwant=%v", vector.Seed, program.Ops, vector.Ops)
			}

			// 用生产路径（cid + secret）再生成一次，必须得到同一个程序
			challenge := CreateInstrumentationChallenge(vector.Cid, fixture.Secret)
			if !int32SliceEqual(challenge.Ops, vector.Ops) {
				t.Errorf("CreateInstrumentationChallenge 与 fixture 不一致")
			}
			if challenge.Fonts != len(InstrFontStacks) || challenge.Fonts != 17 {
				t.Errorf("fonts 应为字体栈数量（17），实际 %d", challenge.Fonts)
			}
		})
	}
}

// TestInstrumentationShadowInterpreter 影子模型解释器必须复现 fixture 的 regs
func TestInstrumentationShadowInterpreter(t *testing.T) {
	fixture := loadInstrumentationFixture(t)

	for _, vector := range fixture.Vectors {
		t.Run(vector.Cid, func(t *testing.T) {
			regs, ok := InterpretProgram(InstrumentationProgram{Ops: vector.Ops})
			if !ok {
				t.Fatalf("fixture 程序应可被解释")
			}
			if len(vector.Regs) != InstrRegCount {
				t.Fatalf("fixture 的 regs 长度应为 %d，实际 %d", InstrRegCount, len(vector.Regs))
			}
			for i := 0; i < InstrRegCount; i++ {
				if regs[i] != vector.Regs[i] {
					t.Errorf("寄存器 %d 期望 %d，实际 %d（完整 got=%v want=%v）", i, vector.Regs[i], regs[i], regs, vector.Regs)
				}
			}
		})
	}

	t.Run("空程序/非法长度被拒", func(t *testing.T) {
		for _, ops := range [][]int32{{}, {0, 0}, {0, 0, 0, 1}} {
			if _, ok := InterpretProgram(InstrumentationProgram{Ops: ops}); ok {
				t.Errorf("非法程序 %v 不应被接受", ops)
			}
		}
	})

	t.Run("越界寄存器下标被拒", func(t *testing.T) {
		for _, ops := range [][]int32{
			{OpConst, 4, 0}, // a 越界
			{OpMov, 0, 4},   // b 越界
			{OpMov, -1, 0},  // a 负数
			{InstrMaxOpcode + 1, 0, 0},
		} {
			if _, ok := InterpretProgram(InstrumentationProgram{Ops: ops}); ok {
				t.Errorf("非法程序 %v 不应被接受", ops)
			}
		}
	})

	t.Run("DOM 操作在空栈上被拒", func(t *testing.T) {
		for _, ops := range [][]int32{
			{OpDomSetText, 0, 0},
			{OpDomReadAttr, 0, 0},
			{OpDomRemove, 0, 0},
			{OpDomWalkUp, 0, 1},
		} {
			if _, ok := InterpretProgram(InstrumentationProgram{Ops: ops}); ok {
				t.Errorf("空栈上的 DOM 操作 %v 不应被接受", ops)
			}
		}
	})

	t.Run("DOM_CREATE 标签下标越界被拒", func(t *testing.T) {
		ops := []int32{OpDomCreate, int32(len(InstrTags)), 0}
		if _, ok := InterpretProgram(InstrumentationProgram{Ops: ops}); ok {
			t.Errorf("越界标签下标不应被接受")
		}
	})
}

// ---------- 单个操作码的语义 ----------

// runOps 便捷执行一小段程序，要求其合法
func runOps(t *testing.T, ops []int32) [InstrRegCount]int32 {
	t.Helper()
	regs, ok := InterpretProgram(InstrumentationProgram{Ops: ops})
	if !ok {
		t.Fatalf("程序应合法: %v", ops)
	}
	return regs
}

func TestInstrumentationOpcodeSemantics(t *testing.T) {
	for _, tc := range []struct {
		name string
		ops  []int32
		reg  int
		want int32
	}{
		{"CONST 写入立即数", []int32{OpConst, 0, 12345}, 0, 12345},
		{"MOV 复制寄存器", []int32{OpConst, 1, 7, OpMov, 0, 1}, 0, 7},
		{"AND", []int32{OpConst, 0, 0b1100, OpConst, 1, 0b1010, OpAnd, 0, 1}, 0, 0b1000},
		{"OR", []int32{OpConst, 0, 0b1100, OpConst, 1, 0b1010, OpOr, 0, 1}, 0, 0b1110},
		{"XOR", []int32{OpConst, 0, 0b1100, OpConst, 1, 0b1010, OpXor, 0, 1}, 0, 0b0110},
		{"NAND 是 ~(a & b)", []int32{OpConst, 0, 0b1100, OpConst, 1, 0b1010, OpNand, 0, 1}, 0, ^int32(0b1000)},
		{"ADD", []int32{OpConst, 0, 5, OpConst, 1, 7, OpAdd, 0, 1}, 0, 12},
		{"SUB", []int32{OpConst, 0, 5, OpConst, 1, 7, OpSub, 0, 1}, 0, -2},
		{"ADD 溢出按 32 位回绕", []int32{OpConst, 0, 2147483647, OpConst, 1, 1, OpAdd, 0, 1}, 0, -2147483648},
		{"MUL 按 32 位截断（Math.imul）", []int32{OpConst, 0, 65536, OpConst, 1, 65536, OpMul, 0, 1}, 0, 0},
		{"MUL 有符号回绕", []int32{OpConst, 0, 3, OpConst, 1, -3, OpMul, 0, 1}, 0, -9},
		{"MUL 溢出截断", []int32{OpConst, 0, 100000, OpConst, 1, 100000, OpMul, 0, 1}, 0, int32(uint64(100000*100000) & 0xffffffff)},
		{"ROTL 1", []int32{OpConst, 0, 1, OpRotl, 0, 1}, 0, 2},
		{"ROTL 31 等价 ROTR 1", []int32{OpConst, 0, 1, OpRotl, 0, 31}, 0, -2147483648},
		{"ROTR 1", []int32{OpConst, 0, 1, OpRotr, 0, 1}, 0, -2147483648},
		{"SHL 按 32 位截断", []int32{OpConst, 0, 1, OpShl, 0, 31}, 0, -2147483648},
		{"SHR 是算术右移", []int32{OpConst, 0, -8, OpShr, 0, 1}, 0, -4},
		{"NOT", []int32{OpConst, 0, 0, OpNot, 0, 0}, 0, -1},
		{"PROTO_JOIN 取拼接串长度", []int32{
			OpConst, 0, 16, OpConst, 1, 0, OpConst, 2, 45, OpConst, 3, 0, OpProtoJoin, 0, 0,
		}, 0, int32(len("16-0-45-0"))},
		{"PROTO_JOIN 负数带负号", []int32{
			OpConst, 0, -1, OpConst, 1, -1, OpConst, 2, -1, OpConst, 3, -1, OpProtoJoin, 0, 0,
		}, 0, int32(len("-1--1--1--1"))},
		{"PROTO_JOIN 写入任意寄存器", []int32{
			OpConst, 0, 16, OpConst, 1, 0, OpConst, 2, 45, OpConst, 3, 0, OpProtoJoin, 3, 0,
		}, 3, int32(len("16-0-45-0"))},
		{"PROTO_CHARCODE 取十进制串首字符", []int32{
			OpConst, 2, 45, OpProtoCharcode, 2, 0,
		}, 2, '4'},
		{"PROTO_CHARCODE 负数为 '-'", []int32{
			OpConst, 2, -1, OpProtoCharcode, 2, 0,
		}, 2, 45},
		{"DOM 建树/写读", []int32{
			OpConst, 3, 99,
			OpDomCreate, 0, 0,
			OpDomAppend, 0, 0,
			OpDomSetAttr, 3, 0,
			OpDomReadAttr, 1, 0,
		}, 1, 99},
		{"DOM_WALK_UP 累加祖先 data-v", []int32{
			OpConst, 3, 5,
			OpDomCreate, 0, 0, OpDomSetAttr, 3, 0,
			OpDomCreate, 0, 0, OpDomSetAttr, 3, 0,
			OpConst, 0, 0,
			OpDomWalkUp, 0, 1,
		}, 0, 10},
		{"DOM_WALK_UP 步数超过树深时停在根", []int32{
			OpConst, 3, 5,
			OpDomCreate, 0, 0, OpDomSetAttr, 3, 0,
			OpDomCreate, 0, 0, OpDomSetAttr, 3, 0,
			OpConst, 0, 0,
			OpDomWalkUp, 0, 11,
		}, 0, 10},
		{"DOM_REMOVE 弹栈顶", []int32{
			OpConst, 3, 7,
			OpDomCreate, 0, 0, OpDomSetAttr, 3, 0,
			OpDomCreate, 0, 0, OpDomSetAttr, 3, 0,
			OpDomRemove, 0, 0,
			OpDomReadAttr, 0, 0,
		}, 0, 7},
		{"DOM_WALK_UP 叠加到已有值", []int32{
			OpConst, 3, 5,
			OpDomCreate, 0, 0, OpDomSetAttr, 3, 0,
			OpConst, 0, 100,
			OpDomWalkUp, 0, 0,
		}, 0, 105},
	} {
		t.Run(tc.name, func(t *testing.T) {
			regs := runOps(t, tc.ops)
			if regs[tc.reg] != tc.want {
				t.Errorf("regs[%d] 期望 %d，实际 %d（完整 %v）", tc.reg, tc.want, regs[tc.reg], regs)
			}
		})
	}

	t.Run("DOM_SET_TEXT 与 DOM_READ_TEXT 往返", func(t *testing.T) {
		regs := runOps(t, []int32{
			OpConst, 1, 4242,
			OpDomCreate, 2, 0,
			OpDomSetText, 1, 0,
			OpConst, 1, 0,
			OpDomReadText, 1, 0,
		})
		if regs[1] != 4242 {
			t.Errorf("regs[1] 期望 4242，实际 %d", regs[1])
		}
	})
}

// ---------- 环境向量判定 ----------

// baseEnv 一个「真实浏览器」的基线环境向量：所有规则都不应命中
func baseEnv() map[string]any {
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

func blockedBySet(verdict EnvVerdict) map[string]bool {
	set := make(map[string]bool, len(verdict.BlockedBy))
	for _, item := range verdict.BlockedBy {
		set[item] = true
	}
	return set
}

func riskFlagSet(verdict EnvVerdict) map[string]bool {
	set := make(map[string]bool, len(verdict.RiskFlags))
	for _, item := range verdict.RiskFlags {
		set[item] = true
	}
	return set
}

func TestEvaluateEnvVectorCleanEnvironment(t *testing.T) {
	verdict := EvaluateEnvVector(baseEnv())
	if len(verdict.BlockedBy) != 0 {
		t.Errorf("基线环境不应命中任何拦截规则，实际 %v", verdict.BlockedBy)
	}
	if len(verdict.RiskFlags) != 0 {
		t.Errorf("基线环境不应有风险标记，实际 %v", verdict.RiskFlags)
	}
}

func TestEvaluateEnvVectorBlockRules(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(env map[string]any)
		want   string
	}{
		{"webdriver 为 true", func(env map[string]any) { env["cd"] = float64(1) }, "webdriver_true"},
		{"Blink 下 webdriver 被删除", func(env map[string]any) { env["cd"] = float64(-1) }, "webdriver_stripped"},
		{"UA 含 HeadlessChrome", func(env map[string]any) { env["ua"] = "Mozilla/5.0 HeadlessChrome/120" }, "headless_token"},
		{"brands 含 HeadlessChrome", func(env map[string]any) { env["br"] = `"HeadlessChrome";v="120"` }, "headless_token"},
		{"布局探针宽度为 0", func(env map[string]any) { env["lw"] = float64(0) }, "layout_zero"},
		{"布局探针高度为 0", func(env map[string]any) { env["lh"] = float64(0) }, "layout_zero"},
		{"布局探针为负", func(env map[string]any) { env["lw"] = float64(-1) }, "layout_zero"},
		{"Gecko 却暴露 deviceMemory", func(env map[string]any) { env["ge"] = float64(2); env["dm"] = float64(8) }, "gecko_contradiction"},
		{"Gecko 却暴露 userAgentData", func(env map[string]any) { env["ge"] = float64(2); env["dm"] = float64(-1); env["br"] = `"Firefox"` }, "gecko_contradiction"},
		{"窗口宽度超出屏幕容差", func(env map[string]any) {
			env["iw"] = float64(2000)
			env["ow"] = float64(2000)
			env["sw"] = float64(1920)
		}, "window_exceeds_screen"},
		{"窗口高度超出屏幕容差", func(env map[string]any) { env["oh"] = float64(1100); env["sh"] = float64(1080) }, "window_exceeds_screen"},
		{"字体宽度整数量化", func(env map[string]any) {
			env["tm"] = []any{float64(10), float64(10), float64(11), float64(11), float64(12), float64(12)}
		}, "geometry_quantized"},
		{"视口与屏幕完全相等", func(env map[string]any) {
			env["iw"] = float64(1920)
			env["ih"] = float64(1080)
		}, "viewport_override"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := baseEnv()
			tc.mutate(env)
			blocked := blockedBySet(EvaluateEnvVector(env))
			if !blocked[tc.want] {
				t.Errorf("应命中 %s，实际 %v", tc.want, blocked)
			}
		})
	}
}

func TestEvaluateEnvVectorSkipConditions(t *testing.T) {
	t.Run("ex 为 1 时跳过窗口超屏判定", func(t *testing.T) {
		env := baseEnv()
		env["ex"] = float64(1)
		env["ow"] = float64(3000)
		env["oh"] = float64(3000)
		if blocked := blockedBySet(EvaluateEnvVector(env)); blocked["window_exceeds_screen"] {
			t.Errorf("第二显示器场景不应命中 window_exceeds_screen")
		}
	})

	t.Run("容差 4 像素内不触发", func(t *testing.T) {
		env := baseEnv()
		env["sw"] = float64(1920)
		env["ow"] = float64(1924)
		if blocked := blockedBySet(EvaluateEnvVector(env)); blocked["window_exceeds_screen"] {
			t.Errorf("容差内不应命中 window_exceeds_screen")
		}
		env["ow"] = float64(1925)
		if blocked := blockedBySet(EvaluateEnvVector(env)); !blocked["window_exceeds_screen"] {
			t.Errorf("超出容差 1 像素应命中 window_exceeds_screen，实际 %v", blocked)
		}
	})

	t.Run("移动端跳过视口等于屏幕的判定", func(t *testing.T) {
		env := baseEnv()
		env["mob"] = float64(1)
		env["iw"] = float64(1920)
		env["ih"] = float64(1080)
		if blocked := blockedBySet(EvaluateEnvVector(env)); blocked["viewport_override"] {
			t.Errorf("移动端全屏不应命中 viewport_override")
		}
	})

	t.Run("视口为 0 时不触发 viewport_override", func(t *testing.T) {
		env := baseEnv()
		env["iw"] = float64(0)
		env["ih"] = float64(0)
		env["sw"] = float64(0)
		env["sh"] = float64(0)
		if blocked := blockedBySet(EvaluateEnvVector(env)); blocked["viewport_override"] {
			t.Errorf("视口为 0 不应命中 viewport_override")
		}
	})

	t.Run("整数量化需要至少 5 条整数且 2 个不同整数", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			tm   []any
			want bool
		}{
			{"只有 4 条整数", []any{float64(10), float64(11), float64(12), float64(13), 10.5}, false},
			{"5 条整数但只有 1 个不同值", []any{float64(10), float64(10), float64(10), float64(10), float64(10)}, false},
			{"5 条整数且有 2 个不同值", []any{float64(10), float64(10), float64(10), float64(11), float64(11)}, true},
		} {
			env := baseEnv()
			env["tm"] = tc.tm
			blocked := blockedBySet(EvaluateEnvVector(env))
			if blocked["geometry_quantized"] != tc.want {
				t.Errorf("%s: 期望 %v，实际 %v", tc.name, tc.want, blocked)
			}
		}
	})

	t.Run("WebKit 不会命中 Blink 专属规则", func(t *testing.T) {
		env := baseEnv()
		env["ge"] = float64(3)
		env["cd"] = float64(-1)
		blocked := blockedBySet(EvaluateEnvVector(env))
		if blocked["webdriver_stripped"] || blocked["gecko_contradiction"] {
			t.Errorf("WebKit 不应命中 Blink/Gecko 规则，实际 %v", blocked)
		}
	})
}

func TestEvaluateEnvVectorRiskFlags(t *testing.T) {
	t.Run("基线无风险标记", func(t *testing.T) {
		if flags := riskFlagSet(EvaluateEnvVector(baseEnv())); len(flags) != 0 {
			t.Errorf("基线不应有风险标记，实际 %v", flags)
		}
	})

	t.Run("native_tamper", func(t *testing.T) {
		env := baseEnv()
		env["nt"] = float64(4)
		if flags := riskFlagSet(EvaluateEnvVector(env)); !flags["native_tamper"] {
			t.Errorf("nt != 0 应标记 native_tamper")
		}
	})

	t.Run("few_font_metrics", func(t *testing.T) {
		env := baseEnv()
		env["tm"] = []any{10.5, 11.5, 12.5, 13.5}
		if flags := riskFlagSet(EvaluateEnvVector(env)); !flags["few_font_metrics"] {
			t.Errorf("字宽采样不足 5 条应标记 few_font_metrics")
		}
	})

	t.Run("ua_missing", func(t *testing.T) {
		env := baseEnv()
		env["ua"] = ""
		if flags := riskFlagSet(EvaluateEnvVector(env)); !flags["ua_missing"] {
			t.Errorf("UA 为空应标记 ua_missing")
		}
	})

	t.Run("风险标记永不拦截", func(t *testing.T) {
		env := baseEnv()
		env["nt"] = float64(7)
		env["ua"] = ""
		env["tm"] = []any{}
		verdict := EvaluateEnvVector(env)
		if len(verdict.RiskFlags) != 3 {
			t.Errorf("应命中三个风险标记，实际 %v", verdict.RiskFlags)
		}
		if blocked := blockedBySet(verdict); blocked["native_tamper"] || blocked["few_font_metrics"] || blocked["ua_missing"] {
			t.Errorf("风险标记不得出现在 blockedBy: %v", verdict.BlockedBy)
		}
	})
}

func TestNormalizeEnvVector(t *testing.T) {
	t.Run("缺失与畸形输入退化为未知", func(t *testing.T) {
		env := NormalizeEnvVector(map[string]any{
			"cd": "not-a-number",
			"ua": float64(123),
			"tm": "nope",
			"lw": nil,
		})
		if env.Cd != -1 {
			t.Errorf("cd 缺失/畸形应退化为 -1，实际 %v", env.Cd)
		}
		if env.Ua != "" {
			t.Errorf("ua 非字符串应退化为空串，实际 %q", env.Ua)
		}
		if len(env.Tm) != 0 {
			t.Errorf("tm 非数组应退化为空数组，实际 %v", env.Tm)
		}
		if env.Lw != 0 {
			t.Errorf("lw 非数值应退化为 0，实际 %v", env.Lw)
		}
		// 数值型字段除 cd/dm 外缺省为 0
		if env.Ge != 0 || env.Ex != 0 || env.Nt != 0 {
			t.Errorf("ge/ex/nt 缺省应为 0，实际 ge=%v ex=%v nt=%v", env.Ge, env.Ex, env.Nt)
		}
		if env.Dm != -1 {
			t.Errorf("dm 缺省应为 -1，实际 %v", env.Dm)
		}
	})

	t.Run("tm 过滤非数值并截断到 64 条", func(t *testing.T) {
		list := make([]any, 0, 100)
		for i := 0; i < 70; i++ {
			list = append(list, float64(i)+0.5)
		}
		list = append(list, "bad", nil, true)
		env := NormalizeEnvVector(map[string]any{"tm": list})
		if len(env.Tm) != 64 {
			t.Errorf("tm 应截断到 64 条，实际 %d", len(env.Tm))
		}
	})

	t.Run("nil 环境向量全部退化", func(t *testing.T) {
		env := NormalizeEnvVector(nil)
		if env.Cd != -1 || env.Dm != -1 || env.Lw != 0 || len(env.Tm) != 0 {
			t.Errorf("nil 输入应全部退化，实际 %+v", env)
		}
	})
}

// ---------- 整链路校验 ----------

// goodInstrumentationAnswer 用服务端自己派生的程序构造一份合法答案
func goodInstrumentationAnswer(t *testing.T, cid, secret string) map[string]any {
	t.Helper()
	challenge := CreateInstrumentationChallenge(cid, secret)
	regs, ok := InterpretProgram(InstrumentationProgram{Ops: challenge.Ops})
	if !ok {
		t.Fatalf("程序应可解释")
	}
	env := baseEnv()
	return map[string]any{
		"regs": []any{float64(regs[0]), float64(regs[1]), float64(regs[2]), float64(regs[3])},
		"env":  env,
		"lw":   env["lw"],
		"lh":   env["lh"],
		"tm":   env["tm"],
	}
}

func TestVerifyInstrumentation(t *testing.T) {
	const cid = "vector-instr-check"
	secret := loadInstrumentationFixture(t).Secret

	t.Run("合法答案通过（不拦截自动化）", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		result := VerifyInstrumentation(cid, secret, answer, false)
		if !result.OK {
			t.Fatalf("合法答案应通过，reason=%q", result.Reason)
		}
		if len(result.BlockedBy) != 0 || len(result.RiskFlags) != 0 {
			t.Errorf("基线环境不应产生判定，实际 blockedBy=%v riskFlags=%v", result.BlockedBy, result.RiskFlags)
		}
	})

	t.Run("寄存器不匹配", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		regs := answer["regs"].([]any)
		regs[1] = float64(int(regs[1].(float64)) + 1)
		result := VerifyInstrumentation(cid, secret, answer, false)
		if result.OK || result.Reason != "program result mismatch" {
			t.Errorf("寄存器不匹配应以 program result mismatch 拒绝，实际 ok=%v reason=%q", result.OK, result.Reason)
		}
	})

	t.Run("寄存器畸形", func(t *testing.T) {
		base := goodInstrumentationAnswer(t, cid, secret)
		goodRegs := base["regs"].([]any)

		// 畸形值放在第 1 位：校验是逐位比较的，放在后面会被前面的不匹配先拦下
		nonNumeric := append([]any{}, goodRegs...)
		nonNumeric[1] = "x"
		nonInteger := append([]any{}, goodRegs...)
		nonInteger[1] = float64(int(goodRegs[1].(float64))) + 0.5
		missing := append([]any{}, goodRegs...)
		missing[1] = nil

		for _, tc := range []struct {
			name string
			regs any
		}{
			{"缺少 regs", nil},
			{"数量不对", []any{float64(1), float64(2)}},
			{"含非数值", nonNumeric},
			{"含非整数", nonInteger},
			{"含 null", missing},
		} {
			answer := map[string]any{"env": base["env"], "lw": base["lw"], "lh": base["lh"]}
			if tc.regs != nil {
				answer["regs"] = tc.regs
			}
			result := VerifyInstrumentation(cid, secret, answer, false)
			if result.OK || result.Reason != "malformed registers" {
				t.Errorf("%s 应以 malformed registers 拒绝，实际 ok=%v reason=%q", tc.name, result.OK, result.Reason)
			}
		}
	})

	t.Run("浮点寄存器按 ToInt32 比较", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		regs := answer["regs"].([]any)
		// 16.0 与 16 在 JS 里都是 Number.isInteger 为真的同一个值
		regs[0] = float64(int(regs[0].(float64)))
		if result := VerifyInstrumentation(cid, secret, answer, false); !result.OK {
			t.Errorf("整数浮点应被接受，reason=%q", result.Reason)
		}
	})

	t.Run("blockAutomated=true 时命中规则即拒绝", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		env := answer["env"].(map[string]any)
		env["cd"] = float64(1)
		result := VerifyInstrumentation(cid, secret, answer, true)
		if result.OK {
			t.Fatalf("blockAutomated 为真时应拒绝")
		}
		if result.Reason != "automated browser detected: webdriver_true" {
			t.Errorf("reason 应为 automated browser detected: webdriver_true，实际 %q", result.Reason)
		}
	})

	t.Run("blockAutomated=false 时只记录不拒绝", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		env := answer["env"].(map[string]any)
		env["cd"] = float64(1)
		result := VerifyInstrumentation(cid, secret, answer, false)
		if !result.OK {
			t.Fatalf("blockAutomated 为假时不应拒绝，reason=%q", result.Reason)
		}
		if len(result.BlockedBy) != 1 || result.BlockedBy[0] != "webdriver_true" {
			t.Errorf("应记录 blockedBy=webdriver_true，实际 %v", result.BlockedBy)
		}
	})

	t.Run("布局探针并入判定结果", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		answer["lw"] = float64(0)
		result := VerifyInstrumentation(cid, secret, answer, true)
		if result.OK {
			t.Fatalf("布局探针为 0 时应拒绝")
		}
		if result.Reason != "automated browser detected: layout_zero" {
			t.Errorf("reason 应为 layout_zero，实际 %q", result.Reason)
		}
	})

	t.Run("layout_zero 不重复出现", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		env := answer["env"].(map[string]any)
		env["lw"] = float64(0)
		answer["lw"] = float64(0)
		result := VerifyInstrumentation(cid, secret, answer, false)
		count := 0
		for _, item := range result.BlockedBy {
			if item == "layout_zero" {
				count++
			}
		}
		if count != 1 {
			t.Errorf("layout_zero 应只出现一次，实际 %v", result.BlockedBy)
		}
	})

	t.Run("答案缺失时判为寄存器畸形", func(t *testing.T) {
		if result := VerifyInstrumentation(cid, secret, nil, false); result.OK || result.Reason != "malformed registers" {
			t.Errorf("缺失答案应以 malformed registers 拒绝，实际 ok=%v reason=%q", result.OK, result.Reason)
		}
	})

	t.Run("不同 cid 派生不同程序", func(t *testing.T) {
		answer := goodInstrumentationAnswer(t, cid, secret)
		if result := VerifyInstrumentation("another-cid", secret, answer, false); result.OK {
			t.Errorf("用别的 cid 提交应因程序不一致被拒绝")
		}
	})
}

// TestInstrumentationFixtureCoversAllOpcodes 钉住「fixture 覆盖全部 24 个操作码」
func TestInstrumentationFixtureCoversAllOpcodes(t *testing.T) {
	fixture := loadInstrumentationFixture(t)

	seen := make(map[int32]bool)
	for _, vector := range fixture.Vectors {
		if len(vector.Ops)%InstrOpStride != 0 {
			t.Fatalf("fixture 的 ops 长度必须是 %d 的倍数", InstrOpStride)
		}
		for i := 0; i < len(vector.Ops); i += InstrOpStride {
			seen[vector.Ops[i]] = true
		}
	}
	for op := int32(0); op <= InstrMaxOpcode; op++ {
		if !seen[op] {
			t.Errorf("fixture 未覆盖操作码 %d", op)
		}
	}
}
