import { Bindings } from '../bindings';
import { getSetting, setSetting } from './settings';
import {
  base64urlBytes,
  fromBase64url,
  hashVerifyIp,
  hmacSHA256,
  honeypotFieldName,
  leadingZeroBits,
  sha256Bytes,
  timingSafeEqual,
  toBase64url,
  toHex,
  workFor,
} from './verifyCrypto';

/**
 * 评论区「无感验证」（Turnstile 风格）— Cloudflare Worker 实现
 *
 * 与 Node.js / Go 版本保持接口与算法完全一致：
 * - 零数据库结构改动（复用 Settings 表存放自动生成的签名密钥）
 * - 无状态票据：HMAC 签名 + IP 绑定 + 有效期
 * - 工作量证明：浏览器静默计算
 *
 * 纯算法部分见 ./verifyCrypto.ts（与 worker 运行时解耦，便于跨语言一致性测试）。
 */

const SETTING_ENABLED = "comment_verify_enabled";
const SETTING_DIFFICULTY = "comment_verify_difficulty";
const SETTING_SECRET = "comment_verify_secret";

const DEFAULT_DIFFICULTY = 18;
const MIN_DIFFICULTY = 8;
const MAX_DIFFICULTY = 26;

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const TICKET_TTL_MS = 5 * 60 * 1000;
const MIN_SOLVE_MS = 300;
const MAX_SOLVE_MS = 10 * 60 * 1000;

/** 已使用的 nonce，防止同一挑战被重复兑换 */
const usedNonces = new Map<string, number>();

let cachedSecret: string | null = null;

/** 获取签名密钥，首次使用时自动生成并持久化 */
async function getSecret(env: Bindings): Promise<string> {
  if (cachedSecret) return cachedSecret;

  const existing = await getSetting(env, SETTING_SECRET);
  if (existing && existing.length > 0) {
    cachedSecret = existing;
    return existing;
  }

  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const generated = toHex(random);
  try {
    await setSetting(env, SETTING_SECRET, generated);
  } catch (e) {
    console.error("无法持久化验证密钥，本次将使用临时密钥:", e);
  }
  cachedSecret = generated;
  return generated;
}

export async function isVerifyEnabled(env: Bindings): Promise<boolean> {
  return (await getSetting(env, SETTING_ENABLED)) === "true";
}

export async function getDifficulty(env: Bindings): Promise<number> {
  const raw = await getSetting(env, SETTING_DIFFICULTY);
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DIFFICULTY;
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, parsed));
}

/** 供评论列表接口下发给前端的信息 */
export async function getPublicVerifyConfig(
  env: Bindings,
  postSlug: string
): Promise<{ verify_enabled: string; verify_honeypot: string }> {
  // 关闭时直接返回，不做任何密钥生成/写库，保证「默认关闭」零副作用
  if (!(await isVerifyEnabled(env))) {
    return { verify_enabled: "false", verify_honeypot: "" };
  }
  const secret = await getSecret(env);
  return {
    verify_enabled: "true",
    verify_honeypot: await honeypotFieldName(postSlug, secret),
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

export async function createChallenge(env: Bindings, ip: string): Promise<ChallengeResult> {
  const secret = await getSecret(env);
  const difficulty = await getDifficulty(env);

  const random = new Uint8Array(16);
  crypto.getRandomValues(random);

  const payload: ChallengePayload = {
    cid: base64urlBytes(random),
    iph: await hashVerifyIp(ip, secret),
    iat: Date.now(),
  };

  const prefix = toBase64url(JSON.stringify(payload));
  return {
    challenge_id: payload.cid,
    prefix,
    difficulty,
    expires_in: Math.floor(CHALLENGE_TTL_MS / 1000),
    sig: await hmacSHA256(prefix, secret),
  };
}

function pruneNonces(now: number): void {
  const cutoff = now - CHALLENGE_TTL_MS;
  for (const [key, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(key);
  }
}

export type SolutionCheck = { ok: true } | { ok: false; reason: string };

export async function verifySolution(
  env: Bindings,
  params: { prefix: string; sig: string; nonce: number; elapsedMs: number; ip: string }
): Promise<SolutionCheck> {
  const { prefix, sig, nonce, elapsedMs, ip } = params;
  const secret = await getSecret(env);
  const now = Date.now();

  if (!prefix || !sig) return { ok: false, reason: "missing challenge" };

  const expected = await hmacSHA256(prefix, secret);
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: "bad signature" };

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(prefix)));
  } catch {
    return { ok: false, reason: "malformed prefix" };
  }
  if (
    !payload ||
    typeof payload.cid !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.iph !== "string"
  ) {
    return { ok: false, reason: "malformed payload" };
  }

  const age = now - payload.iat;
  if (age > CHALLENGE_TTL_MS) return { ok: false, reason: "challenge expired" };
  if (age < -60 * 1000) return { ok: false, reason: "challenge from the future" };

  if (!timingSafeEqual(await hashVerifyIp(ip, secret), payload.iph)) {
    return { ok: false, reason: "ip mismatch" };
  }

  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_SOLVE_MS || elapsedMs > MAX_SOLVE_MS) {
    return { ok: false, reason: "implausible timing" };
  }

  const difficulty = await getDifficulty(env);
  if (!Number.isInteger(nonce) || nonce < 0) return { ok: false, reason: "bad nonce" };

  if ((await workFor(prefix, nonce)) < difficulty) {
    return { ok: false, reason: "insufficient work" };
  }

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

export async function createTicket(env: Bindings, ip: string, postSlug: string): Promise<string> {
  const secret = await getSecret(env);
  const now = Date.now();

  const random = new Uint8Array(8);
  crypto.getRandomValues(random);

  const payload: TicketPayload = {
    v: 1,
    iph: await hashVerifyIp(ip, secret),
    slug: postSlug,
    iat: now,
    exp: now + TICKET_TTL_MS,
    jti: base64urlBytes(random),
  };

  const body = toBase64url(JSON.stringify(payload));
  return `${body}.${await hmacSHA256(body, secret)}`;
}

export const TICKET_TTL_SECONDS = Math.floor(TICKET_TTL_MS / 1000);

export async function verifyTicket(
  env: Bindings,
  ticket: string | undefined,
  ip: string,
  postSlug: string
): Promise<boolean> {
  if (!ticket || typeof ticket !== "string") return false;

  const secret = await getSecret(env);
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return false;

  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!timingSafeEqual(await hmacSHA256(body, secret), sig)) return false;

  let payload: TicketPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return false;
  }
  if (!payload || payload.v !== 1) return false;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return false;
  if (payload.slug !== postSlug) return false;
  if (!timingSafeEqual(await hashVerifyIp(ip, secret), String(payload.iph))) return false;

  return true;
}
