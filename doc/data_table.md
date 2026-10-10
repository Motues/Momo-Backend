# 数据库设计（SQLite）

## 表：`Comment`

评论主表，存储所有评论数据。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| `pub_date` | INTEGER | NOT NULL DEFAULT `(CAST(strftime('%s','now') AS INTEGER) * 1000)` | 创建时间（**Unix 毫秒整数**，三端统一） |
| `post_slug` | TEXT | NOT NULL | 博客文章唯一标识（如 `/posts/hello-world`） |
| `author` | TEXT | NOT NULL | 昵称 |
| `email` | TEXT | NOT NULL | 邮箱（用于 Gravatar，不公开） |
| `url` | TEXT | — | 个人网站（可为空） |
| `ip_address` | TEXT | — | 记录 IP 用于反垃圾 |
| `device` | TEXT | — | 设备信息（如 `Windows 10`） |
| `os` | TEXT | — | 操作系统 |
| `browser` | TEXT | — | 浏览器（如 `Chrome 96.0.4664.110`） |
| `user_agent` | TEXT | — | 原始 User-Agent |
| `content_text` | TEXT | NOT NULL | 评论内容（纯文本） |
| `content_html` | TEXT | NOT NULL | 评论内容（HTML） |
| `parent_id` | INTEGER | REFERENCES `Comment`(`id`) ON DELETE SET NULL | 回复的父评论 ID（NULL 表示顶级评论） |
| `status` | TEXT | DEFAULT 'pending' | `pending` / `approved` / `rejected` / `deleted` |

> **状态默认值说明**: 三端已统一为 `'pending'`（最安全的默认值）。已有数据库的列默认值需要重建表才能生效，
> 见 `doc/migrations/0002_status_default_pending.sql`；应用层写入时都会显式带上 `status`，不受影响。
>
> **时间字段说明**: `pub_date` 统一存储为 Unix **毫秒**整数（如 `1712345678901`），
> API 响应中的 `pubDate` 始终是 ISO 8601 UTC 字符串（如 `2024-03-05T06:07:08.000Z`）。
> 三端启动时会自动把历史 ISO 字符串归一化为毫秒整数（见 `doc/migrations/README.md`）。

### 索引

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_post_slug` | `post_slug` | 加速按文章查询评论 |
| `idx_status` | `status` | 加速按状态筛选评论 |

### 外键约束

- `parent_id` 引用自身 `id`，`ON DELETE SET NULL`——父评论被删除时，子评论的 `parent_id` 置为 NULL，变为顶级评论。

---

## 表：`Settings`

系统配置键值对存储表。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `key` | TEXT | PRIMARY KEY | 设置项名称 |
| `value` | TEXT | NOT NULL | 设置值 |
| `updated_at` | TEXT/DATETIME | NOT NULL DEFAULT `datetime('now')` | 最后更新时间 |

### 常用设置项

| key | 说明 |
|-----|------|
| `site_name` | 站点名称 |
| `admin_email` | 管理员邮箱 |
| `admin_name` | 管理员用户名 |
| `admin_password` | 管理员密码（bcrypt 哈希） |
| `smtp_host` | SMTP 服务器地址 |
| `smtp_port` | SMTP 端口 |
| `email_user` | 邮箱用户名 |
| `email_password` | 邮箱密码 |
| `email_secure` | 是否使用 SSL/TLS 加密 |
| `email_enabled` | 是否启用邮件通知 |
| `reply_template` | 回复通知邮件模板 |
| `notification_template` | 新评论通知邮件模板 |
| `comment_auto_approve` | 是否自动审核通过 |
| `comment_spam_keywords` | 审核自动化的敏感关键词（JSON 数组，不区分大小写，命中正文/昵称/网址即判为垃圾；默认不启用） |
| `comment_spam_max_links` | 链接数上限（默认 `0` = 不限制，建议 `3`）：正文链接 + 个人网址字段超过即判为垃圾 |
| `comment_spam_min_length` | 正文最少字符数（默认 `0` = 不限制，建议 `5`），单位是 **Unicode 码点** |
| `comment_spam_duplicate_window` | 重复内容检测时间窗（分钟，默认 `0` = 关闭，建议 `10`）：同一 IP 在窗口内提交完全相同正文即判为垃圾 |
| `allow_origin` | 允许的跨域来源 |
| `ip_blacklist` | IP 黑名单（JSON 数组） |
| `email_blacklist` | 邮箱黑名单（JSON 数组） |
| `blogger_badge_enabled` | 是否启用博主标识 |
| `blogger_badge_text` | 博主标识标签文字 |
| `placeholder_name` | 昵称输入框占位文字 |
| `placeholder_email` | 邮箱输入框占位文字 |
| `placeholder_content` | 评论内容输入框占位文字 |
| `placeholder_url` | 网址输入框占位文字 |
| `admin_comment_key` | 管理员评论密钥（敏感字段） |
| `admin_comment_key_enabled` | 是否启用管理员评论密钥 |
| `comment_verify_enabled` | 是否启用评论无感验证（人机验证），默认关闭 |
| `comment_verify_difficulty` | 无感验证强度：**访客需要完成的哈希计算总次数**（协议 v2 语义，有效范围 1000–1000000000，默认 1000000）。会按 4 个子挑战均分。**兼容 v1 旧值**：≤26 的值按 `2^值` 迁移（视为旧的「前导 0 比特数」，上限 2^20）；`"0"`／负数／非数字退回默认强度 |
| `comment_verify_secret` | 无感验证签名密钥，首次启用时自动生成（敏感字段，不对外读写） |
| `comment_verify_instr_enabled` | 是否启用第二层环境质询（Instrumentation），默认关闭。开启后挑战会下发一段随机程序，要求访客浏览器真实执行并回传环境特征 |
| `comment_verify_block_automated` | 第二层命中自动化特征（webdriver、HeadlessChrome、无布局引擎等）时是否直接拒绝，默认关闭（只写日志、不拦截） |
| `comment_verify_retention_days` | 认证记录（`VerifyRecord`）保留天数，默认 `30`；`0` 或负数表示永久保留，上限 3650。超期记录由三端的惰性清理自动删除 |
| `comment_verify_log_challenge` | 是否记录「签发挑战」事件（`VerifyRecord.event = 'challenge'`），默认记录（非 `"false"` 即记录）。关闭后只记录通过/失败，可显著降低写入量 |
| `password_changed` | 是否已修改默认密码 |

---

## 表：`EmailVerification`

邮箱验证记录表，用于评论前邮箱验证流程。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| `email` | TEXT | NOT NULL | 待验证的邮箱地址 |
| `token` | TEXT | NOT NULL UNIQUE | 验证令牌（唯一） |
| `expires_at` | TEXT | NOT NULL | 令牌过期时间 |
| `verified` | INTEGER | NOT NULL DEFAULT 0 | 是否已验证（0=未验证，1=已验证） |
| `post_slug` | TEXT | — | 关联的文章标识（可选） |
| `post_title` | TEXT | — | 关联的文章标题（可选） |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | 创建时间 |
| `verified_at` | TEXT | — | 验证通过时间 |

### 索引

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_ev_email` | `email` | 加速按邮箱查询验证记录 |
| `idx_ev_token` | `token` | 加速按令牌查询验证记录 |

