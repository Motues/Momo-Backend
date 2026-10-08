import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Comment 表 — 与 Prisma 生成的表结构保持一致
 * 表名 "Comment" 必须加引号（SQLite 大小写敏感）
 *
 * ⚠️ 本文件只提供 Drizzle 的**查询元数据**，不是建表语句的来源。
 * 真正的建表 DDL 与启动自迁移在 `src/orm/migrations.ts`（C7）：
 * 改动表结构时必须同时修改那边，否则新库/旧库会与这里的字段定义漂移。
 * 本项目未使用 drizzle-kit 迁移流程（`pnpm db:push` 不是升级手段）。
 */
export const comments = sqliteTable(
  "Comment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pub_date: integer("pub_date").notNull().default(sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`),
    post_slug: text("post_slug").notNull(),
    author: text("author").notNull(),
    email: text("email").notNull(),
    url: text("url"),
    ip_address: text("ip_address"),
    device: text("device"),
    browser: text("browser"),
    os: text("os"),
    user_agent: text("user_agent"),
    content_text: text("content_text").notNull(),
    content_html: text("content_html").notNull(),
    parent_id: integer("parent_id"),
    status: text("status").notNull().default("pending"),
  },
  (table) => ({
    postSlugIdx: index("idx_post_slug").on(table.post_slug),
    statusIdx: index("idx_status").on(table.status),
  })
);

/**
 * Settings 表 — 键值对配置存储
 */
export const settings = sqliteTable("Settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull().default("datetime('now')"),
});

/**
 * EmailVerification 表 — 邮箱验证记录
 */
export const emailVerifications = sqliteTable(
  "EmailVerification",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    token: text("token").notNull().unique(),
    expires_at: text("expires_at").notNull(),
    verified: integer("verified").notNull().default(0),
    post_slug: text("post_slug"),
    post_title: text("post_title"),
    created_at: text("created_at").notNull().default("datetime('now')"),
    verified_at: text("verified_at"),
  },
  (table) => ({
    emailIdx: index("idx_ev_email").on(table.email),
    tokenIdx: index("idx_ev_token").on(table.token),
  })
);
