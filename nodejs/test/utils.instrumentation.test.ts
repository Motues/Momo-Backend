import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  generateProgram,
  interpretProgram,
  evaluateEnvVector,
  normalizeEnvVector,
  createInstrumentationChallenge,
  verifyInstrumentation,
  InstrOp,
  INSTR_REG_COUNT,
  INSTR_OP_STRIDE,
  INSTR_MAX_OPCODE,
  INSTR_TAGS,
  INSTR_MAX_OPS,
  type EnvVector,
} from "../src/utils/instrumentation";

/* ------------------------------------------------------------------ *
 * 程序生成
 * ------------------------------------------------------------------ */
describe("instrumentation —— 程序生成", () => {
  const seedA = crypto.createHash("sha256").update("seed-a").digest();
  const seedB = crypto.createHash("sha256").update("seed-b").digest();

  it("确定性：同一种子必然生成同一程序", () => {
    expect(generateProgram(seedA).ops).toEqual(generateProgram(seedA).ops);
  });

  it("不同种子生成不同程序", () => {
    expect(generateProgram(seedA).ops).not.toEqual(generateProgram(seedB).ops);
  });

  it("长度为 3 的整数倍，且操作码与参数都在合法范围", () => {
    for (let i = 0; i < 50; i++) {
      const seed = crypto.createHash("sha256").update(`s${i}`).digest();
      const { ops } = generateProgram(seed);
      expect(ops.length % INSTR_OP_STRIDE).toBe(0);
      expect(ops.length / INSTR_OP_STRIDE).toBeLessThanOrEqual(INSTR_MAX_OPS);

      for (let k = 0; k < ops.length; k += INSTR_OP_STRIDE) {
        expect(ops[k]).toBeGreaterThanOrEqual(0);
        expect(ops[k]).toBeLessThanOrEqual(INSTR_MAX_OPCODE);
      }
    }
  });

  it("200 组随机程序都能被解释成功（DOM 栈必须始终平衡）", () => {
    for (let i = 0; i < 200; i++) {
      const seed = crypto.createHash("sha256").update(`balance-${i}`).digest();
      const result = interpretProgram(generateProgram(seed));
      expect(result.ok, `seed balance-${i} 解释失败`).toBe(true);
      expect(result.regs).toHaveLength(INSTR_REG_COUNT);
      for (const reg of result.regs) {
        expect(Number.isInteger(reg)).toBe(true);
      }
    }
  });

  it("程序里包含真实的 DOM 建树与原型链调用", () => {
    // 取若干程序，确认生成器不会退化成纯算术
    let withDom = 0;
    let withProto = 0;
    for (let i = 0; i < 30; i++) {
      const seed = crypto.createHash("sha256").update(`shape-${i}`).digest();
      const { ops } = generateProgram(seed);
      const opcodes = new Set<number>();
      for (let k = 0; k < ops.length; k += INSTR_OP_STRIDE) opcodes.add(ops[k]);
      if (opcodes.has(InstrOp.DOM_CREATE) && opcodes.has(InstrOp.DOM_REMOVE)) withDom++;
      if (opcodes.has(InstrOp.PROTO_JOIN) && opcodes.has(InstrOp.PROTO_CHARCODE)) withProto++;
    }
    expect(withDom).toBe(30);
    expect(withProto).toBe(30);
  });

  it("标签 id 始终落在候选表范围内", () => {
    for (let i = 0; i < 50; i++) {
      const seed = crypto.createHash("sha256").update(`tag-${i}`).digest();
      const { ops } = generateProgram(seed);
      for (let k = 0; k < ops.length; k += INSTR_OP_STRIDE) {
        if (ops[k] === InstrOp.DOM_CREATE) {
          expect(ops[k + 1]).toBeGreaterThanOrEqual(0);
          expect(ops[k + 1]).toBeLessThan(INSTR_TAGS.length);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 解释器：逐指令语义（手写程序 + 手算期望值）
 * ------------------------------------------------------------------ */
/**
 * 把 [op, a, b] 三元组列表编码成扁平数组。
 * 每个三元组自动补位到 3 个整数，避免手写时漏参数导致长度不是 3 的倍数
 * （那样会被解释器整体拒绝，测试就会以「语义错误」的形式暴露成「输入非法」）。
 */
function prog(...triples: number[][]): { ops: number[] } {
  return { ops: triples.flatMap((t) => [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0]) };
}

describe("instrumentation —— 解释器整数语义", () => {
  it("CONST / MOV", () => {
    expect(interpretProgram(prog([InstrOp.CONST, 0, 7], [InstrOp.MOV, 1, 0])).regs).toEqual([7, 7, 0, 0]);
  });

  it("按位运算 AND / OR / XOR / NAND", () => {
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, 0b1100],
        [InstrOp.CONST, 1, 0b1010],
        [InstrOp.AND, 0, 1],
        [InstrOp.OR, 1, 2], // r2 为 0，r1 保持 0b1010
        [InstrOp.CONST, 2, 0b0110],
        [InstrOp.XOR, 2, 0],
        [InstrOp.CONST, 3, 0b1],
        [InstrOp.NAND, 3, 2]
      )
    ).regs;
    expect(r[0]).toBe(0b1000);
    expect(r[1]).toBe(0b1010);
    expect(r[2]).toBe(0b0110 ^ 0b1000);
    expect(r[3]).toBe(~(0b1 & (0b0110 ^ 0b1000)));
  });

  it("加减乘按 32 位回绕，乘法是 imul", () => {
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, 0x7fffffff],
        [InstrOp.CONST, 1, 1],
        [InstrOp.ADD, 0, 1],
        [InstrOp.CONST, 2, 0x40000000],
        [InstrOp.CONST, 3, 4],
        [InstrOp.MUL, 2, 3]
      )
    ).regs;
    expect(r[0]).toBe(-0x80000000);
    expect(r[2]).toBe(Math.imul(0x40000000, 4));
  });

  it("移位与旋转使用 32 位语义", () => {
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, 1],
        [InstrOp.SHL, 0, 31],
        [InstrOp.CONST, 1, -1],
        [InstrOp.SHR, 1, 1], // 算术右移
        [InstrOp.CONST, 2, 1],
        [InstrOp.ROTL, 2, 1],
        [InstrOp.CONST, 3, 1],
        [InstrOp.ROTR, 3, 1]
      )
    ).regs;
    expect(r[0]).toBe(1 << 31);
    expect(r[1]).toBe(-1);
    expect(r[2]).toBe(2);
    expect(r[3]).toBe(1 << 31);
  });

  it("旋转的边界位移量（0 与 32）不退化", () => {
    // 生成器只产出 1..31，但解释器在边界上必须同样良定义：
    // 位移量按 & 31 处理，0 与 32 都应等价于「不变」，绝不能变成 NaN/undefined。
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, 0x1234],
        [InstrOp.ROTL, 0, 0],
        [InstrOp.CONST, 1, 0x1234],
        [InstrOp.ROTR, 1, 0],
        [InstrOp.CONST, 2, 0x1234],
        [InstrOp.ROTL, 2, 32],
        [InstrOp.CONST, 3, 0x1234],
        [InstrOp.SHL, 3, 0]
      )
    ).regs;
    expect(r).toEqual([0x1234, 0x1234, 0x1234, 0x1234]);
  });

  it("NOT 取反", () => {
    expect(interpretProgram(prog([InstrOp.CONST, 0, 0], [InstrOp.NOT, 0])).regs[0]).toBe(-1);
  });

  it("PROTO_JOIN / PROTO_CHARCODE", () => {
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, -1],
        [InstrOp.CONST, 1, 22],
        [InstrOp.CONST, 2, 333],
        [InstrOp.CONST, 3, 4],
        [InstrOp.PROTO_JOIN, 0, 0], // "-1-22-333-4".length
        [InstrOp.CONST, 1, 0],
        [InstrOp.PROTO_CHARCODE, 1, 0] // "0".charCodeAt(0)
      )
    ).regs;
    expect(r[0]).toBe("-1-22-333-4".length);
    expect(r[1]).toBe("0".charCodeAt(0));
  });
});

