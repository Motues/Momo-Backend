/**
 * 无感验证的纯算法层（Cloudflare Worker / WebCrypto）
 *
 * 抽成独立模块的原因：
 * 1. worker/src/utils/verify.ts 依赖 Bindings 与 Settings 表，无法单独验证
 * 2. 这里的函数是三端（Node.js / Go / Worker）共享的口径定义，必须逐字节一致，
 *    因此需要能被跨语言一致性测试直接调用
 *
 * 口径约定（与 Node.js / Go 完全一致）：
 * - base64url 一律无填充
 * - IP 哈希：hex(SHA256("ip:" + secret + ":" + ip)) 取前 16 位
 * - 蜜罐字段名："v_" + hex(SHA256("hp:" + secret + ":" + slug)) 取前 10 位
 * - 签名：base64url(HMAC-SHA256(data, secret))
 * - 解题：SHA256(`${prefix}:${nonce}`) 的前导 0 比特数 >= difficulty
 */

const encoder = new TextEncoder();

/** 字节数组转 base64url（无填充） */
export function base64urlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** UTF-8 字符串转 base64url */
export function toBase64url(text: string): string {
  return base64urlBytes(encoder.encode(text));
}

/** base64url 转字节数组，容忍带填充输入 */
export function fromBase64url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 字节数组转小写十六进制 */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/** SHA-256 摘要 */
export async function sha256Bytes(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return new Uint8Array(digest);
}

/** SHA-256 十六进制摘要 */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await sha256Bytes(text));
}

/** base64url(HMAC-SHA256(data, secret)) */
export async function hmacSHA256(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64urlBytes(new Uint8Array(sig));
}

/** 常数时间字符串比较 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** IP 加盐哈希，避免明文留存 IP */
export async function hashVerifyIp(ip: string, secret: string): Promise<string> {
  return (await sha256Hex(`ip:${secret}:${ip}`)).slice(0, 16);
}

/** 按文章派生的蜜罐字段名 */
export async function honeypotFieldName(postSlug: string, secret: string): Promise<string> {
  return `v_${(await sha256Hex(`hp:${secret}:${postSlug}`)).slice(0, 10)}`;
}

/** 统计前导 0 比特数 */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** 计算某 nonce 的解题成果（前导 0 比特数） */
export async function workFor(prefix: string, nonce: number): Promise<number> {
  return leadingZeroBits(await sha256Bytes(`${prefix}:${nonce}`));
}