---

## 表：`VerifyRecord`

评论无感验证（人机验证）的**认证记录**。一次完整认证最多产生三条记录：
`challenge`（签发挑战）、`pass` 或 `fail`（答案校验结果），三者通过 `challenge_id` 串联。

写入是**尽力而为**的：记录失败只写日志，绝不影响验证结果本身；
验证功能关闭（`comment_verify_enabled != "true"`）时不产生任何记录。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| `created_at` | INTEGER | NOT NULL | 事件时间（**Unix 毫秒整数**，与 `Comment.pub_date` 口径一致） |
| `event` | TEXT | NOT NULL | `challenge` 签发 / `pass` 校验通过 / `fail` 校验失败 |
| `reason` | TEXT | — | 失败原因（`honeypot` / `bad signature` / `ip mismatch` / `challenge already used` / `PROTOCOL_OUTDATED` 等），非失败事件为 NULL |
| `elapsed_ms` | INTEGER | — | 客户端上报的求解耗时（仅 `pass` / `fail` 有） |
| `difficulty` | INTEGER | — | 本次生效的**总期望哈希次数**（不是响应里 `pow.d` 的单子挑战难度） |
| `challenge_id` | TEXT | — | 挑战 cid；签名校验或载荷解析就失败时为 NULL（此时无法安全取出 cid） |
| `post_slug` | TEXT | — | 关联的文章标识 |
| `ip_address` | TEXT | — | 访客完整 IP（仅管理后台可见，按保留天数自动清理） |
| `country` | TEXT | — | **仅 Cloudflare Worker 部署有值**（`cf.country`，ISO 二字码） |
| `network` | TEXT | — | **仅 Cloudflare Worker 部署有值**（`cf.asOrganization`，运营商名称） |
| `asn` | INTEGER | — | **仅 Cloudflare Worker 部署有值**（`cf.asn`） |

### 索引

| 索引名 | 字段 | 说明 |
|--------|------|------|
| `idx_vr_created` | `created_at` | 时间窗口统计与过期清理 |
| `idx_vr_event` | `event` | 按事件类型筛选/计数 |
| `idx_vr_cid` | `challenge_id` | 串联同一次认证的签发与结果 |

> **建表方式（三端一致）**: Node 见 `nodejs/src/orm/migrations.ts` 的 `SCHEMA_DDL`，
> Go 见 `go/internal/repository/sqlite/comment.go` 的 `InitSchema`，
> Worker 见 `worker/schemas/comment.sql` 与启动自迁移 `0002_verify_record_table`
> （`worker/src/utils/migrations.ts`）。三者都是 `CREATE TABLE IF NOT EXISTS`，
> 已有部署重启（Node/Go）或下次请求（Worker）即自动补表。

### 统计口径

统计接口（`/admin/verify/overview`）的口径，三端逐条一致：

- **分桶**：`days = 1` 按小时、`days = 0`（全部）按月（最近 12 个月）、其余按天；分桶与键统一使用 **UTC**；
- **通过率** `passRate` = `pass / (pass + fail)`：签发了但没提交答案不应拉低通过率；
- **平均耗时**只统计 `pass` 事件的 `elapsed_ms`；
- **环比 `*Delta`** 与**紧邻的上一个等长窗口**比较，上一窗口为空时返回 `null`（而不是 0/100%）；
- **Top 榜单一律按窗口内全部事件计数**（含签发），`percent` 为占窗口内总事件数的百分比。

---

## 表：`SchemaMigration`

三端启动自迁移的执行记录表（幂等：同一条迁移只执行一次）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PRIMARY KEY | 迁移标识（如 `0001_pub_date_to_millis`），发布后不可修改 |
| `description` | TEXT | NOT NULL DEFAULT '' | 迁移说明 |
| `applied_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | 执行时间 |

> 迁移定义位于 `nodejs/src/orm/migrations.ts`、`worker/src/utils/migrations.ts`、
> `go/internal/repository/sqlite/migrate.go`；需要重建表的结构变更见 `doc/migrations/`。