describe("instrumentation —— 解释器 DOM 影子模型", () => {
  it("写入属性后读回，值一致", () => {
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, 12345],
        [InstrOp.DOM_CREATE, 0, 0],
        [InstrOp.DOM_SET_ATTR, 0, 0],
        [InstrOp.CONST, 0, 0],
        [InstrOp.DOM_READ_ATTR, 0, 0]
      )
    );
    expect(r.ok).toBe(true);
    expect(r.regs[0]).toBe(12345);
  });

  it("写入文本后读回，值一致", () => {
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, -777],
        [InstrOp.DOM_CREATE, 0, 0],
        [InstrOp.DOM_SET_TEXT, 0, 0],
        [InstrOp.CONST, 0, 0],
        [InstrOp.DOM_READ_TEXT, 0, 0]
      )
    );
    expect(r.ok).toBe(true);
    expect(r.regs[0]).toBe(-777);
  });

  it("DOM_WALK_UP 沿 parentElement 链累加祖先属性", () => {
    // 建三层，每层 data-v 分别为 1、2、3；从最深层向上走 2 步 => 3+2+1 = 6
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, 1],
        [InstrOp.DOM_CREATE, 0, 0],
        [InstrOp.DOM_APPEND],
        [InstrOp.DOM_SET_ATTR, 0, 0],
        [InstrOp.CONST, 1, 2],
        [InstrOp.DOM_CREATE, 1, 0],
        [InstrOp.DOM_APPEND],
        [InstrOp.DOM_SET_ATTR, 1, 0],
        [InstrOp.CONST, 2, 3],
        [InstrOp.DOM_CREATE, 2, 0],
        [InstrOp.DOM_APPEND],
        [InstrOp.DOM_SET_ATTR, 2, 0],
        [InstrOp.CONST, 3, 0],
        [InstrOp.DOM_WALK_UP, 3, 2]
      )
    );
    expect(r.ok).toBe(true);
    expect(r.regs[3]).toBe(6);
  });

  it("DOM_WALK_UP 走到根之后停止，不会越界", () => {
    const r = interpretProgram(
      prog(
        [InstrOp.CONST, 0, 5],
        [InstrOp.DOM_CREATE, 0, 0],
        [InstrOp.DOM_SET_ATTR, 0, 0],
        [InstrOp.CONST, 1, 0],
        [InstrOp.DOM_WALK_UP, 1, 99]
      )
    );
    expect(r.ok).toBe(true);
    expect(r.regs[1]).toBe(5);
  });

  it("移除节点后再读会失败（栈不可为空）", () => {
    const r = interpretProgram(
      prog([InstrOp.DOM_CREATE, 0, 0], [InstrOp.DOM_REMOVE], [InstrOp.DOM_READ_ATTR, 0, 0])
    );
    expect(r.ok).toBe(false);
  });
});

