import crypto from "crypto";

/**
 * Instrumentation 质询（第二层验证）— Node.js 实现
 *
 * 与第一层的关系（互补，不是替代）：
 * - HashWX 证明「付出了算力」
 * - Instrumentation 证明「计算确实发生在一个真实浏览器环境里」
 *
 * 设计要点：
 *
 * 1. **无状态**：程序与期望值都由（密钥, 挑战 id）确定性派生，服务端不保存任何挑战内容。
 *    客户端提交答案后，服务端重新派生同一个程序并用「影子 DOM 模型」独立推算期望寄存器。
 *
 * 2. **可推算的确定性部分**：程序只由整数运算与 DOM 元素树操作组成，且所有 DOM 读取
 *    读的都是程序自己写进去的值。因此服务端不需要真实 DOM 就能算出期望结果，
 *    而客户端必须真的建树、真的走 parentElement 链才能拿到同样的值。
 *
 * 3. **真正的牙齿在探针与环境规则**：确定性那部分理论上可以被任何 JS 环境复现，
 *    所以另有两道防线：
 *    - 布局探针：要求真实渲染引擎给出非零几何尺寸（jsdom / happy-dom 返回 0）
 *    - 环境规则：navigator.webdriver、HeadlessChrome、引擎与 API 自相矛盾等自动化特征
 *
 * 4. **诚实结论**：第二层不是银弹。按 Cap 的公开说明，undetected-chromedriver 驱动
 *    **有头**原生 Chrome 可以绕过全部自动化检测；真正让批量滥用变贵的是第一层 PoW。
 *    默认配置下第二层只记录风险、不拦截（见 comment_verify_block_automated）。
 */

/** 寄存器个数 */
export const INSTR_REG_COUNT = 4;
/** 每个操作的整数个数：opcode + 两个参数（不足补 0） */
export const INSTR_OP_STRIDE = 3;
/** 操作数上限，避免被塞入超长程序拖慢校验 */
export const INSTR_MAX_OPS = 240;
/** 指令总数上限（含尾部收尾指令） */
const INSTR_MIN_OPS = 40;
/** DOM 树深上限：既避免无界增长，也让尾部收尾指令的数量可预算 */
const MAX_DOM_DEPTH = 12;

/** 操作码 */
export const enum InstrOp {
  CONST = 0,
  MOV = 1,
  AND = 2,
  OR = 3,
  XOR = 4,
  NAND = 5,
  ADD = 6,
  SUB = 7,
  MUL = 8,
  ROTL = 9,
  ROTR = 10,
  SHL = 11,
  SHR = 12,
  NOT = 13,
  DOM_CREATE = 14,
  DOM_APPEND = 15,
  DOM_SET_TEXT = 16,
  DOM_SET_ATTR = 17,
  DOM_READ_TEXT = 18,
  DOM_READ_ATTR = 19,
  DOM_WALK_UP = 20,
  DOM_REMOVE = 21,
  PROTO_JOIN = 22,
  PROTO_CHARCODE = 23,
}

export const INSTR_MAX_OPCODE = InstrOp.PROTO_CHARCODE;

/** 元素标签候选（真实存在的标签，样式无关紧要） */
export const INSTR_TAGS = ["div", "span", "p", "section", "b", "i", "em", "u"] as const;

/** 程序写入/读取的属性名，客户端与服务端必须一致 */
export const INSTR_ATTR = "data-v";

// ---------- 种子扩展 ----------

/**
 * 用 SHA-256 计数器模式从种子扩展出任意多个 32 位字。
 *
 * 刻意不用有状态的 PRNG：计数器模式没有状态，跨语言（TS / Go / Worker）复刻时
 * 只需要「同一份 SHA-256 + 同一份大端计数器编码」，没有隐藏的初始化或溢出语义。
 */
class WordStream {
  private readonly seed: Buffer;
  private readonly buffer: Buffer;
  private counter = 0;
  private words: number[] = [];
  private index = 0;

  constructor(seed: Buffer) {
    this.seed = seed;
    this.buffer = Buffer.alloc(seed.length + 4);
    seed.copy(this.buffer, 0);
  }

  next(): number {
    if (this.index >= this.words.length) {
      this.buffer.writeUInt32BE(this.counter++, this.seed.length);
      const digest = crypto.createHash("sha256").update(this.buffer).digest();
      this.words = [];
      for (let i = 0; i < 8; i++) this.words.push(digest.readUInt32BE(i * 4));
      this.index = 0;
    }
    return this.words[this.index++];
  }

