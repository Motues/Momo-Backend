import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { initializeDatabase } from "./migrations";
import path from "path";
import fs from "fs";

// 解析数据库路径
const DATABASE_URL = process.env.DATABASE_URL || "file:./data/dev.db";
let dbPath = DATABASE_URL.replace(/^file:/, "");

// 如果是相对路径，相对于项目根目录解析
if (!path.isAbsolute(dbPath)) {
  dbPath = path.resolve(process.cwd(), dbPath);
}

// 确保 data 目录存在
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(dbPath);

// 启用 WAL 模式提升并发性能
sqlite.pragma("journal_mode = WAL");

// 确保表结构存在（对新部署友好）并执行幂等自迁移（见 orm/migrations.ts）
initializeDatabase(sqlite);

export const db = drizzle(sqlite, { schema });
export { schema };
