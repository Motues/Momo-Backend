# 一次性迁移脚本

这里存放**需要重建表/改列定义**的一次性 SQL 脚本。这类变更无法由三端启动时的自迁移安全完成
（自迁移只做数据归一化与加索引，见 `worker/src/utils/migrations.ts`、
`nodejs/src/orm/migrations.ts`、`go/internal/repository/sqlite/migrate.go`），
因此请在升级前**手工执行**。

执行方式（三端通用，按部署形态选择其一）：

```bash
# Node.js（better-sqlite3 库文件，默认 data/dev.db）
sqlite3 data/dev.db < doc/migrations/0002_status_default_pending.sql

# Go（配置文件里的 sqlite 路径）
sqlite3 /path/to/momo.db < doc/migrations/0002_status_default_pending.sql

# Cloudflare Worker（D1）
npx wrangler d1 execute <DATABASE_NAME> --remote --file=doc/migrations/0002_status_default_pending.sql
```

> 执行前请先备份数据库文件（D1 请用 `wrangler d1 export`）。

## 关于列亲和性（SQLite affinity）

`0001` 把 `pub_date` 的值改成整数，但**列本身的亲和性由建表语句决定**：

| 建表时的声明 | 亲和性 | 归一化后 `typeof(pub_date)` |
|---|---|---|
| `pub_date INTEGER`（Node/Go 现状） | INTEGER | `integer` |
| `pub_date DATETIME`（旧版 Worker / Prisma 历史结构） | NUMERIC | `integer` |
| `pub_date TEXT` | TEXT | `text`（值变成 `'1709618828000'` 这样的数字字符串） |

只有 `TEXT` 声明才会残留字符串形态；此时建议执行 `0002` 重建表（新表用 `pub_date INTEGER`）彻底修正。
三端读取端都已兼容数字字符串（Node/Worker 见各自的 `toMillis`，Go 由 `database/sql` 转换），
因此即使不重建也不会出现 1970 日期。

| 脚本 | 解决的问题 | 是否必须 |
|---|---|---|
| `0001_pub_date_to_millis.sql` | 历史库中 `pub_date` 为 ISO 字符串，与毫秒整数混存 | 仅当你的库是「旧版 Worker 写入的」时才需要（三端自迁移已覆盖，此文件是手工等价物） |
| `0002_status_default_pending.sql` | `status` 列默认值为 `approved`，与 Node/Go 的 `pending` 不一致（C11）；同时把 `pub_date` 规整为 `INTEGER` 声明 | 可选：默认值只影响「绕过应用层直接 INSERT 且不写 status」的场景 |
