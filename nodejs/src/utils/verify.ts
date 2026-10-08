import crypto from "crypto";
import { getSetting, setSetting } from "./settings";
import LogService from "./log";

/**
 * 评论区「无感验证」（Turnstile 风格）
 *
 * 设计要点：
 * - 零数据库结构改动：只复用 Settings 表存放自动生成的签名密钥
 * - 无状态票据：票据自带 IP 绑定 + 有效期，靠 HMAC 签名保证不可伪造
 * - 工作量证明：浏览器静默计算，真人无感知；批量机器人成本显著上升
 */

// 设置项 key
const SETTING_ENABLED = "comment_verify_enabled";
const SETTING_DIFFICULTY = "comment_verify_difficulty";
const SETTING_SECRET = "comment_verify_secret";

// 默认值
const DEFAULT_DIFFICULTY = 18; // 前导 0 比特数，约 2^18 次哈希
const MIN_DIFFICULTY = 8;
const MAX_DIFFICULTY = 26;

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 挑战有效期 10 分钟
const TICKET_TTL_MS = 5 * 60 * 1000; // 票据有效期 5 分钟
const MIN_SOLVE_MS = 300; // 低于此时长视为脚本，直接拒绝
const MAX_SOLVE_MS = 10 * 60 * 1000; // 超过挑战有效期即无效

// 已使用的 nonce（防止同一挑战被重复兑换），惰性清理
const usedNonces = new Map<string, number>();

let cachedSecret: string | null = null;

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function hmac(data: string, secret: string): string {
  return base64url(crypto.createHmac("sha256", secret).update(data, "utf8").digest());
}

/** 常数时间比较，避免签名被逐字节爆破 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 获取签名密钥，首次使用时自动生成并持久化到 Settings 表。
 * 这样无需任何环境变量配置，重启后票据依旧可校验。
 */
async function getSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;

  const existing = await getSetting(SETTING_SECRET);
  if (existing && existing.length > 0) {
    cachedSecret = existing;
    return existing;
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    await setSetting(SETTING_SECRET, generated);
  } catch (e) {
    LogService.error("无法持久化验证密钥，本次将使用临时密钥:", e);
  }
  cachedSecret = generated;
  return generated;
}

/**
 * IP 加盐哈希，用于把挑战/票据绑定到来源 IP，避免明文留存 IP。
 * 使用 SHA256("ip:" + secret + ":" + ip)，三套后端算法完全一致。
 */
export function hashIp(ip: string, secret: string): string {
  return crypto.createHash("sha256").update(`ip:${secret}:${ip}`, "utf8").digest("hex").slice(0, 16);
}

/** 按文章派生的蜜罐字段名，避免全站固定字段被脚本识别 */
export function honeypotField(postSlug: string, secret: string): string {
  return `v_${crypto.createHash("sha256").update(`hp:${secret}:${postSlug}`, "utf8").digest("hex").slice(0, 10)}`;
}

/** 是否开启人机验证 */
export async function isVerifyEnabled(): Promise<boolean> {
  return (await getSetting(SETTING_ENABLED)) === "true";
}

/** 读取难度（前导 0 比特数），做上下限保护 */
export async function getDifficulty(): Promise<number> {
  const raw = await getSetting(SETTING_DIFFICULTY);
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DIFFICULTY;
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, parsed));
}

/** 供评论列表接口下发给前端的信息 */
export async function getPublicVerifyConfig(postSlug: string): Promise<{
  verify_enabled: string;
  verify_honeypot: string;
}> {
  // 关闭时直接返回，不做任何密钥生成/写库，保证「默认关闭」零副作用
  if (!(await isVerifyEnabled())) {
    return { verify_enabled: "false", verify_honeypot: "" };
  }
  const secret = await getSecret();
  return {
    verify_enabled: "true",
    verify_honeypot: honeypotField(postSlug, secret),
  };
}

interface ChallengePayload {
  cid: string;
  iph: string;
  iat: number;
}

export interface ChallengeResult {
  challenge_id: string;
  prefix: string;
  difficulty: number;
  expires_in: number;
  sig: string;
}

