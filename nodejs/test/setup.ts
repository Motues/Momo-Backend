import fs from "node:fs";
import path from "node:path";

/**
 * 每个测试文件开始前重建测试数据库，保证用例之间互不残留状态。
 *
 * 安全护栏：只允许操作路径中包含 `.vitest` 的数据库文件，
 * 避免 DATABASE_URL 配置失误时误删本地开发库 `data/dev.db`。
 */
const url = process.env.DATABASE_URL ?? "";

if (!url.includes(".vitest")) {
  throw new Error(
    `拒绝在非测试数据库上运行测试：DATABASE_URL=${JSON.stringify(url)}`
  );
}

const dbPath = path.resolve(process.cwd(), url.replace(/^file:/, ""));

for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(dbPath + suffix, { force: true });
}
