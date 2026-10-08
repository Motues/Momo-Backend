/**
 * 极简滑动窗口限流（单个 isolate 内存实现）。
 *
 * 注意：Workers 是无状态、多 isolate 运行的，本限流只能覆盖单个 isolate 的请求，
 * 属于「尽力而为」的缓解手段，不是全局精确限流。
 * 若需要全局精确限流，应改用 Durable Objects 或 Cloudflare Rate Limiting 规则。
 */

interface WindowHits {
  hits: number[];
}

const buckets = new Map<string, WindowHits>();
let lastSweep = Date.now();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BUCKETS = 2000;

function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  buckets.forEach((bucket, key) => {
    bucket.hits = bucket.hits.filter((ts) => now - ts < windowMs);
    if (bucket.hits.length === 0) buckets.delete(key);
  });
}

export function allowRequest(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now, windowMs);

  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) return true;
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }

  bucket.hits = bucket.hits.filter((ts) => now - ts < windowMs);
  if (bucket.hits.length >= limit) return false;

  bucket.hits.push(now);
  return true;
}
