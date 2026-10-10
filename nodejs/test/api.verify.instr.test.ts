import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/orm/client";
import { setSetting } from "../src/utils/settings";
import { hashwxHash, hashwxTarget, hashwxBlockSeed, type HashwxSpec } from "../src/utils/hashwx";
import { interpretProgram, FONT_STACKS, type EnvVector } from "../src/utils/instrumentation";
import { api, json, useTrustProxy, resetTables, clearSettings, loginToken } from "./helpers";

/**
 * 第二层 Instrumentation 质询的端到端用例。
 *
 * 与 api.verify.test.ts 的分工：那边覆盖第一层（HashWX / 票据 / 协议版本），
 * 这边只覆盖第二层的开关行为、程序校验、环境判定与「挑战必须被烧掉」的时序。
 */

let ipSequence = 0;
function uniqueIp(): string {
  ipSequence += 1;
  return `198.30.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

/** 固定签名密钥（同 api.verify.test.ts：必须在任何验证调用之前写入且全程保留） */
const VECTOR_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801";

const RESET_KEYS = [
  "comment_verify_enabled",
  "comment_verify_difficulty",
  "comment_verify_instr_enabled",
  "comment_verify_block_automated",
  "comment_auto_approve",
];

/** 本地求解 HashWX（与服务端同口径）；难度取很小值保证用例毫秒级完成 */
function solveHashwx(spec: HashwxSpec): string[] {
  const challenge = Buffer.from(spec.c, "hex");
  const target = hashwxTarget(spec.d);
  const n = BigInt(spec.n);
  const nonces: string[] = [];

  for (let i = 0; i < spec.count; i++) {
    let nonce = 0n;
    for (; nonce < 5_000_000n; nonce++) {
      if (hashwxHash(hashwxBlockSeed(challenge, i, nonce / n), nonce) <= target) break;
    }
    if (nonce >= 5_000_000n) throw new Error(`子挑战 ${i} 求解超限`);
    nonces.push(nonce.toString());
  }

  return nonces;
}

/** 一份能通过全部自动化检测的基线环境向量 */
function okEnv(overrides: Partial<EnvVector> = {}): EnvVector {
  const tm = Array.from({ length: FONT_STACKS.length }, (_, i) => 10.5 + i * 0.25);
  return {
    cd: 0,
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    br: "",
    ge: 1,
    dm: 8,
    tm,
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
    ...overrides,
  };
}

interface ChallengeData {
  enabled: boolean;
  version: number;
  prefix: string;
  sig: string;
  challenge_id: string;
  pow: HashwxSpec;
  instr?: { ops: number[]; fonts: number };
}

async function takeChallenge(ip: string): Promise<ChallengeData> {
  const res = await api("/api/verify/challenge", { method: "POST", ip, body: { post_slug: "/posts/x" } });
  return (await json(res)).data as ChallengeData;
}

/** 用服务端下发的程序算出期望寄存器，构造一份正确答案 */
function correctInstr(challenge: ChallengeData, envOverrides: Record<string, unknown> = {}, probes = { lw: 120.5, lh: 32.25 }) {
  const expected = interpretProgram({ ops: challenge.instr!.ops });
  return {
    regs: [...expected.regs],
    env: okEnv(envOverrides),
    lw: probes.lw,
    lh: probes.lh,
    tm: okEnv(envOverrides).tm,
  };
}

describe("第二层 Instrumentation —— 开关行为", () => {
  beforeAll(async () => {
    await setSetting("comment_verify_secret", VECTOR_SECRET);
  });

  beforeEach(async () => {
    resetTables();
    clearSettings(RESET_KEYS);
    useTrustProxy();
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "1000");
  });

  afterEach(() => {
    clearSettings(RESET_KEYS);
  });

  it("默认关闭：挑战不下发 instr 程序", async () => {
    const challenge = await takeChallenge(uniqueIp());
    expect(challenge.pow).toBeTruthy();
    expect(challenge.instr).toBeUndefined();
  });

  it("开启后：挑战下发程序与字体条数", async () => {
    await setSetting("comment_verify_instr_enabled", "true");
    const challenge = await takeChallenge(uniqueIp());
    expect(challenge.instr).toBeTruthy();
    expect(Array.isArray(challenge.instr!.ops)).toBe(true);
    expect(challenge.instr!.ops.length).toBeGreaterThan(0);
    expect(challenge.instr!.ops.length % 3).toBe(0);
    expect(challenge.instr!.fonts).toBe(FONT_STACKS.length);
  });

  it("关闭时提交不带 instr 也能拿到票据", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/x",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonces: solveHashwx(challenge.pow),
        elapsed_ms: 1000,
      },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).data.ticket).toBeTruthy();
  });
});

describe("第二层 Instrumentation —— 程序与环境校验", () => {
  beforeAll(async () => {
    await setSetting("comment_verify_secret", VECTOR_SECRET);
  });

  beforeEach(async () => {
    resetTables();
    clearSettings(RESET_KEYS);
    useTrustProxy();
    await setSetting("comment_verify_enabled", "true");
    await setSetting("comment_verify_difficulty", "1000");
    await setSetting("comment_verify_instr_enabled", "true");
  });

  afterEach(() => {
    clearSettings(RESET_KEYS);
  });

  async function submit(ip: string, challenge: ChallengeData, instr: unknown) {
    return api("/api/verify/solution", {
      method: "POST",
      ip,
      body: {
        post_slug: "/posts/x",
        prefix: challenge.prefix,
        sig: challenge.sig,
        nonces: solveHashwx(challenge.pow),
        elapsed_ms: 1000,
        instr,
      },
    });
  }

  it("正确答案拿到票据", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, correctInstr(challenge));
    expect(res.status).toBe(200);
    expect((await json(res)).data.ticket).toBeTruthy();
  });

  it("缺少 instr 时拒绝，且原因指向寄存器畸形", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, undefined);
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("malformed registers");
  });

  it("寄存器篡改一位即拒绝", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const instr = correctInstr(challenge);
    instr.regs[0] = (instr.regs[0] + 1) | 0;
    const res = await submit(ip, challenge, instr);
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("program result mismatch");
  });

  it("寄存器个数不对即拒绝", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const instr = correctInstr(challenge);
    const res = await submit(ip, challenge, { ...instr, regs: [1, 2, 3] });
    expect((await json(res)).reason).toBe("malformed registers");
  });

  it("布局探针为 0 时，blockAutomated 关闭仍放行（只记录）", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, correctInstr(challenge, {}, { lw: 0, lh: 0 }));
    expect(res.status).toBe(200);
  });

  it("blockAutomated 开启后，布局探针为 0 被拒绝", async () => {
    await setSetting("comment_verify_block_automated", "true");
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, correctInstr(challenge, {}, { lw: 0, lh: 0 }));
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toContain("layout_zero");
  });

  it("webdriver=true：默认只记录不拦截", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, correctInstr(challenge, { cd: 1 }));
    expect(res.status).toBe(200);
  });

  it("webdriver=true + blockAutomated：拒绝并给出规则名", async () => {
    await setSetting("comment_verify_block_automated", "true");
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, correctInstr(challenge, { cd: 1 }));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.reason).toContain("webdriver_true");
  });

  it("HeadlessChrome + blockAutomated：拒绝", async () => {
    await setSetting("comment_verify_block_automated", "true");
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, correctInstr(challenge, { ua: "Mozilla/5.0 HeadlessChrome/130" }));
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toContain("headless_token");
  });

  it("风险标记（原生方法被改写）即使 blockAutomated 开启也不拒绝", async () => {
    await setSetting("comment_verify_block_automated", "true");
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const res = await submit(ip, challenge, correctInstr(challenge, { nt: 7 }));
    expect(res.status).toBe(200);
  });

  it("第二层失败会烧掉挑战：同一挑战再次提交报 already used", async () => {
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);
    const bad = correctInstr(challenge);
    bad.regs[0] = (bad.regs[0] + 1) | 0;

    const first = await submit(ip, challenge, bad);
    expect(first.status).toBe(403);
    expect((await json(first)).reason).toBe("program result mismatch");

    // 第二次即便给出「正确」答案也不能再用同一个挑战
    const second = await submit(ip, challenge, correctInstr(challenge));
    expect(second.status).toBe(403);
    expect((await json(second)).reason).toBe("challenge already used");
  });

  it("同一挑战不能靠反复换环境向量刷过自动化检测", async () => {
    await setSetting("comment_verify_block_automated", "true");
    const ip = uniqueIp();
    const challenge = await takeChallenge(ip);

    // 先用带自动化特征的向量试一次
    const first = await submit(ip, challenge, correctInstr(challenge, { cd: 1 }));
    expect(first.status).toBe(403);

    // 再换一个干净向量重试同一挑战：应当因为挑战已烧掉而失败
    const second = await submit(ip, challenge, correctInstr(challenge));
    expect(second.status).toBe(403);
    expect((await json(second)).reason).toBe("challenge already used");
  });
});

describe("第二层 Instrumentation —— 设置项白名单", () => {
  const ADMIN_IP = "203.0.113.99";

  beforeEach(async () => {
    resetTables();
    clearSettings(RESET_KEYS);
    useTrustProxy();
  });

  afterEach(() => {
    clearSettings(RESET_KEYS);
  });

  it("安全分组下可以读写两个新开关", async () => {
    const token = await loginToken("momo", "momo", ADMIN_IP);

    // 读接口只回显「库里已存在的行」，所以先写再读
    const write = await api("/admin/settings", {
      method: "PUT",
      token,
      ip: ADMIN_IP,
      body: { comment_verify_instr_enabled: "true", comment_verify_block_automated: "true" },
    });
    expect((await json(write)).code).toBe(200);

    const row = (key: string) =>
      (db.get(sql`SELECT "value" FROM "Settings" WHERE "key" = ${key}`) as { value: string } | undefined)?.value;
    expect(row("comment_verify_instr_enabled")).toBe("true");
    expect(row("comment_verify_block_automated")).toBe("true");

    const read = await api("/admin/settings?type=security", { token, ip: ADMIN_IP });
    const after = await json(read);
    expect(after.code).toBe(200);
    expect(after.data).toMatchObject({
      comment_verify_instr_enabled: "true",
      comment_verify_block_automated: "true",
    });
  });
});