  /** [0, max) 区间内的整数 */
  below(max: number): number {
    return this.next() % max;
  }
}

/** 程序派生种子 */
function programSeed(challengeId: string, secret: string): Buffer {
  return crypto.createHash("sha256").update(`instr:prog:${secret}:${challengeId}`, "utf8").digest();
}

// ---------- 程序生成 ----------

export interface InstrumentationProgram {
  /** 扁平的操作码数组，每 3 个整数一个操作 */
  ops: number[];
}

/** 生成随机程序（确定性：同一 seed 必然生成同一程序） */
export function generateProgram(seed: Buffer): InstrumentationProgram {
  const rng = new WordStream(seed);
  // 预算必须按「操作数」而不是「循环次数」计算：一次 DOM 建树会推入
  // CREATE + APPEND + SET_ATTR 共 3 个操作。尾部另需 PROTO_JOIN + PROTO_CHARCODE
  // 以及最多 MAX_DOM_DEPTH 次收尾移除。
  const bodyBudget = INSTR_MAX_OPS - 2 - MAX_DOM_DEPTH;
  const bodyTarget = INSTR_MIN_OPS + rng.below(Math.max(1, bodyBudget - INSTR_MIN_OPS + 1));

  const ops: number[] = [];
  let depth = 0;

  const opCount = () => ops.length / INSTR_OP_STRIDE;
  const push = (op: InstrOp, a = 0, b = 0) => {
    ops.push(op, a, b);
  };
  const randomReg = () => rng.below(INSTR_REG_COUNT);

  while (opCount() < bodyTarget) {
    const pick = rng.below(100);

    if (pick < 78) {
      // 整数运算区
      const bucket = pick % 14;
      const dst = randomReg();
      const src = randomReg();
      switch (bucket) {
        case 0:
          push(InstrOp.CONST, dst, rng.next() | 0);
          break;
        case 1:
          push(InstrOp.MOV, dst, src);
          break;
        case 2:
          push(InstrOp.AND, dst, src);
          break;
        case 3:
          push(InstrOp.OR, dst, src);
          break;
        case 4:
          push(InstrOp.XOR, dst, src);
          break;
        case 5:
          push(InstrOp.NAND, dst, src);
          break;
        case 6:
          push(InstrOp.ADD, dst, src);
          break;
        case 7:
          push(InstrOp.SUB, dst, src);
          break;
        case 8:
          push(InstrOp.MUL, dst, src);
          break;
        case 9:
          push(InstrOp.ROTL, dst, 1 + rng.below(31));
          break;
        case 10:
          push(InstrOp.ROTR, dst, 1 + rng.below(31));
          break;
        case 11:
          push(InstrOp.SHL, dst, 1 + rng.below(31));
          break;
        case 12:
          push(InstrOp.SHR, dst, 1 + rng.below(31));
          break;
        default:
          push(InstrOp.NOT, dst);
          break;
      }
      continue;
    }

    // DOM 区
    const domPick = rng.below(10);
    const wantCreate = depth === 0 || (depth < MAX_DOM_DEPTH && domPick < 3);

    if (wantCreate) {
      // 建一层要 3 个操作；预算不够时用一个整数操作顶替，避免整体超限
      if (opCount() + 3 > bodyBudget) {
        push(InstrOp.NOT, randomReg());
        continue;
      }
      push(InstrOp.DOM_CREATE, rng.below(INSTR_TAGS.length));
      depth++;
      push(InstrOp.DOM_APPEND);
      push(InstrOp.DOM_SET_ATTR, randomReg(), rng.next() | 0);
      continue;
    }

    // 到达树深上限时强制回退，防止无界加深
    if (depth >= MAX_DOM_DEPTH && domPick < 3) {
      push(InstrOp.DOM_REMOVE);
      depth--;
      continue;
    }

    switch (domPick) {
      case 3:
      case 4:
        push(InstrOp.DOM_SET_TEXT, randomReg());
        break;
      case 5:
      case 6:
        push(InstrOp.DOM_READ_ATTR, randomReg());
        break;
      case 7:
        push(InstrOp.DOM_READ_TEXT, randomReg());
        break;
      case 8:
        if (depth > 1) push(InstrOp.DOM_WALK_UP, randomReg(), 1 + rng.below(depth));
        else push(InstrOp.DOM_SET_ATTR, randomReg(), rng.next() | 0);
        break;
      default:
        push(InstrOp.DOM_REMOVE);
        depth--;
        break;
    }
  }

  // 收尾：走一次原型链，并把整棵树拆掉
  // （客户端必须真的清理，否则宿主页面上会留下残留节点）
  push(InstrOp.PROTO_JOIN, randomReg());
  push(InstrOp.PROTO_CHARCODE, randomReg());
  for (let i = 0; i < depth; i++) push(InstrOp.DOM_REMOVE);

  return { ops };
}

