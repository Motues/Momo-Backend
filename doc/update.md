# 更新指南

除非有特殊说明，项目升级升级不对数据库文件进行破坏性修改，数据库可以继续使用。

数据库变化情况可以查看 [数据库更新记录](#数据库更新记录)

## 不同版本升级方式

### Node.js

从 [Relase](https://github.com/Motues/Momo/releases) 下载最新代码，替换原有代码即可，数据库文件无需修改。

**需要更新的文件**包括 `package.json`、`pnpm-lock.yml`、`src`、 `prisma` 和 `public` 文件夹下的所有文件。

升级完成后，请执行 `pnpm install` 安装依赖包。

```bash
pnpm install
pnpm build
pnpm start
```

### Go

从 [Relase](https://github.com/Motues/Momo/releases) 下载最新二进制文件，替换原有二进制即可，数据库文件无需修改。

### Worker

正常情况从 [Relase](https://github.com/Motues/Momo/releases) 下载最新代码，替换原有代码即可。

**需要升级的文件**包括 `package.json`、`pnpm-lock.yml`、`src` 、 `schemas` 和 `public` 文件夹下的所有文件。

升级完成后运行下面的命令推送到 Worker

```bash
pnpm wrangler login
pnpm run deploy
```

如果升级后发现问题，请检查数据库是否添加了新的表。如果添加，请前往 Cloudflare Worker 的 D1 数据库控制台，执行新添加的 SQL 语句。SQL 语句在 `worker/schemas/comment.sql` 文件中。

![D1](./images/D1-console.jpg)

## 数据库更新记录

### `v1.5.1` 版本

**没有人机验证相关的数据库结构变更**：新增的两个设置项写在既有的 `Settings` 表里，首次保存时自动出现，
无需执行任何 SQL。`comment_verify_difficulty` 的旧值会在读取时自动迁移（≤26 视为 v1 的「前导 0 比特数」，
按 `2^值` 换算，上限 2^20），不需要手工改配置。

⚠️ **这是一次破坏性变更**：人机验证协议从 v1 升到 v2，前端组件与后端必须**同时升级**。

- 第一层工作量证明由 SHA-256 换成 HashWX（需要浏览器支持 WebAssembly；**不再有纯 JS 降级路径**）。
- 答案字段由单个 `nonce` 变成 `nonces` 数组，票据版本升到 `v: 2`，已签发的挑战与票据在升级瞬间全部失效（访客刷新页面即可重新验证）。
- 旧前端连新后端会在验证时失败，后端返回 `reason: "PROTOCOL_OUTDATED"`；新前端连旧后端会提示「验证服务版本过旧，请联系博主升级」。
- 引入第三方组件 HashWX（`hashwx.wasm`，**LGPL-3.0**）。分发产物时请保留各端 `vendor/hashwx/` 目录下的许可证文本；详情见 `frontend/THIRD_PARTY_NOTICES.md` 与各端 `vendor/hashwx/README.md`。
- 第一层实现需要用到的构建改动：Node.js 的 `tsconfig.json` 目标提升到 ES2022（BigInt 必需）；Go 端新增 `wazero` 依赖。

协议细节见 [api.md](./api.md) 的「人机验证（无感验证 · 协议 v2）」，升级须知见根目录 README 的「升级到 1.5.1」。

### `v1.3.0` 版本

添加了 `Settings` 表，SQL 语句如下：

```sql
CREATE TABLE IF NOT EXISTS Settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);
```

### `v1.4.0` 版本

#### Node.js 重构

Node.js 后端从 **Koa + Prisma** 迁移至 **Hono + Drizzle ORM**。

Prisma 下 model `Setting`（单数）对应表名 `Setting`，为了与其他版本保持一致，本次重构将表名称改成 `Settings`。

Node.js 版本更新前需要运行迁移脚本，请执行下面的命令

```bash
node scripts/migrate-settings-table.js
```

#### 新增邮箱认证功能

添加了 `EmailVerification` 表，SQL 语句如下：

```sql
CREATE TABLE IF NOT EXISTS EmailVerification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    post_slug TEXT,
    post_title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_email ON EmailVerification(email);
CREATE INDEX IF NOT EXISTS idx_ev_token ON EmailVerification(token);
```