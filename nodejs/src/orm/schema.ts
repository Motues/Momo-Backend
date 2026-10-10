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
 * VerifyRecord 表 — 评论无感验证（人机验证）的认证记录
 *
 * 每次认证最多产生三条记录：`challenge`（签发挑战）、`pass` / `fail`（答案校验结果），
 * 三者通过 `challenge_id` 串联。表结构在三端完全一致（见 doc/data_table.md）。
 *
 * ⚠️ 与 schema.ts 顶部的说明相同：这里只是 Drizzle 的查询元数据，
 * 建表语句的唯一来源是 `src/orm/migrations.ts` 的 SCHEMA_DDL。
 */
export const verifyRecords = sqliteTable(
  "VerifyRecord",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 事件时间（Unix 毫秒整数，与 Comment.pub_date 口径一致） */
    created_at: integer("created_at").notNull(),
    /** challenge = 签发挑战；pass = 校验通过；fail = 校验失败 */
    event: text("event").notNull(),
    /** 失败原因（如 bad signature / ip mismatch），非失败事件为 NULL */
    reason: text("reason"),
    /** 客户端上报的求解耗时（仅 pass / fail 有） */
    elapsed_ms: integer("elapsed_ms"),
    /** 本次生效的总期望哈希次数 */
    difficulty: integer("difficulty"),
    /** 挑战 cid；签名校验或载荷解析就失败时可能为 NULL（此时无法安全取出 cid） */
    challenge_id: text("challenge_id"),
    post_slug: text("post_slug"),
    ip_address: text("ip_address"),
    /** 以下三列仅 Cloudflare Worker 部署有值（cf.country / cf.asOrganization / cf.asn） */
    country: text("country"),
    network: text("network"),
    asn: integer("asn"),
  },
  (table) => ({
    createdIdx: index("idx_vr_created").on(table.created_at),
    eventIdx: index("idx_vr_event").on(table.event),
    cidIdx: index("idx_vr_cid").on(table.challenge_id),
  })
);

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