// ---------- 影子 DOM 模型 + 解释器 ----------

interface ShadowNode {
  text: number;
  attrV: number;
  parent: ShadowNode | null;
}

/**
 * 操作码 → 参数是否为寄存器下标。
 *
 * 集中声明而不是散落在 case 里，避免漏校验：任何越界的寄存器下标都会让
 * `regs[a]` 变成 undefined 并污染后续运算（undefined | 0 === 0 会静默算错）。
 */
const REG_A_OPS = new Set<number>([
  InstrOp.CONST,
  InstrOp.MOV,
  InstrOp.AND,
  InstrOp.OR,
  InstrOp.XOR,
  InstrOp.NAND,
  InstrOp.ADD,
  InstrOp.SUB,
  InstrOp.MUL,
  InstrOp.ROTL,
  InstrOp.ROTR,
  InstrOp.SHL,
  InstrOp.SHR,
  InstrOp.NOT,
  InstrOp.DOM_SET_TEXT,
  InstrOp.DOM_SET_ATTR,
  InstrOp.DOM_READ_TEXT,
  InstrOp.DOM_READ_ATTR,
  InstrOp.DOM_WALK_UP,
  InstrOp.PROTO_JOIN,
  InstrOp.PROTO_CHARCODE,
]);

const REG_B_OPS = new Set<number>([
  InstrOp.MOV,
  InstrOp.AND,
  InstrOp.OR,
  InstrOp.XOR,
  InstrOp.NAND,
  InstrOp.ADD,
  InstrOp.SUB,
  InstrOp.MUL,
]);

function isReg(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < INSTR_REG_COUNT;
}

/**
 * 服务端解释程序并推算期望结果。
 *
 * 影子模型只保留程序自己写入的值（text / data-v），因此不需要真实 DOM；
 * 客户端必须用真实 DOM 走到同样的值。
 */
