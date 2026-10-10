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

1.5.1 把人机验证从单层 SHA-256 工作量证明换成**两层**方案（注意：**包版本是 1.5.1，而协议版本号是 v2**，两者独立）：

| 层 | 内容 | 说明 |
|---|---|---|
| 第一层 | **HashWX** 工作量证明 | 每次挑战生成一次性函数，GPU 相对 CPU 的吞吐优势从 SHA-256 的约 150 倍降到约 2 倍 |
| 第二层 | **Instrumentation 环境质询** | 服务端下发随机程序，要求浏览器真实执行并回传环境特征；默认关闭 |

**升级须知**：

- 前端组件与后端**必须同时升级**，协议不互通：旧前端连新后端会在验证时失败（后端返回 `reason: "PROTOCOL_OUTDATED"`）；新前端连旧后端会显示「验证服务版本过旧，请联系博主升级」。前端版本对应关系见 [frontend/README.md](./frontend/README.md)。
- 难度设置项的语义从「前导 0 比特数」变为「访客需要完成的哈希计算总次数」。**旧值会自动迁移**（≤26 的值按 `2^值` 换算，上限 2^20），无需手工改配置。
- 第一层需要浏览器支持 WebAssembly（iOS 15+ 及现代桌面浏览器）；**不再提供纯 JS 降级路径**，不支持的浏览器会明确提示「浏览器版本过低，不支持验证」。
- 已签发的挑战与票据在升级瞬间全部失效，访客刷新页面即可重新验证。
- 第二层新增两个设置项（默认关闭）：`comment_verify_instr_enabled`、`comment_verify_block_automated`。建议先只记录日志观察一段时间，确认没有误伤后再考虑开启拦截。
- 分发产物时请保留各端 `vendor/hashwx/` 目录（含 **LGPL-3.0** 许可证全文），它们随 Node / Go / Worker / 前端四处各自保留一份；前端 npm 包另附 `THIRD_PARTY_NOTICES.md`。
- **三端（Node.js / Go / Cloudflare Worker）与前端组件都已同步到协议 v2**。Go 端为此新增了 `wazero` 依赖（纯 Go 的 WebAssembly 运行时，不影响 `CGO_ENABLED=0` 构建）；Worker 端因 workerd 禁止运行时编译 WASM，改为由 wrangler 静态导入 `.wasm`。
- 跨语言口径由共享固定向量保证：Node / Go / Worker / 前端的测试都读取 `doc/vectors/` 下的同一份文件并各自复算，详见 [doc/vectors/README.md](./doc/vectors/README.md)。
- 协议细节（派生公式、操作码表、环境判定规则、报文示例、v1/v2 对照）见 [doc/api.md](./doc/api.md) 的「人机验证（无感验证 · 协议 v2）」。

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