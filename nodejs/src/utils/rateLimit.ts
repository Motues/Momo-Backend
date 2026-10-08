/**
 * 极简滑动窗口限流（进程内内存实现）。
 *
 * 用途：缓解公开接口被批量爬取（例如遍历 post_slug 收割 admin_email_hash）。
 * 注意：IP 归属依赖 getClientIP()，若部署在代理之后却未开启 TRUST_PROXY，
 * 所有请求会共享代理 IP，请务必按 README 正确配置 TRUST_PROXY。
 */

interface WindowHits {
  hits: number[];
}

const buckets = new Map<string, WindowHits>();
let lastSweep = Date.now();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// 单进程最多跟踪的 bucket 数量，避免被大量伪造 IP 撑爆内存
const MAX_BUCKETS = 10000;

function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  buckets.forEach((bucket, key) => {
    bucket.hits = bucket.hits.filter((ts) => now - ts < windowMs);
    if (bucket.hits.length === 0) buckets.delete(key);
  });
}

/**
 * 是否允许本次请求。
 * @param key      限流维度（建议 `ip`）
 * @param limit    窗口内允许的请求数
 * @param windowMs 窗口长度（毫秒）
 */
export function allowRequest(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now, windowMs);

  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      // 内存保护：直接放行新 IP，避免限流表无限增长
      return true;
    }
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }

  bucket.hits = bucket.hits.filter((ts) => now - ts < windowMs);
  if (bucket.hits.length >= limit) return false;

  bucket.hits.push(now);
  return true;
}
