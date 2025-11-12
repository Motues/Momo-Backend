# 数据库设计（SQLite）

## 表：`comments`


| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| `pub_date` | TEXT | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| `post_slug` | TEXT | NOT NULL | 博客文章唯一标识（如 `/posts/hello-world`） |
| `author` | TEXT | NOT NULL | 昵称 |
| `email` | TEXT | NOT NULL | 邮箱（用于 Gravatar，不公开） |
| `url` | TEXT | — | 个人网站（可为空） |
| `ip_address` | TEXT | — | 可选：记录 IP 用于反垃圾（需用户同意） |
| `device` | TEXT | — | 评论来源（如 `Windows 10`） |
| `browser` | TEXT | — | 浏览器（如 `Chrome 96.0.4664.110`） |
| `content_text` | TEXT | NOT NULL | 评论内容（纯文本） |
| `content_html` | TEXT | NOT NULL | 评论内容（HTML） |
| `parent_id` | INTEGER | REFERENCES `comments`(`id`) | 回复的父评论 ID（NULL 表示顶级评论） |
| `status` | TEXT | DEFAULT 'pending' | `pending` / `approved` / `rejected` / `deleted` |