/** 签发挑战 */
export async function createChallenge(ip: string): Promise<ChallengeResult> {
  const secret = await getSecret();
  const difficulty = await getDifficulty();
  const now = Date.now();

  const payload: ChallengePayload = {
    cid: base64url(crypto.randomBytes(16)),
    iph: hashIp(ip, secret),
    iat: now,
  };

  const prefix = base64url(JSON.stringify(payload));
  return {
    challenge_id: payload.cid,
    prefix,
    difficulty,
    expires_in: Math.floor(CHALLENGE_TTL_MS / 1000),
    sig: hmac(prefix, secret),
  };
}

/** 统计字节数组的前导 0 比特数 */
function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

function pruneNonces(now: number): void {
  const cutoff = now - CHALLENGE_TTL_MS;
  usedNonces.forEach((ts, key) => {
    if (ts < cutoff) usedNonces.delete(key);
  });
}

export type SolutionCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** 校验挑战答案（PoW + 签名 + 时效 + IP 绑定 + 重放） */
export async function verifySolution(params: {
  prefix: string;
  sig: string;
  nonce: number;
  elapsedMs: number;
  ip: string;
}): Promise<SolutionCheck> {
  const { prefix, sig, nonce, elapsedMs, ip } = params;
  const secret = await getSecret();
  const now = Date.now();

  if (!prefix || !sig) return { ok: false, reason: "missing challenge" };

  // 1. 签名校验（先验签，避免解析不可信数据）
  const expected = hmac(prefix, secret);
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: "bad signature" };

  // 2. 解析载荷
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(fromBase64url(prefix).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed prefix" };
  }
  if (!payload || typeof payload.cid !== "string" || typeof payload.iat !== "number" || typeof payload.iph !== "string") {
    return { ok: false, reason: "malformed payload" };
  }

  // 3. 时效
  const age = now - payload.iat;
  if (age > CHALLENGE_TTL_MS) return { ok: false, reason: "challenge expired" };
  if (age < -60 * 1000) return { ok: false, reason: "challenge from the future" };

  // 4. IP 绑定
  if (!timingSafeEqual(hashIp(ip, secret), payload.iph)) {
    return { ok: false, reason: "ip mismatch" };
  }

  // 5. 时序检测（脚本通常瞬间返回）
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_SOLVE_MS || elapsedMs > MAX_SOLVE_MS) {
    return { ok: false, reason: "implausible timing" };
  }

  // 6. 难度校验
  const difficulty = await getDifficulty();
  if (!Number.isInteger(nonce) || nonce < 0) return { ok: false, reason: "bad nonce" };
  const digest = crypto.createHash("sha256").update(`${prefix}:${nonce}`, "utf8").digest();
  if (leadingZeroBits(digest) < difficulty) {
    return { ok: false, reason: "insufficient work" };
  }

  // 7. 防重放：同一挑战的同一 nonce 只能兑换一次
  pruneNonces(now);
  const replayKey = `${payload.cid}:${nonce}`;
  if (usedNonces.has(replayKey)) return { ok: false, reason: "replayed nonce" };
  usedNonces.set(replayKey, now);

  return { ok: true };
}

interface TicketPayload {
  v: number;
  iph: string;
  slug: string;
  iat: number;
  exp: number;
  jti: string;
}

/** 签发通过验证的票据 */
export async function createTicket(ip: string, postSlug: string): Promise<string> {
  const secret = await getSecret();
  const now = Date.now();
  const payload: TicketPayload = {
    v: 1,
    iph: hashIp(ip, secret),
    slug: postSlug,
    iat: now,
    exp: now + TICKET_TTL_MS,
    jti: base64url(crypto.randomBytes(8)),
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmac(body, secret)}`;
}

export const TICKET_TTL_SECONDS = Math.floor(TICKET_TTL_MS / 1000);

/** 校验票据（供提交评论时调用） */
export async function verifyTicket(ticket: string | undefined, ip: string, postSlug: string): Promise<boolean> {
  if (!ticket || typeof ticket !== "string") return false;

  const secret = await getSecret();
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return false;

  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!timingSafeEqual(hmac(body, secret), sig)) return false;

  let payload: TicketPayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return false;
  }
  if (!payload || payload.v !== 1) return false;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return false;
  if (payload.slug !== postSlug) return false;
  if (!timingSafeEqual(hashIp(ip, secret), String(payload.iph))) return false;

  return true;
}