export function interpretProgram(program: InstrumentationProgram): { regs: number[]; ok: boolean } {
  const bad = { regs: [] as number[], ok: false };
  const ops = program?.ops;
  // 空程序视为非法：挑战必须真的包含程序，否则「全 0 寄存器」会变成一条廉价捷径
  if (!Array.isArray(ops) || ops.length === 0 || ops.length % INSTR_OP_STRIDE !== 0) return bad;
  if (ops.length > (INSTR_MAX_OPS + 8) * INSTR_OP_STRIDE) return bad;

  const regs = [0, 0, 0, 0];
  let top: ShadowNode | null = null;

  for (let i = 0; i < ops.length; i += INSTR_OP_STRIDE) {
    const op = ops[i];
    const a = ops[i + 1] | 0;
    const b = ops[i + 2] | 0;
    if (!Number.isInteger(op) || op < 0 || op > INSTR_MAX_OPCODE) return bad;
    if (REG_A_OPS.has(op) && !isReg(a)) return bad;
    if (REG_B_OPS.has(op) && !isReg(b)) return bad;

    switch (op) {
      case InstrOp.CONST:
        regs[a] = b | 0;
        break;
      case InstrOp.MOV:
        regs[a] = regs[b];
        break;
      case InstrOp.AND:
        regs[a] = regs[a] & regs[b];
        break;
      case InstrOp.OR:
        regs[a] = regs[a] | regs[b];
        break;
      case InstrOp.XOR:
        regs[a] = regs[a] ^ regs[b];
        break;
      case InstrOp.NAND:
        regs[a] = ~(regs[a] & regs[b]);
        break;
      case InstrOp.ADD:
        regs[a] = (regs[a] + regs[b]) | 0;
        break;
      case InstrOp.SUB:
        regs[a] = (regs[a] - regs[b]) | 0;
        break;
      case InstrOp.MUL:
        regs[a] = Math.imul(regs[a], regs[b]);
        break;
      case InstrOp.ROTL:
        regs[a] = ((regs[a] << (b & 31)) | (regs[a] >>> ((32 - b) & 31))) | 0;
        break;
      case InstrOp.ROTR:
        regs[a] = ((regs[a] >>> (b & 31)) | (regs[a] << ((32 - b) & 31))) | 0;
        break;
      case InstrOp.SHL:
        regs[a] = regs[a] << (b & 31);
        break;
      case InstrOp.SHR:
        regs[a] = regs[a] >> (b & 31);
        break;
      case InstrOp.NOT:
        regs[a] = ~regs[a];
        break;

      case InstrOp.DOM_CREATE: {
        if (a < 0 || a >= INSTR_TAGS.length) return bad;
        top = { text: 0, attrV: 0, parent: top };
        break;
      }
      case InstrOp.DOM_APPEND:
        // 真实 DOM 里需要把节点挂到父节点下；影子模型只需要维护 parent 关系
        break;
      case InstrOp.DOM_SET_TEXT:
        if (!top) return bad;
        top.text = regs[a];
        break;
      case InstrOp.DOM_SET_ATTR:
        if (!top) return bad;
        top.attrV = regs[a];
        break;
      case InstrOp.DOM_READ_TEXT:
        if (!top) return bad;
        regs[a] = top.text | 0;
        break;
      case InstrOp.DOM_READ_ATTR:
        if (!top) return bad;
        regs[a] = top.attrV | 0;
        break;
      case InstrOp.DOM_WALK_UP: {
        if (!top) return bad;
        let node: ShadowNode | null = top;
        let acc = 0;
        for (let k = 0; k <= b && node; k++) {
          acc = (acc + node.attrV) | 0;
          node = node.parent;
        }
        regs[a] = (regs[a] + acc) | 0;
        break;
      }
      case InstrOp.DOM_REMOVE:
        if (!top) return bad;
        top = top.parent;
        break;

      case InstrOp.PROTO_JOIN: {
        // 等价于 Array.prototype.join.call([r0,r1,r2,r3], "-").length
        const joined = `${regs[0]}-${regs[1]}-${regs[2]}-${regs[3]}`;
        regs[a] = joined.length | 0;
        break;
      }
      case InstrOp.PROTO_CHARCODE: {
        const text = String(regs[a]);
        regs[a] = text.length > 0 ? text.charCodeAt(0) : -1;
        break;
      }
      default:
        return { regs: [], ok: false };
    }
  }

  return { regs, ok: true };
}

// ---------- 环境向量与自动化检测 ----------

/**
 * 客户端采集、服务端判定的环境向量。
 * 字段名刻意取短名，减少传输体积；缺失用 -1 / 空数组表示。
 */
export interface EnvVector {
  /** navigator.webdriver：-1 表示 undefined，0 表示 false，1 表示 true */
  cd: number;
  /** userAgent（截断） */
  ua: string;
  /** userAgentData.brands 拼接（截断），不可用时为空串 */
  br: string;
  /** 引擎标记：1=Blink，2=Gecko，3=WebKit，0=未知 */
  ge: number;
  /** navigator.deviceMemory，不支持为 -1 */
  dm: number;
  /** 字体度量：若干字体栈下同一探测串的宽度 */
  tm: number[];
  /** 布局探针结果 */
  lw: number;
  lh: number;
  /** 视口与窗口 */
  iw: number;
  ih: number;
  ow: number;
  oh: number;
  /** 屏幕 */
  sw: number;
  sh: number;
  ex: number;
  /** 是否移动端 */
  mob: number;
  /** 原生方法被改写位掩码（canvas / webgl / permissions） */
  nt: number;
}

export type EnvBlockReason =
  | "webdriver_true"
  | "webdriver_stripped"
  | "headless_token"
  | "layout_zero"
  | "gecko_contradiction"
  | "window_exceeds_screen"
  | "geometry_quantized"
  | "viewport_override";

export type EnvRiskFlag = "native_tamper" | "few_font_metrics" | "ua_missing";

export interface EnvVerdict {
  /** 命中即判定为自动化浏览器（是否拒绝由调用方按设置决定） */
  blockedBy: EnvBlockReason[];
  /** 只记录、不拒绝的风险标记 */
  riskFlags: EnvRiskFlag[];
}

