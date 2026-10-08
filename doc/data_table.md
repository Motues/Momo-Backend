# 数据库设计（SQLite）

## 表：`Comment`

评论主表，存储所有评论数据。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| `pub_date` | TEXT/DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
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

> **状态默认值说明**: Node.js 版本默认值为 `'pending'`；Worker/Go 版本的 SQL schema 默认值为 `'approved'`，应用层会自动覆盖处理。

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
| `comment_verify_difficulty` | 无感验证难度（前导 0 比特数，8-26） |
| `comment_verify_secret` | 无感验证签名密钥，首次启用时自动生成（敏感字段，不对外读写） |
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