describe("instrumentation —— 解释器输入校验", () => {
  it("非数组 / 长度不是 3 的倍数 / 超长都拒绝", () => {
    expect(interpretProgram({ ops: [] }).ok).toBe(false); // 0 个操作视为非法
    expect(interpretProgram({ ops: [0, 0] }).ok).toBe(false);
    expect(interpretProgram({ ops: [InstrOp.CONST, 0, 1, InstrOp.CONST] }).ok).toBe(false);
    expect(interpretProgram({ ops: new Array((INSTR_MAX_OPS + 9) * 3).fill(0) }).ok).toBe(false);
    expect(interpretProgram(undefined as any).ok).toBe(false);
  });

  it("非法操作码被拒绝", () => {
    expect(interpretProgram({ ops: [999, 0, 0] }).ok).toBe(false);
    expect(interpretProgram({ ops: [-1, 0, 0] }).ok).toBe(false);
  });

  it("寄存器下标越界被拒绝", () => {
    expect(interpretProgram(prog([InstrOp.CONST, INSTR_REG_COUNT, 1])).ok).toBe(false);
    expect(interpretProgram(prog([InstrOp.MOV, 0, INSTR_REG_COUNT])).ok).toBe(false);
    expect(interpretProgram(prog([InstrOp.ADD, -1, 0])).ok).toBe(false);
    expect(interpretProgram(prog([InstrOp.DOM_READ_ATTR, 9, 0])).ok).toBe(false);
  });

  it("标签 id 越界被拒绝", () => {
    expect(interpretProgram(prog([InstrOp.DOM_CREATE, INSTR_TAGS.length, 0])).ok).toBe(false);
    expect(interpretProgram(prog([InstrOp.DOM_CREATE, -1, 0])).ok).toBe(false);
  });

  it("空栈上执行 DOM 写入被拒绝", () => {
    expect(interpretProgram(prog([InstrOp.DOM_SET_ATTR, 0, 0])).ok).toBe(false);
    expect(interpretProgram(prog([InstrOp.DOM_SET_TEXT, 0, 0])).ok).toBe(false);
    expect(interpretProgram(prog([InstrOp.DOM_REMOVE])).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 环境向量与自动化检测
 * ------------------------------------------------------------------ */

/** 一份能通过全部拦截规则的基线向量 */
const OK_ENV: EnvVector = {
  cd: 0,
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
  br: "",
  ge: 1,
  dm: 8,
  tm: [10.5, 11.25, 12.5, 13.75, 14.5, 15.25],
  lw: 120.5,
  lh: 32.25,
  iw: 1200,
  ih: 800,
  ow: 1280,
  oh: 900,
  sw: 1920,
  sh: 1080,
  ex: 0,
  mob: 0,
  nt: 0,
};

describe("instrumentation —— 环境向量归一化", () => {
  it("缺失或类型不对的字段退化为未知，而不是被静默跳过", () => {
    const env = normalizeEnvVector({});
    expect(env.cd).toBe(-1);
    expect(env.ua).toBe("");
    expect(env.tm).toEqual([]);
    expect(env.lw).toBe(0);
    expect(env.ge).toBe(0);
  });

  it("非有限数值被替换（NaN / Infinity 不能当 0 混过去）", () => {
    // 几何类字段的缺省值是 0（fail-closed：布局探针为 0 会被 layout_zero 拦下），
    // 而 webdriver / deviceMemory / 引擎标记这类「三态」字段缺省为 -1（未知）。
    const env = normalizeEnvVector({ lw: NaN, lh: Infinity, sw: "1920", cd: NaN, dm: "8" });
    expect(env.lw).toBe(0);
    expect(env.lh).toBe(0);
    expect(env.sw).toBe(0);
    expect(env.cd).toBe(-1);
    expect(env.dm).toBe(-1);
  });

  it("字体度量数组会过滤非法值并截断", () => {
    const many = Array.from({ length: 100 }, () => 10.5);
    const env = normalizeEnvVector({ tm: [1, NaN, "x", 2, ...many] });
    expect(env.tm.length).toBeLessThanOrEqual(64);
    expect(env.tm.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("超长字符串被截断", () => {
    const env = normalizeEnvVector({ ua: "a".repeat(1000), br: "b".repeat(1000) });
    expect(env.ua.length).toBe(300);
    expect(env.br.length).toBe(300);
  });
});

describe("instrumentation —— 自动化检测规则", () => {
  it("基线向量不命中任何拦截规则，也没有风险标记", () => {
    expect(evaluateEnvVector(OK_ENV)).toEqual({ blockedBy: [], riskFlags: [] });
  });

  it("webdriver_true：规范标志为 true", () => {
    expect(evaluateEnvVector({ ...OK_ENV, cd: 1 }).blockedBy).toContain("webdriver_true");
  });

  it("webdriver_stripped：Blink 上 webdriver 为 undefined", () => {
    expect(evaluateEnvVector({ ...OK_ENV, cd: -1, ge: 1 }).blockedBy).toContain("webdriver_stripped");
    // 非 Blink 引擎上 undefined 是正常的，不应命中
    expect(evaluateEnvVector({ ...OK_ENV, cd: -1, ge: 3 }).blockedBy).not.toContain("webdriver_stripped");
  });

  it("headless_token：UA 或 brands 里出现 HeadlessChrome", () => {
    expect(evaluateEnvVector({ ...OK_ENV, ua: "Mozilla/5.0 HeadlessChrome/130" }).blockedBy).toContain("headless_token");
    expect(evaluateEnvVector({ ...OK_ENV, br: "HeadlessChrome/130" }).blockedBy).toContain("headless_token");
  });

  it("layout_zero：没有真实布局引擎（jsdom 返回 0）", () => {
    expect(evaluateEnvVector({ ...OK_ENV, lw: 0 }).blockedBy).toContain("layout_zero");
    expect(evaluateEnvVector({ ...OK_ENV, lh: 0 }).blockedBy).toContain("layout_zero");
  });

  it("gecko_contradiction：Gecko 引擎却暴露 Chrome 专属 API", () => {
    expect(evaluateEnvVector({ ...OK_ENV, ge: 2, dm: 8 }).blockedBy).toContain("gecko_contradiction");
    expect(evaluateEnvVector({ ...OK_ENV, ge: 2, dm: -1, br: "Chromium/130" }).blockedBy).toContain(
      "gecko_contradiction"
    );
    // 纯 Gecko 且两个 API 都不存在时正常
    expect(evaluateEnvVector({ ...OK_ENV, ge: 2, dm: -1, br: "" }).blockedBy).not.toContain("gecko_contradiction");
  });

  it("window_exceeds_screen：窗口高于屏幕", () => {
    expect(evaluateEnvVector({ ...OK_ENV, oh: 1200 }).blockedBy).toContain("window_exceeds_screen");
    // 容差内不命中
    expect(evaluateEnvVector({ ...OK_ENV, oh: 1084 }).blockedBy).not.toContain("window_exceeds_screen");
    // 扩展屏（第二显示器）时跳过
    expect(evaluateEnvVector({ ...OK_ENV, oh: 2000, ex: 1 }).blockedBy).not.toContain("window_exceeds_screen");
  });

  it("geometry_quantized：字宽被吸附到整像素", () => {
    expect(evaluateEnvVector({ ...OK_ENV, tm: [10, 11, 12, 13, 14] }).blockedBy).toContain("geometry_quantized");
    // 只有单一整数值（单一字体系统）不命中
    expect(evaluateEnvVector({ ...OK_ENV, tm: [10, 10, 10, 10, 10] }).blockedBy).not.toContain("geometry_quantized");
    // 不足 5 条整数值不命中
    expect(evaluateEnvVector({ ...OK_ENV, tm: [10, 11, 12, 13, 10.5] }).blockedBy).not.toContain("geometry_quantized");
    // 全为小数（真实渲染引擎）不命中
    expect(evaluateEnvVector({ ...OK_ENV, tm: [10.5, 11.25, 12.75] }).blockedBy).not.toContain("geometry_quantized");
  });

  it("viewport_override：视口与屏幕完全相等且非移动端", () => {
    expect(evaluateEnvVector({ ...OK_ENV, iw: 1920, ih: 1080 }).blockedBy).toContain("viewport_override");
    // 移动端全屏是正常的
    expect(evaluateEnvVector({ ...OK_ENV, iw: 1920, ih: 1080, mob: 1 }).blockedBy).not.toContain("viewport_override");
  });

  it("风险标记：原生方法被改写 / 字体采样不足 / UA 缺失", () => {
    expect(evaluateEnvVector({ ...OK_ENV, nt: 1 }).riskFlags).toContain("native_tamper");
    expect(evaluateEnvVector({ ...OK_ENV, tm: [1.5, 2.5] }).riskFlags).toContain("few_font_metrics");
    expect(evaluateEnvVector({ ...OK_ENV, ua: "" }).riskFlags).toContain("ua_missing");
  });

  it("风险标记不会导致拦截", () => {
    const verdict = evaluateEnvVector({ ...OK_ENV, nt: 7, tm: [], ua: "" });
    expect(verdict.blockedBy).toEqual([]);
    expect(verdict.riskFlags.length).toBeGreaterThan(0);
  });

  it("畸形输入不会因为字段缺失而放行（布局探针缺失即拦截）", () => {
    expect(evaluateEnvVector(undefined).blockedBy).toContain("layout_zero");
    expect(evaluateEnvVector(null).blockedBy).toContain("layout_zero");
  });
});

/* ------------------------------------------------------------------ *
 * 共享 fixture：与前端测试读同一份文件
 *
 * 前端用真实 DOM 解释这些程序，服务端用影子模型推算；两侧必须逐位一致。
 * 这里断言服务端能（1）从 seed 重新派生出同一程序，（2）推算出一致的寄存器，
 * （3）fixture 覆盖全部操作码 —— 否则前端那边会有语义盲区。
 * ------------------------------------------------------------------ */
describe("instrumentation —— 共享 fixture（与前端解释器对齐）", () => {
  const fixturePath = path.resolve(__dirname, "..", "..", "doc", "vectors", "instrumentation-v2.json");
  const loadFixture = () => JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  it("fixture 存在且结构正确", () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
    const fixture = loadFixture();
    expect(Array.isArray(fixture.vectors)).toBe(true);
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  it("从 seed 重新派生出的程序与 fixture 一致（生成器口径未漂移）", () => {
    for (const vector of loadFixture().vectors) {
      const seed = Buffer.from(vector.seed, "hex");
      expect(generateProgram(seed).ops, `cid=${vector.cid}`).toEqual(vector.ops);
    }
  });

  it("影子模型推算的寄存器与 fixture 一致（解释器口径未漂移）", () => {
    for (const vector of loadFixture().vectors) {
      const result = interpretProgram({ ops: vector.ops });
      expect(result.ok, `cid=${vector.cid} 解释失败`).toBe(true);
      expect(result.regs, `cid=${vector.cid}`).toEqual(vector.regs);
    }
  });

  it("fixture 覆盖了全部操作码（否则前端测试会有语义盲区）", () => {
    const seen = new Set<number>();
    for (const vector of loadFixture().vectors) {
      for (let i = 0; i < vector.ops.length; i += INSTR_OP_STRIDE) seen.add(vector.ops[i]);
    }
    for (let op = 0; op <= INSTR_MAX_OPCODE; op++) {
      expect(seen.has(op), `操作码 ${op} 未被 fixture 覆盖`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 端到端：质询派生 + 校验
 * ------------------------------------------------------------------ */
describe("instrumentation —— 质询与校验", () => {
  const CID = "dGVzdC1jaGFsbGVuZ2U";
  const SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";

  /** 用服务端派生的期望值构造一份「正确答案」 */
  function correctAnswer(cid = CID, secret = SECRET) {
    const challenge = createInstrumentationChallenge(cid, secret);
    const expected = interpretProgram({ ops: challenge.ops });
    return {
      challenge,
      expected,
      answer: {
        regs: [...expected.regs],
        lw: 120.5,
        lh: 32.25,
        tm: OK_ENV.tm,
        env: { ...OK_ENV },
      },
    };
  }

  it("质询确定性：同（密钥, 挑战 id）派生同一程序", () => {
    expect(createInstrumentationChallenge(CID, SECRET).ops).toEqual(
      createInstrumentationChallenge(CID, SECRET).ops
    );
  });

  it("换挑战 id 或换密钥都会得到不同程序", () => {
    const base = createInstrumentationChallenge(CID, SECRET).ops;
    expect(createInstrumentationChallenge("other", SECRET).ops).not.toEqual(base);
    expect(createInstrumentationChallenge(CID, "other-secret").ops).not.toEqual(base);
  });

  it("正确答案通过校验（默认不拦截自动化，只记录）", () => {
    const { answer } = correctAnswer();
    const result = verifyInstrumentation(CID, SECRET, answer, false);
    expect(result.ok).toBe(true);
    expect(result.blockedBy).toEqual([]);
  });

  it("寄存器与期望值不一致时拒绝", () => {
    const { answer, expected } = correctAnswer();
    const tampered = { ...answer, regs: [...expected.regs] };
    tampered.regs[0] = (tampered.regs[0] + 1) | 0;
    const result = verifyInstrumentation(CID, SECRET, tampered, false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("program result mismatch");
  });

  it("寄存器个数不对或非整数时拒绝", () => {
    const { answer } = correctAnswer();
    expect(verifyInstrumentation(CID, SECRET, { ...answer, regs: [1, 2, 3] }, false).reason).toBe(
      "malformed registers"
    );
    expect(verifyInstrumentation(CID, SECRET, { ...answer, regs: "x" }, false).reason).toBe(
      "malformed registers"
    );
    expect(verifyInstrumentation(CID, SECRET, { ...answer, regs: [1.5, 2, 3, 4] }, false).reason).toBe(
      "malformed registers"
    );
  });

  it("匿名挑战 id 派生出的期望值不同，答案自然不匹配", () => {
    const { answer } = correctAnswer();
    const result = verifyInstrumentation("另一个挑战", SECRET, answer, false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("program result mismatch");
  });

  it("blockAutomated=false 时只记录风险，不拒绝", () => {
    const { answer } = correctAnswer();
    const result = verifyInstrumentation(CID, SECRET, { ...answer, env: { ...OK_ENV, cd: 1 } }, false);
    expect(result.ok).toBe(true);
    expect(result.blockedBy).toContain("webdriver_true");
  });

  it("blockAutomated=true 时命中自动化规则即拒绝", () => {
    const { answer } = correctAnswer();
    const result = verifyInstrumentation(CID, SECRET, { ...answer, env: { ...OK_ENV, cd: 1 } }, true);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toContain("webdriver_true");
    expect(result.reason).toContain("webdriver_true");
  });

  it("布局探针为 0 时，即使寄存器正确也会被拦（blockAutomated=true）", () => {
    const { answer } = correctAnswer();
    const result = verifyInstrumentation(CID, SECRET, { ...answer, lw: 0 }, true);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toContain("layout_zero");
  });

  it("风险标记即使 blockAutomated=true 也不导致拒绝", () => {
    const { answer } = correctAnswer();
    const result = verifyInstrumentation(CID, SECRET, { ...answer, env: { ...OK_ENV, nt: 3 } }, true);
    expect(result.ok).toBe(true);
    expect(result.riskFlags).toContain("native_tamper");
  });
});