/** 屏幕与窗口尺寸的容差（像素）：考虑小数缩放与浏览器 UI 抖动 */
const WINDOW_SCREEN_TOLERANCE = 4;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 把外部传入的环境向量收敛成一个可判定的对象。
 * 任何字段缺失或类型不对都退化为「未知」，由对应规则自行决定如何处理，
 * 绝不让畸形输入把某条检查静默跳过而变成放行。
 */
export function normalizeEnvVector(raw: any): EnvVector {
  const num = (value: unknown, fallback = -1) => (isFiniteNumber(value) ? value : fallback);
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const metrics = Array.isArray(raw?.tm)
    ? raw.tm.filter((v: unknown) => isFiniteNumber(v)).slice(0, 64)
    : [];

  return {
    cd: num(raw?.cd),
    ua: str(raw?.ua).slice(0, 300),
    br: str(raw?.br).slice(0, 300),
    ge: num(raw?.ge, 0),
    dm: num(raw?.dm),
    tm: metrics,
    lw: num(raw?.lw, 0),
    lh: num(raw?.lh, 0),
    iw: num(raw?.iw, 0),
    ih: num(raw?.ih, 0),
    ow: num(raw?.ow, 0),
    oh: num(raw?.oh, 0),
    sw: num(raw?.sw, 0),
    sh: num(raw?.sh, 0),
    ex: num(raw?.ex, 0),
    mob: num(raw?.mob, 0),
    nt: num(raw?.nt, 0),
  };
}

/**
 * 判定环境向量。
 *
 * 拦截类规则全部指向「自动化层或篡改」，不针对浏览器构建本身：
 * 不使用 Widevine、H.264、userAgentData 品牌等构建身份信号，
 * 因为在同一份二进制上，真实的 ungoogled-chromium 用户与隐身驱动看起来一模一样。
 */
export function evaluateEnvVector(raw: any): EnvVerdict {
  const env = normalizeEnvVector(raw);
  const blockedBy: EnvBlockReason[] = [];
  const riskFlags: EnvRiskFlag[] = [];

  const isBlink = env.ge === 1;
  const isGecko = env.ge === 2;
  const isMobile = env.mob === 1;

  // 1. 规范定义的自动化标志。没有任何市售浏览器会把它设为 true。
  if (env.cd === 1) blockedBy.push("webdriver_true");

  // 2. 隐身脚本常在 Chromium 上直接删掉 navigator.webdriver。
  //    真实 Chrome 永远暴露 false，因此「Blink + undefined」是篡改信号。
  if (isBlink && env.cd === -1) blockedBy.push("webdriver_stripped");

  // 3. UA 或 brands 里出现 HeadlessChrome：消费级浏览器不会有这个 token。
  if (/headlesschrome/i.test(env.ua) || /headlesschrome/i.test(env.br)) blockedBy.push("headless_token");

  // 4. 布局探针必须给出正的几何尺寸：jsdom / happy-dom 之类返回 0。
  if (!(env.lw > 0) || !(env.lh > 0)) blockedBy.push("layout_zero");

  // 5. Gecko 从未实现过 deviceMemory 或 userAgentData，两者同时出现即伪装。
  if (isGecko && (env.dm >= 0 || env.br.length > 0)) blockedBy.push("gecko_contradiction");

  // 6. CDP 的 Emulation.setDeviceMetricsOverride 会把 screen 缩到视口大小，
  //    导致窗口高于屏幕。第二显示器（screen.isExtended）时跳过。
  if (env.ex !== 1 && (env.ow > env.sw + WINDOW_SCREEN_TOLERANCE || env.oh > env.sh + WINDOW_SCREEN_TOLERANCE)) {
    blockedBy.push("window_exceeds_screen");
  }

  // 7. 字体度量整数量化：Camoufox 之类会把字宽吸附到整像素。
  //    要求「至少 5 条为整数」且「至少 2 个不同的整数值」，
  //    这样只有单一字体的系统不会被误伤。
  const integerMetrics = env.tm.filter((v) => Number.isInteger(v));
  const distinctIntegers = new Set(integerMetrics);
  if (integerMetrics.length >= 5 && distinctIntegers.size >= 2) blockedBy.push("geometry_quantized");

  // 8. 视口与屏幕完全相等且浏览器 UI 存在：移动端全屏是正常的，因此跳过移动端。
  if (!isMobile && env.iw === env.sw && env.ih === env.sh && env.iw > 0 && env.ih > 0) {
    blockedBy.push("viewport_override");
  }

  // 风险标记（永不拒绝）
  if (env.nt !== 0) riskFlags.push("native_tamper");
  if (env.tm.length < 5) riskFlags.push("few_font_metrics");
  if (!env.ua) riskFlags.push("ua_missing");

  return { blockedBy, riskFlags };
}

