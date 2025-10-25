# 📝 轻量博客评论管理系统 — 设计文档

## 系统目标

提供一个轻量、安全、可嵌入任意前端博客（如 Hugo、Hexo、VitePress）的评论后端服务，通过 API 交互。

---

## 技术栈

| 组件 | 选型 |
|------|------|
| 语言 | TypeScript |
| 框架 | koa.js |
| ORM | Prisma |
| 数据库 | SQLite |
| 部署 | Docker + Docker Compose |

---


---

## 部署方案

### 环境变量（`.env`）
```env
DATABASE_URL="postgresql://user:pass@localhost:5432/comments"
ADMIN_TOKEN="your_strong_random_token_here"
RECAPTCHA_SECRET_KEY="..."  # 可选
PORT=3000
```

### Docker Compose 示例
```yaml
version: '3'
services:
  comments-api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://...
      - ADMIN_TOKEN=...
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      POSTGRES_DB: comments
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

---

## 8. 扩展性考虑（未来可选）

- 支持 Webhook 通知（如新评论邮件提醒）
- 集成 Gravatar：前端根据邮箱哈希生成头像 URL
- 支持 Markdown（需严格过滤 HTML 标签）
- 多语言内容过滤

---

## 9. 项目结构建议（TypeScript）

```
comment-api/                     # 项目根目录（建议命名为 comentor 或你的系统名）
├── src/                         # 源代码目录
│   ├── app.ts                   # Koa 应用实例（中间件、错误处理等）
│   ├── server.ts                # 服务启动入口（监听端口）
│   │
│   ├── routes/                  # 路由定义
│   │   ├── index.ts             # 路由聚合（挂载到 app）
│   │   ├── public/              # 公开 API 路由
│   │   │   └── comments.ts      # POST /api/posts/:postId/comments, GET /api/posts/:postId/comments
│   │   └── admin/               # 管理 API 路由
│   │       └── comments.ts      # PATCH /api/comments/:id, DELETE /api/comments/:id, GET /api/comments
│   │
│   ├── controllers/             # 控制器（处理请求逻辑）
│   │   ├── commentController.ts
│   │   └── adminCommentController.ts
│   │
│   ├── services/                # 业务逻辑（与 Prisma 交互）
│   │   └── commentService.ts    # createComment, approveComment, listComments 等
│   │
│   ├── middleware/              # 自定义中间件
│   │   ├── auth.ts              # 管理员认证（Bearer Token）
│   │   ├── validation.ts        # 请求参数验证（可用 Zod）
│   │   └── rateLimit.ts         # 评论提交速率限制
│   │
│   ├── utils/                   # 工具函数
│   │   ├── sanitize.ts          # XSS 转义（如 escapeHtml）
│   │   └── gravatar.ts          # 生成 Gravatar URL（可选）
│   │
│   └── types/                   # 全局 TypeScript 类型（可选）
│       └── index.ts
│
├── prisma/                      # Prisma 相关
│   ├── schema.prisma            # 数据模型定义
│   └── migrations/              # 自动生成的迁移文件
│
├── .env                         # 环境变量（gitignore）
├── .env.example                 # 环境变量模板
├── docker-compose.yml           # 本地开发：启动 PostgreSQL + 应用
├── Dockerfile                   # 构建生产镜像
├── package.json
├── tsconfig.json                # TypeScript 配置
├── nodemon.json                 # 开发热重载（可选）
└── README.md
```