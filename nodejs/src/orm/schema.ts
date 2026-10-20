import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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
 * LinkSyncRequest 表 — 历史链接批量更新的**待确认**记录
 *
 * 评论者提交新网址后，系统发一封确认邮件；只有确认链接被打开、且 token/email 都匹配时，
 * 才会把该邮箱所有历史评论的 url 改成新网址。表结构三端一致（见 doc/link_security.md 第 3.3 节）。
 *
 * ⚠️ 与顶部说明相同：这里只是 Drizzle 的查询元数据，建表语句的唯一来源是
 * `src/orm/migrations.ts` 的 SCHEMA_DDL。
 */
export const linkSyncRequests = sqliteTable(
  "LinkSyncRequest",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 归一化（trim + 小写）后的邮箱：身份凭据 */
    email: text("email").notNull(),
    /** 新网址（已过 sanitizeUrl） */
    new_url: text("new_url").notNull(),
    /** 一次性确认令牌（唯一） */
    token: text("token").notNull().unique(),
    /** 过期时间（ISO 8601 UTC，24 小时） */
    expires_at: text("expires_at").notNull(),
    /** 是否已确认（0/1，单次使用） */
    confirmed: integer("confirmed").notNull().default(0),
    /** 创建时间（ISO 8601 UTC） */
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    emailIdx: index("idx_lsr_email").on(table.email),
    tokenIdx: index("idx_lsr_token").on(table.token),
  })
);

/**
 * TrustedLink 表 — 管理员对「休眠链接」的**人工确认**记录
 *
 * 链接安全审查把「很久没来评论的人留下的个人网址」判为休眠（读取时实时推导，见
 * `doc/link_security.md` 第 2 节）；管理员人工看过某条链接、认为它没问题时写一条本表记录，
 * 该 `(email, url)` 在 `expires_at` 之前不再被判为休眠，到期自动恢复休眠。
 * 有效期 = 确认那一刻的 `link_dormant_days` 天。
 *
 * ⚠️ 与顶部说明相同：这里只是 Drizzle 的查询元数据，建表语句的唯一来源是
 * `src/orm/migrations.ts` 的 SCHEMA_DDL。
 */
export const trustedLinks = sqliteTable(
  "TrustedLink",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 归一化（trim + 小写）后的邮箱 */
    email: text("email").notNull(),
    /** 网址（已过 sanitizeUrl，与评论里的 url 逐字相等才算命中） */
    url: text("url").notNull(),
    /** 人工确认的到期时间（ISO 8601 UTC，形如 2026-11-17T00:00:00.000Z） */
    expires_at: text("expires_at").notNull(),
    /** 本次确认时间（ISO 8601 UTC，刷新确认时会更新） */
    created_at: text("created_at").notNull(),
    /** 确认来源：admin = 管理员在用户列表人工确认；self = 评论者本人从提醒邮件确认 */
    source: text("source").notNull().default("admin"),
  },
  (table) => ({
    emailUrlIdx: uniqueIndex("idx_tl_email_url").on(table.email, table.url),
    emailIdx: index("idx_tl_email").on(table.email),
  })
);

/**
 * DormantNotice 表 — 休眠链接**提醒邮件**的状态机（见 `doc/link_security.md` 第 2.7 节）
 *
 * 本仓库三端都没有定时任务，休眠是「读取公开评论列表时实时推导」的；当某条链接刚进入休眠
 * 且还没提醒过时，读取路径会异步发一封提醒邮件，并在这里落一条记录，保证
 * **同一个休眠周期只提醒一次**（锚点是该邮箱的「最后评论时间」：他再次评论 = 新的周期）。
 *
 * ⚠️ 与顶部说明相同：这里只是 Drizzle 的查询元数据，建表语句的唯一来源是
 * `src/orm/migrations.ts` 的 SCHEMA_DDL。
 */
export const dormantNotices = sqliteTable(
  "DormantNotice",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 归一化（trim + 小写）后的邮箱 */
    email: text("email").notNull(),
    /** 触发休眠的那个网址 */
    url: text("url").notNull(),
    /** 发提醒时该邮箱「最后一条评论」的毫秒时间戳（判断是否同一休眠周期） */
    last_comment_at: integer("last_comment_at").notNull(),
    /** 提醒页令牌（每次发信都会换新的） */
    token: text("token").notNull().unique(),
    /** 提醒页有效期（ISO 8601 UTC）= 发信时刻 + link_dormant_days 天 */
    expires_at: text("expires_at").notNull(),
    /** 本次提醒时间（ISO 8601 UTC） */
    notified_at: text("notified_at").notNull(),
    /** 该 (邮箱, 网址) 累计提醒次数 */
    notify_count: integer("notify_count").notNull().default(1),
  },
  (table) => ({
    emailUrlIdx: uniqueIndex("idx_dn_email_url").on(table.email, table.url),
    tokenIdx: index("idx_dn_token").on(table.token),
    emailIdx: index("idx_dn_email").on(table.email),
  })
);

/**
 * MailLog 表 — **外发邮件日志**（管理面板「邮件管理」页的数据源）
 *
 * 只记「真正尝试发送」的邮件（SMTP 未配置、邮件通知关闭导致的跳过不记）；
 * 发送失败也要记一行并带上错误信息，方便排查「哪封信没发出去」。
 * 默认保留 30 天，写日志时顺手清理过期行。
 *
 * ⚠️ 与顶部说明相同：这里只是 Drizzle 的查询元数据，建表语句的唯一来源是
 * `src/orm/migrations.ts` 的 SCHEMA_DDL。
 */
export const mailLogs = sqliteTable(
  "MailLog",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 邮件类型：verify / link_sync / dormant_notice / comment_notify / reply_notify / test */
    type: text("type").notNull(),
    /** 收件人；多个用 ", " 连接（一次实际发送 = 一行） */
    recipient: text("recipient").notNull(),
    /** 实际发出的主题 */
    subject: text("subject").notNull(),
    /** sent / failed */
    status: text("status").notNull(),
    /** 失败原因（成功时为 NULL） */
    error: text("error"),
    /** 发送时间（ISO 8601 UTC） */
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    createdIdx: index("idx_ml_created").on(table.created_at),
    statusIdx: index("idx_ml_status").on(table.status),
  })
);

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
    /**
     * 归一化后的来源域名（如 `https://blog.example.com`）。
     *
     * 仅在 `comment_verify_domain_enabled` 开启时有值；被域名校验拒绝的请求也会记录
     * （此时它正是「哪个域名在尝试」的线索）。见 doc/data_table.md。
     */
    origin: text("origin"),
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