// ---------- 质询与校验 ----------

export interface InstrumentationChallenge {
  /** 扁平操作码数组 */
  ops: number[];
  /** 布局探针要求的字体数量（客户端据此采集 tm） */
  fonts: number;
}

/** 派生质询（签发与校验共用） */
export function createInstrumentationChallenge(challengeId: string, secret: string): InstrumentationChallenge {
  const program = generateProgram(programSeed(challengeId, secret));
  return { ops: program.ops, fonts: FONT_STACKS.length };
}

/**
 * 布局探针使用的字体栈。
 *
 * 必须与前端 `instrumentation.ts` 中的列表逐项一致：字宽是量化检测的输入，
 * 列表不同会让该检测失去意义。
 */
export const FONT_STACKS = [
  "monospace",
  "sans-serif",
  "serif",
  "cursive",
  "fantasy",
  "system-ui",
  '"Arial"',
  '"Helvetica"',
  '"Times New Roman"',
  '"Courier New"',
  '"Georgia"',
  '"Verdana"',
  '"Tahoma"',
  '"Trebuchet MS"',
  '"Segoe UI"',
  '"PingFang SC"',
  '"Microsoft YaHei"',
] as const;

/** 布局探针探测串 */
export const PROBE_TEXT = "MomoVerify1234";

export interface InstrumentationAnswer {
  regs: unknown;
  env: unknown;
  /** 布局探针宽高 */
  lw: unknown;
  lh: unknown;
  /** 字体度量数组 */
  tm: unknown;
}

export interface InstrumentationCheck {
  ok: boolean;
  reason: string;
  blockedBy: EnvBlockReason[];
  riskFlags: EnvRiskFlag[];
}

/**
 * 校验 Instrumentation 答案。
 *
 * @param blockAutomated 为 true 时，命中自动化规则即拒绝；为 false 时只记录风险。
 */
export function verifyInstrumentation(
  challengeId: string,
  secret: string,
  answer: InstrumentationAnswer,
  blockAutomated: boolean
): InstrumentationCheck {
  const challenge = createInstrumentationChallenge(challengeId, secret);

  // 1. 寄存器必须与「重新派生 + 独立推算」的结果逐位一致
  const expected = interpretProgram({ ops: challenge.ops });
  if (!expected.ok) {
    return { ok: false, reason: "program derivation failed", blockedBy: [], riskFlags: [] };
  }

  const regs = answer?.regs;
  if (!Array.isArray(regs) || regs.length !== INSTR_REG_COUNT) {
    return { ok: false, reason: "malformed registers", blockedBy: [], riskFlags: [] };
  }
  for (let i = 0; i < INSTR_REG_COUNT; i++) {
    if (!isFiniteNumber(regs[i]) || !Number.isInteger(regs[i])) {
      return { ok: false, reason: "malformed registers", blockedBy: [], riskFlags: [] };
    }
    if ((regs[i] | 0) !== expected.regs[i]) {
      return { ok: false, reason: "program result mismatch", blockedBy: [], riskFlags: [] };
    }
  }

  // 2. 布局探针：客户端单独回传，服务端只做范围判定（不做精确比对，避免字体/DPR 差异误伤）
  const lw = isFiniteNumber(answer?.lw) ? answer.lw : 0;
  const lh = isFiniteNumber(answer?.lh) ? answer.lh : 0;

  // 3. 环境向量判定
  const verdict = evaluateEnvVector(answer?.env);

  // 把布局探针并入判定结果：与规则 4 共用同一套语义
  const blockedBy = [...verdict.blockedBy];
  if (!(lw > 0) || !(lh > 0)) {
    if (!blockedBy.includes("layout_zero")) blockedBy.push("layout_zero");
  }

  if (blockAutomated && blockedBy.length > 0) {
    return {
      ok: false,
      reason: `automated browser detected: ${blockedBy.join(",")}`,
      blockedBy,
      riskFlags: verdict.riskFlags,
    };
  }

  return { ok: true, reason: "", blockedBy, riskFlags: verdict.riskFlags };
}
