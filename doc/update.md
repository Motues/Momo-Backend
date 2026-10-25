# 更新指南

除非有特殊说明，项目升级升级不对数据库文件进行破坏性修改，数据库可以继续使用。

数据库变化情况可以查看 [数据库更新记录](#数据库更新记录)

## 面板内的更新提示

管理面板侧边栏底部的版本号会定期检查新版本。发现新版本后，版本号旁会出现 🎉，
点击版本号或「发现新版本」会弹出升级指南：

- 按**当前版本**列出升级过程中跨过的数据库变更（版本阈值与本文的「数据库更新记录」一致）；
- 自动读取后端 `GET /health` 的 `runtime` / `container` / `os` / `arch`，识别当前是
  Node.js、Go、Cloudflare Worker 还是 Docker，只展示这一种部署方式的升级步骤；
- 步骤里写明需要下载的 Release 包、需要替换的文件 / 文件夹，以及要保留的配置文件
  （如 Worker 的 `wrangler.jsonc`、Go 的 `config/config.yaml`、Node.js 的 `.env`、Docker 的 `data` 卷）；
- 提供「查看 Release 页面」链接，直接跳到对应的 GitHub Release，方便下载升级包。

如果后端版本较旧、`/health` 还没有运行时字段，浮窗会给出兜底的手动选择（选择结果会记住）。

指南只做展示，不会自动执行升级，也不会读取或上传数据库内容。

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

### `v1.8.3` 版本

**无数据库变更、无新增设置键**，升级无需执行 SQL。

管理面板：

- 邮件模板支持**预览**：用演示数据在面板里直接渲染（`sandbox` iframe，可切桌面 / 手机宽度），
  占位符与转义规则与真实发信完全一致；模板留空时预览内置默认模板，预览不落库、不发信；
- 新增**更新中心**：侧边栏版本号发现新版本后弹出升级指南，按 `GET /health` 的运行时字段
  自动识别 Node.js / Go / Cloudflare Worker / Docker，只展示对应部署方式的升级步骤；
- 系统设置导出改为**完整生效快照**：47 个可写设置键全部导出，从没保存过的按生效默认值补全
  （例如表情开关与表情来源），敏感字段仍置空；导入仍只写文件里出现的键；
- 「发送测试邮件」按钮不再被右侧长说明压窄换行。

评论组件（`@motues/momo-comment` 1.8.3）：

- 无感验证「验证成功」的绿色跟随主题：浅色用深绿、深色用亮绿，宿主可用
  `--momo-verify-success-color` / `--momo-verify-success-border-color` 覆盖；没有 `data-theme`
  的页面跟随系统深色，`data-theme="light"` 可锁定浅色；
- 表情加载改为 **stale-while-revalidate**：7 天可用期之外另加 6 小时校验，来源内容变化时
  已显示的表情也会换图；表情面板新增常驻「刷新表情」按钮，可绕过缓存强制拉取。

后端（Node.js / Go / Cloudflare Worker）：

- `GET /health` 增加 `runtime` / `container` / `os` / `arch`（数据库不可用的 503 也带），
  供管理面板自动识别部署方式；
- 设置导出为完整快照（见上），三端口径一致，由 `doc/vectors/settings-export-v1.json` 钉死；
- Release 包不再分发 `worker/wrangler.jsonc`，改为示例配置 `wrangler.example.jsonc`，
  并排除 `wrangler.e2e.jsonc` 与本地 `.env` / `.dev.vars*`。

升级方式：按上面各端的常规升级步骤替换文件 / 二进制即可，数据库与设置无需变更。
npm 发布的评论组件版本为 `1.8.3`，升级后按需替换 CDN 引用。

### `v1.8.2` 版本

**无数据库变更、无新增设置键**，升级无需执行 SQL；Docker 镜像新增健康检查。

管理面板：

- 评论管理新增「来源文章」列，点击文章标识即可按该文章筛选（地址栏保留 `?slug=`，可清除）；
- 用户列表整行可点击进入「用户详情」：新增用户概要卡片（邮箱验证 / 拉黑状态 / 网站链接状态 /
  评论统计），下方仍是该用户全部评论；
- 评论管理支持批量审核：勾选 / 全选后批量通过、打回待审、删除；部分失败时只保留失败项的勾选，
  `deleted` / `pending` 仍按既有的级联语义连同子孙回复一起修改。

评论组件（`@motues/momo-comment` 1.8.2）：

- 表情面板改为挂载到 `body` 并用 `position: fixed` 定位：不再被二级评论的 `overflow-hidden`
  裁掉，窄屏自动夹在视口内，软键盘弹出时翻到按钮上方；移动端选中表情后自动收起；
- 表情小图与文字垂直居中（宿主可用 `--momo-emoji-align` 微调）；
- 含 `:name:` 短代码的评论会在首屏渲染后的空闲时段自动预取 owo.json 并水合，**不再需要先打开
  表情面板**；页面里没有短代码时仍不发任何第三方表情请求。

后端（Node.js / Go / Cloudflare Worker）：

- 新增公开的 `GET /health`：数据库可用返回 `200`，不可用返回 `503`（三端响应结构一致）；
- Go 镜像内置 `HEALTHCHECK`，`docker-compose.yml` 增加 `healthcheck`，`docker compose ps`
  可以看到 `healthy` 状态。

升级方式：按上面各端的常规升级步骤替换文件 / 二进制即可，数据库与设置无需变更。
npm 发布的评论组件版本为 `1.8.2`，升级后按需替换 CDN 引用。

### `v1.8.1` 版本

**无数据库变更、无新增设置键**，升级后：

- API 地址（`verify_base_url`）从「邮件通知 → 邮箱验证」移到「基本设置 → 站点信息」，成为站点
  基础信息的一部分；邮箱验证开关移到「基本设置 → 评论审核」。
- 邮箱验证、历史链接同步、休眠提醒都要求 API 地址非空：地址为空时，`PUT /admin/settings`
  与设置导入会拒绝开启对应功能（`400`）；历史链接同步 / 休眠提醒在运行时也不再依赖
  `email_verify_enabled`，**API 地址为空时不会发信**。
- 升级后如果「链接同步 / 休眠提醒」开着但 API 地址为空：运行时停止发信，面板显示警告；
  补填 API 地址（或先关闭对应开关）即可恢复。邮箱验证的旧配置仍保留 Origin/Host 兜底。
- 三端设置分组：`type=basic` 新增 `verify_base_url` / `email_verify_enabled`；
  `type=email` 继续下发这两个键以兼容旧面板。

### `v1.8.0` 版本

**数据库变更**：新增四张表，并给 `TrustedLink` 增加 `source` 列。字段与语义见
[data_table.md](./data_table.md)，链接安全相关口径见 [link_security.md](./link_security.md)。

| 表 | 用途 |
|---|---|
| `LinkSyncRequest` | 历史链接批量更新的待确认记录（token 一次性、24 小时有效） |
| `TrustedLink` | 休眠链接的确认放行记录（`source` 区分 `admin` / `self`，到期后自动恢复休眠） |
| `DormantNotice` | 休眠提醒邮件的状态机（同一休眠周期只提醒一次，承载提醒页令牌） |
| `MailLog` | 外发邮件日志，面板「邮件管理」的数据源 |

新库由建表 DDL 一次建出（`TrustedLink` 已包含 `source` 列）；旧库执行下面这段即可，
全部是 `CREATE ... IF NOT EXISTS`：

```sql
-- 历史链接批量更新：email 为归一化（trim + 小写）后的身份凭据
CREATE TABLE IF NOT EXISTS LinkSyncRequest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    new_url TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,              -- ISO 8601 UTC，24 小时
    confirmed INTEGER NOT NULL DEFAULT 0,  -- 0/1，单次使用
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lsr_email ON LinkSyncRequest(email);
CREATE INDEX IF NOT EXISTS idx_lsr_token ON LinkSyncRequest(token);

-- 休眠链接的确认放行（有效期 = 确认时的 link_dormant_days 天）
CREATE TABLE IF NOT EXISTS TrustedLink (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    url TEXT NOT NULL,                     -- 已过 sanitizeUrl，与评论 url 逐字相等才算命中
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'admin'   -- admin = 管理员确认；self = 本人从提醒页确认
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tl_email_url ON TrustedLink(email, url);
CREATE INDEX IF NOT EXISTS idx_tl_email ON TrustedLink(email);

-- 休眠提醒邮件的状态机：同一 (email, url) 只留一行，重复提醒刷新 token 并累加 notify_count
CREATE TABLE IF NOT EXISTS DormantNotice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    url TEXT NOT NULL,
    last_comment_at INTEGER NOT NULL,      -- 锚点：该邮箱最后一条评论的毫秒时间戳
    token TEXT NOT NULL UNIQUE,            -- 提醒页令牌，确认 / 换链接后即失效
    expires_at TEXT NOT NULL,
    notified_at TEXT NOT NULL,
    notify_count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dn_email_url ON DormantNotice(email, url);
CREATE INDEX IF NOT EXISTS idx_dn_token ON DormantNotice(token);
CREATE INDEX IF NOT EXISTS idx_dn_email ON DormantNotice(email);

-- 外发邮件日志：只记真正尝试过的发送，默认保留 30 天
CREATE TABLE IF NOT EXISTS MailLog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                    -- verify / link_sync / dormant_notice / comment_notify / reply_notify / test
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,                  -- sent / failed
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ml_created ON MailLog(created_at);
CREATE INDEX IF NOT EXISTS idx_ml_status ON MailLog(status);
```

**升级方式**：

| 版本 | 做法 |
|---|---|
| Node.js | 替换代码并重启，启动自迁移自动补表 / 补列 |
| Go | 同上，替换二进制后重启 |
| Worker | 部署后**下一次请求**触发自迁移；也可以把上面的 SQL 粘到 D1 控制台手工执行（同样内容也在 `worker/schemas/comment.sql` 里） |

> 若库里已存在 1.8.0 开发期间建的 `TrustedLink`（没有 `source` 列），补一句
> `ALTER TABLE TrustedLink ADD COLUMN source TEXT NOT NULL DEFAULT 'admin';` 即可。
>
> 全部改动都是纯新增，**不升级也不会坏**：缺 `MailLog` 只是面板「邮件管理」没有数据，
> 缺 `DormantNotice` 只是不发休眠提醒邮件，休眠判定本身不变。

**新增设置键（无需 SQL）**：`link_dormant_notice_enabled`（默认 `"false"`，链接刚进入休眠时是否
发提醒邮件，仍依赖 `email_verify_enabled`，邮箱验证未开启时不发信）与 `mail_log_retention_days`
（默认 `"30"`，邮件日志保留天数，`0` = 永久，上限 3650）。两者都由「系统设置」首次保存时写入，
旧库读不到即按默认值处理 —— 升级**不会**突然开始给历史评论者发休眠提醒邮件，日志保留天数也与
旧版本一致。

### `v1.6.1` 版本

**数据库变更**：`VerifyRecord` 表新增一列 `origin`（来源域名绑定记录，也是管理面板「认证记录」页新增的「来源域名」列的数据来源）；其余改动只写进既有的 `Settings` 表（首次保存时自动出现），无需执行任何 SQL。

```sql
-- 来源域名绑定：记录本次认证（含被拒的请求）来自哪个域名
-- 新库由建表 DDL 直接带上该列，旧库执行下面这一句即可
ALTER TABLE "VerifyRecord" ADD COLUMN "origin" TEXT;
```

字段与语义的完整说明见 [data_table.md](./data_table.md)。

**升级方式**：

| 版本 | 做法 |
|---|---|
| Node.js | 替换代码并重启：启动自迁移 `0002_verify_record_origin` 会自动补列（新库已由建表 DDL 带上该列，迁移会按「已应用」跳过） |
| Go | 同上，替换二进制后重启 |
| Worker | 已部署的 D1 由启动自迁移自动补列；也可以按上面的 SQL 在 D1 控制台手工执行 |

> 该列会记录来源域名（**被域名校验拒绝的请求同样记录**），便于在「认证记录」页发现谁在尝试中转。
> 与 IP 一样受 `comment_verify_retention_days` 的保留天数约束。

### `v1.6.0` 版本

**数据库变更**：新增一张表 `VerifyRecord`（评论无感验证的认证记录，也是管理面板侧边栏「认证记录」页的数据来源）；人机验证的其余改动都只写进既有的 `Settings` 表（首次保存时自动出现），无需执行任何 SQL。

```sql
-- 评论无感验证（人机验证）的认证记录：一次认证最多三条（challenge / pass / fail），用 challenge_id 串联
CREATE TABLE IF NOT EXISTS VerifyRecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,   -- 事件时间，Unix 毫秒整数
    event TEXT NOT NULL,           -- challenge 签发 / pass 通过 / fail 失败
    reason TEXT,                   -- 失败原因，其余为 NULL
    elapsed_ms INTEGER,            -- 客户端上报的求解耗时
    difficulty INTEGER,            -- 本次生效的总期望哈希次数
    challenge_id TEXT,             -- 挑战 cid，串联同一次认证
    post_slug TEXT,
    ip_address TEXT,
    country TEXT,                  -- 仅 Cloudflare Worker 部署有值
    network TEXT,                  -- 仅 Cloudflare Worker 部署有值
    asn INTEGER                    -- 仅 Cloudflare Worker 部署有值
);
CREATE INDEX IF NOT EXISTS idx_vr_created ON VerifyRecord(created_at);
CREATE INDEX IF NOT EXISTS idx_vr_event ON VerifyRecord(event);
CREATE INDEX IF NOT EXISTS idx_vr_cid ON VerifyRecord(challenge_id);
```

字段与统计口径的完整说明见 [data_table.md](./data_table.md)；`comment_verify_difficulty` 的旧值会在读取时
自动迁移（≤26 视为 v1 的「前导 0 比特数」，按 `2^值` 换算，上限 2^20），不需要手工改配置。

**升级方式**：

| 版本 | 做法 |
|---|---|
| Node.js | 替换代码并重启即可：建表语句在启动时以 `CREATE TABLE IF NOT EXISTS` 执行，数据库无需手工修改 |
| Go | 同上，替换二进制后重启 |
| Worker | 已部署的 D1 由启动自迁移 `0002_verify_record_table` 自动补表；也可以按上面的 SQL 在 D1 控制台手工执行 |

> 该表会记录访客 IP（仅管理后台可见）。默认保留 **30 天**，超期记录由三端自动清理；
> 在「系统设置 → 安全设置 → 人机验证」里可以调整保留天数（`0` = 永久保留）或关闭「记录签发事件」
> 来降低写入量。未开启无感验证（`comment_verify_enabled`）时不会产生任何记录。

1.6.0 把人机验证从单层 SHA-256 工作量证明换成**两层**方案（注意：**包版本是 1.6.0，而协议版本号是 v2**，两者独立）：

| 层 | 内容 | 说明 |
|---|---|---|
| 第一层 | **HashWX** 工作量证明 | 每次挑战生成一次性函数，GPU 相对 CPU 的吞吐优势从 SHA-256 的约 150 倍降到约 2 倍 |
| 第二层 | **Instrumentation 环境质询** | 服务端下发随机程序，要求浏览器真实执行并回传环境特征；默认关闭 |


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